// functions/receive-sms.js
// Receives bank/wallet SMS forwarded from the admin's Android device (CBE,
// CBE Birr, Telebirr) and matches it against a pending payment PURELY by
// sender name + exact amount — the same matching rule for every payment
// method. Transaction IDs are never extracted from or matched against SMS
// here; they play no role in this flow at all.
//
// Once a match is found, the plan tier is resolved from the SMS's own amount
// (the trusted source — never the user's screenshot claim):
//   < 49 ETB           → rejected, no plan activated. Full amount is refund-eligible.
//   49 ETB – 78.99 ETB → Basic activated. Any amount above 49 is refund-eligible.
//   >= 79 ETB          → Pro activated.   Any amount above 79 is refund-eligible.
//
// The user is notified either way. If there's a refund-eligible excess (or the
// payment was rejected outright), the notification carries enough info for the
// app to show a "Refund" button, which lets the user submit their bank details
// via request-refund.js for the admin to process from the Refunds tab.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan tier resolution ──────────────────────────────────────────────────────
const PLAN_PRICES = { basic: 49, pro: 79 };
function resolvePlanTier(amount) {
  if (amount < 49) return null;      // too low — reject, nothing activated
  if (amount < 79) return 'basic';
  return 'pro';
}
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

// ── Gemini extraction — amount + sender name only, no transaction ID ─────────
async function extractWithGemini(smsText) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel(
        { model: 'gemini-2.5-flash' },
        { apiVersion: 'v1beta' }
    );
    const prompt = `You are a payment SMS parser for Ethiopian banks/wallets (CBE, CBE Birr, Telebirr).
Extract the following from this SMS:
- amount: the money transferred in ETB (Birr), as a plain number.
- senderName: the full name of the person who sent/transferred the money, if the SMS mentions it.

Reply ONLY with valid JSON, no explanation, no markdown.
Format: {"amount": 500, "senderName": "Abebe Kebede"}
Use null for any field you cannot find.

SMS:
${smsText}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim()
        .replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(text);
}

// ── Write notification to user document ──────────────────────────────────────
async function writeNotification(usersCol, userId, notification) {
    try {
        await usersCol.updateOne(
            { phoneNumber: userId },
            { $push: { notifications: { id: crypto.randomUUID(), read: false, ...notification, createdAt: new Date() } } }
        );
    } catch (e) {
        console.error('writeNotification error:', e.message);
    }
}

// Activate a plan on the user document, resetting usage counters for the new period
async function activatePlan(usersCol, userId, plan) {
    const now    = new Date();
    const expiry = new Date(now.getTime() + PLAN_DURATION_MS);
    await usersCol.updateOne(
        { phoneNumber: userId },
        {
            $set: {
                plan,
                planActivatedAt: now,
                planExpiry:      expiry,
                usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
            }
        },
        { upsert: false }
    );
    return expiry;
}

// ── Core resolution logic — shared shape with admin-verify.js's manual path ──
async function resolvePendingPayment(db, pending, smsAmount, smsBody, extra) {
    const usersCol    = db.collection('users');
    const verifiedCol = db.collection('payments');
    const pendingCol  = db.collection('pending_payments');

    const plan = resolvePlanTier(smsAmount);
    const pendingIdStr = pending._id.toString();

    if (!plan) {
        // ── Amount too low — reject, nothing activated, full refund-eligible ───
        await verifiedCol.insertOne({
            userId:        pending.userId,
            amount:        smsAmount,
            senderName:    pending.claimedSenderName,
            plan:          null,
            status:        'rejected_low_amount',
            paymentMethod: pending.paymentMethod || 'unknown',
            transactionId: pending.transactionId || null,
            resolvedAt:    new Date(),
            submittedAt:   pending.submittedAt,
            ...extra
        });
        await pendingCol.deleteOne({ _id: pending._id });

        await writeNotification(usersCol, pending.userId, {
            type:           'payment_rejected',
            amount:         smsAmount,
            refundEligible: true,
            refundAmount:   smsAmount
        });

        return { status: 'rejected_low_amount', userId: pending.userId, amount: smsAmount };
    }

    // ── Plan qualifies — activate, and flag any excess above the tier price ───
    const tierPrice = PLAN_PRICES[plan];
    const excess     = Math.round((smsAmount - tierPrice) * 100) / 100;

    await verifiedCol.insertOne({
        userId:        pending.userId,
        amount:        smsAmount,
        senderName:    pending.claimedSenderName,
        plan,
        tierPrice,
        excess,
        paymentMethod: pending.paymentMethod || 'unknown',
        transactionId: pending.transactionId || null,
        verifiedAt:    new Date(),
        submittedAt:   pending.submittedAt,
        autoVerified:  true,
        smsBody,
        ...extra
    });
    await pendingCol.deleteOne({ _id: pending._id });

    const planExpiry = await activatePlan(usersCol, pending.userId, plan);

    await writeNotification(usersCol, pending.userId, {
        type:           'plan_activated',
        plan,
        amount:         smsAmount,
        expiry:         planExpiry,
        refundEligible: excess > 0,
        refundAmount:   excess > 0 ? excess : 0
    });

    return { status: 'verified', userId: pending.userId, amount: smsAmount, plan, excess, pendingId: pendingIdStr };
}

// ── Auto verify — name + exact amount match only, for every payment method ──
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
        const result  = await resolvePendingPayment(db, pending, amount, smsBody, {});
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

        // Extract with Gemini
        let extracted = { amount: null, senderName: null };
        try {
            extracted = await extractWithGemini(smsBody);
        } catch (err) {
            console.error('Gemini extraction failed:', err.message);
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