// functions/receive-sms.js
// Receives bank/wallet SMS forwarded from the admin's Android device (CBE,
// CBE Birr, Telebirr) and matches it against a pending payment PURELY by
// sender name + exact amount — the same matching rule for every payment
// method. Transaction IDs are never extracted from or matched against SMS
// here; they play no role in this flow at all.
//
// Once matched, the amount is checked against the CHOSEN CT pack on that
// pending record (the user picks a pack before paying; see lib/packs.js):
//   - If the amount covers the chosen pack's price, that pack's CT are added
//     to the user's balance — never a different pack than the one chosen.
//     Any excess above the pack price is flagged as refund-eligible (Refund
//     or Leave as Tip).
//   - If the amount does NOT cover the chosen pack (including anything under
//     the cheapest pack), this function does NOTHING further — it leaves the
//     payment pending. The automatic system never rejects a payment; only an
//     admin can do that, since "amount too low" and "this looks like a scam"
//     are indistinguishable from amount alone.
//
// The SMS text itself is read by DeepSeek (plain text — no file involved).
//
// ── FIX (revenue model) ──────────────────────────────────────────────────
// This is the automatic counterpart to admin-verify.js's verify-one, but it
// was never updated when the pending-revenue model was introduced: it
// wrote the payments doc (tierPrice + excess) correctly, but NEVER created
// the matching `pending_revenue` entry for the excess. That meant:
//   - Any excess from an SMS-auto-verified payment was invisible to the
//     Pending Revenue box on the dashboard — it just didn't exist anywhere.
//   - Tipping or refunding that excess would always fail ("couldn't find
//     or already resolved"), because tip-payment.js / manage-refunds.js
//     look up a pending_revenue doc that was never created in the first
//     place.
// Fixed below by creating the pending_revenue entry exactly like
// admin-verify.js does, tied to the same notification id that's shown to
// the user (so Tip/Refund can find it).

const { callDeepSeek, parseJsonLoose } = require('./lib/ai-billing');
const { computeVerifyOutcome, creditTokens } = require('./lib/packs');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Allowed bank senders ──────────────────────────────────────────────────────
const ALLOWED_SENDERS = [
    'cbe', '8397', 'cbeethi',
    'cbebirr', 'cbe birr', '7809',
    'telebirr', '7978', '9999'
];

function isBankSender(sender) {
    if (!sender) return false;
    const lower = sender.toLowerCase();
    return ALLOWED_SENDERS.some(s => lower.includes(s));
}

// ── Name matching ──────────────────────────────────────────────────────────────
// Names on SMS vs. a user's screenshot are rarely byte-identical (different
// casing, middle names, extra spaces), so match on token overlap rather than
// exact equality.
function normalizeNameTokens(name) {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(Boolean);
}

// Returns a 0–1 score: fraction of the shorter name's tokens found in the longer.
function nameSimilarity(a, b) {
    const tokensA = normalizeNameTokens(a);
    const tokensB = normalizeNameTokens(b);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    const setB = new Set(tokensB);
    const overlap = tokensA.filter(t => setB.has(t)).length;
    const smaller = Math.min(tokensA.length, tokensB.length);
    return overlap / smaller;
}

const NAME_MATCH_THRESHOLD = 0.5; // at least half the shorter name's tokens must match

// ── DeepSeek extraction — amount + sender name only, no transaction ID ──────
async function extractSmsFields(smsText) {
    const prompt = `You are a payment SMS parser for Ethiopian banks/wallets (CBE, CBE Birr, Telebirr).
Extract the following from this SMS:
- amount: the money transferred in ETB (Birr), as a plain number.
- senderName: the full name of the person who sent/transferred the money, if the SMS mentions it.

Reply ONLY with valid JSON, no explanation, no markdown.
Format: {"amount": 500, "senderName": "Abebe Kebede"}
Use null for any field you cannot find.

SMS:
${smsText}`;

    const result = await callDeepSeek({
        messages: [
            { role: 'system', content: 'You extract fields from bank SMS messages. You reply with valid JSON only.' },
            { role: 'user',   content: prompt }
        ],
        maxTokens: 100,
        temperature: 0,
        json: true,
        timeoutMs: 15000,
        attempts: 2
    });
    return parseJsonLoose(result.text);
}

// ── Write notification to user document ──────────────────────────────────────
// notification.id can be supplied by the caller (so it can be pre-linked to
// a pending_revenue entry created in the same request); otherwise a fresh
// one is generated here, same as before.
async function writeNotification(usersCol, userId, notification) {
    try {
        await usersCol.updateOne(
            { phoneNumber: userId },
            { $push: { notifications: { read: false, ...notification, id: notification.id || crypto.randomUUID(), createdAt: new Date() } } }
        );
    } catch (e) {
        console.error('writeNotification error:', e.message);
    }
}

// ── Verify a pending payment: credit exactly the pack it was submitted for ──
async function verifyPendingPayment(db, pending) {
    const usersCol          = db.collection('users');
    const verifiedCol       = db.collection('payments');
    const pendingCol        = db.collection('pending_payments');
    const pendingRevenueCol = db.collection('pending_revenue');

    const outcome = computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount);
    if (!outcome.canVerify) return { status: 'insufficient' };

    const pack = outcome.pack;
    await creditTokens(usersCol, pending.userId, pack.tokens);

    const insertResult = await verifiedCol.insertOne({
        userId:        pending.userId,
        amount:        pending.claimedAmount,
        senderName:    pending.claimedSenderName,
        plan:          pack.id,
        tokens:        pack.tokens,
        tierPrice:     outcome.tierPrice,
        excess:        outcome.excess,
        paymentMethod: pending.paymentMethod || 'unknown',
        transactionId: pending.transactionId || null,
        verifiedAt:    new Date(),
        submittedAt:   pending.submittedAt,
        resolvedBy:    'system_auto',
        upgradeUsed:   false
    });
    await pendingCol.deleteOne({ _id: pending._id });

    const notifId = crypto.randomUUID();

    // Excess (if any) becomes an outstanding pending_revenue balance — NOT
    // revenue yet — until tipped, used for a Pro upgrade, or refunded. This
    // is the piece that was missing before: without it, Tip/Refund on this
    // notification had nothing to find and always failed.
    if (outcome.excess > 0) {
        await pendingRevenueCol.insertOne({
            notificationId:    notifId,
            userId:            pending.userId,
            amount:            outcome.excess,
            sourceType:        'verified_excess',
            verifiedPaymentId: insertResult.insertedId.toString(),
            status:            'pending',
            createdAt:         new Date(),
            updatedAt:         new Date()
        });
    }

    await writeNotification(usersCol, pending.userId, {
        id:                 notifId,
        type:               'plan_activated',   // (name kept for the app; it now means "CT added")
        plan:               pack.id,
        tokens:             pack.tokens,
        packLabel:          pack.label,
        amount:             pending.claimedAmount,
        excess:             outcome.excess,
        refundEligible:     outcome.excess > 0,
        refundAmount:       outcome.excess,
        verifiedPaymentId:  insertResult.insertedId.toString(),
        resolvedBy:         'system_auto'
    });

    return { status: 'verified', userId: pending.userId, amount: pending.claimedAmount, plan: pack.id, tokens: pack.tokens, excess: outcome.excess };
}

// ── Auto verify — name + exact amount match only, for every payment method ──
// Never rejects. If the matched pending payment's amount doesn't cover its
// chosen plan, it's simply left pending (status stays 'pending' in
// pending_payments) for an admin to resolve.
async function tryAutoVerify(db, amount, senderName, smsBody, smsDocId) {
    const pendingCol = db.collection('pending_payments');
    const smsCol     = db.collection('sms_detections');

    const candidates = await pendingCol.find({
        status:        'pending',
        claimedAmount: amount
    }).toArray();

    const scored = candidates
        .map(c => ({ c, score: nameSimilarity(senderName, c.claimedSenderName) }))
        .filter(x => x.score >= NAME_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

    // Only auto-resolve when there's a single clear best match — avoid
    // guessing between two similarly-named pending payments for the same amount.
    if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
        const pending = scored[0].c;
        const result  = await verifyPendingPayment(db, pending);

        if (result.status === 'insufficient') {
            // Amount matched a pending payment by name, but doesn't cover the
            // plan they chose — leave it pending, flag the SMS as matched-but-
            // insufficient so admin has context in the SMS Detections tab.
            await smsCol.updateOne(
                { _id: smsDocId },
                { $set: { status: 'insufficient_for_chosen_plan', matchedUserId: pending.userId, resolvedAt: new Date() } }
            );
            return { status: 'insufficient_for_chosen_plan' };
        }

        await smsCol.updateOne(
            { _id: smsDocId },
            { $set: { status: result.status, matchedUserId: pending.userId, resolvedAt: new Date() } }
        );
        return result;
    }

    // No confident single match — leave visible for admin review (name +
    // amount are already stored on the SMS record for that).
    await smsCol.updateOne(
        { _id: smsDocId },
        { $set: { status: scored.length > 1 ? 'ambiguous' : 'waiting' } }
    );
    return { status: scored.length > 1 ? 'ambiguous' : 'waiting' };
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Authenticate — only your Android app can call this
    const secret = event.headers['x-sms-secret'] || '';
    if (!secret || secret !== process.env.SMS_WEBHOOK_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { smsBody, sender, receivedAt } = body;

    if (!smsBody) {
        return { statusCode: 400, body: JSON.stringify({ error: 'smsBody is required' }) };
    }

    if (!isBankSender(sender)) {
        return {
            statusCode: 200,
            body: JSON.stringify({ status: 'ignored', reason: 'Not a bank sender' })
        };
    }

    try {
        await mongo.connect();
        const db  = mongo.db('cverve');
        const col = db.collection('sms_detections');

        // Create TTL index once — auto deletes unmatched records after 3 days
        try {
            await col.createIndex(
                { createdAt: 1 },
                { expireAfterSeconds: 259200, background: true }
            );
        } catch (_) {}

        // Extract with DeepSeek
        let extracted = { amount: null, senderName: null };
        try {
            extracted = await extractSmsFields(smsBody);
        } catch (err) {
            console.error('SMS extraction failed:', err.message);
        }

        const normalizedAmount = extracted.amount != null ? Number(extracted.amount) : null;
        const normalizedName   = extracted.senderName ? String(extracted.senderName).trim() : null;

        // Store SMS detection record
        const insertResult = await col.insertOne({
            smsBody,
            sender:     sender || 'unknown',
            receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
            createdAt:  new Date(),
            amount:     normalizedAmount,
            senderName: normalizedName,
            status:     (normalizedAmount && normalizedName) ? 'extracted' : 'unreadable'
        });

        if (!normalizedAmount || !normalizedName) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status:  'unreadable',
                    message: 'Could not extract amount and sender name from SMS'
                })
            };
        }

        const result = await tryAutoVerify(db, normalizedAmount, normalizedName, smsBody, insertResult.insertedId);

        return { statusCode: 200, body: JSON.stringify(result) };

    } catch (error) {
        console.error('receive-sms error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
};