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

// NOTE: this used to import a `callDeepSeek` helper that never existed
// anywhere in ai-billing.js (only `callAI` is exported). That made every
// call to extractSmsFields() below throw a TypeError immediately, which was
// silently caught in the handler — so EVERY incoming SMS, no matter how
// clean, was stamped 'unreadable' and nothing ever auto-verified. Fixed by
// calling the real callAI() with the DeepSeek Flash model directly.
const { callAI, parseJsonLoose, MODEL_IDS } = require('./lib/ai-billing');
const { computeVerifyOutcome, creditTokens } = require('./lib/packs');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Allowed bank senders ──────────────────────────────────────────────────────
// Narrowed 2026-11-05 per the admin's own confirmation: this app only ever
// accepts two payment channels (CBE and Telebirr — see app.html's two
// payment-method screens), and on-device the real transaction senders are
// exactly "CBE" and the short code "127". Telebirr's other SMS senders
// ('telebirr', '7978', '9999') are NOT transaction notifications — they're
// used for official announcements, OTPs/passwords, and other non-payment
// messages — so accepting them here was letting irrelevant SMS reach the
// AI extractor and clutter sms_detections with noise that could never
// actually match a payment. Likewise CBE Birr's separate senders
// ('cbebirr', '7809') were never a real channel this app accepts payments
// through (app.html has no CBE Birr payment screen, only 'cbe'), so they're
// dropped too. Kept narrow and exact on purpose — this list should mirror
// exactly the channels pending_payments.paymentMethod can ever be.
const ALLOWED_SENDERS = ['cbe', '127'];

function isBankSender(sender) {
    if (!sender) return false;
    const lower = sender.toLowerCase();
    return ALLOWED_SENDERS.some(s => lower.includes(s));
}

// Classifies which payment method (matching pending_payments.paymentMethod,
// which is always 'cbe' or 'telebirr' — see app.html's two payment-method
// screens) an incoming SMS's sender belongs to. Used so matching never pairs
// an SMS from one channel with a pending payment submitted under the other
// — e.g. the CBE short code '8397' should never get matched against a
// Telebirr pending payment just because the amount+name happened to line
// up. Returns null for a sender that doesn't map cleanly (matching then
// falls back to the existing amount/name/transactionId logic unfiltered,
// same as before this existed, rather than refusing to match at all).
function classifySmsPaymentMethod(sender) {
    if (!sender) return null;
    const lower = sender.toLowerCase();
    if (lower.includes('127')) return 'telebirr';
    if (lower.includes('cbe')) return 'cbe';
    return null;
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
//
// Every incoming SMS was landing in the admin's SMS Detections tab marked
// "Unreadable" — even perfectly clean, standard-format CBE messages like
// "Dear X You have received ETB 99.00 from account ...(Y)... Thanks for
// Banking with CBE." That status is set purely by whether extraction
// returned BOTH a numeric amount and a sender name (see the handler below);
// when it throws or returns null for either, every SMS is "unreadable"
// regardless of how readable the text actually is.
//
// Root cause: maxTokens was 100 — far tighter than the identical
// truncation-prone DeepSeek Flash model needed elsewhere in this app
// (Smart Finder needed 3000, up from 1500, for the exact same reason: see
// ai-billing.js/smart-finder.js). A cut-off response here comes back as
// invalid JSON, parseJsonLoose() throws, and the caller's try/catch swallows
// it and falls back to { amount: null, senderName: null } — i.e.
// "unreadable" on every single message, not just hard-to-parse ones, which
// matches exactly what was reported. Raised to 300, consistent with how the
// other two were fixed, and a second real attempt is now allowed (attempts
// alone doesn't help a content/parse failure — only a network/5xx retry —
// so this also retries the WHOLE extraction once if parsing fails, same
// shape as the pass-loop pattern used elsewhere in this app).
async function extractSmsFields(smsText) {
    const prompt = `You are a payment SMS parser for Ethiopian banks/wallets (CBE, CBE Birr, Telebirr). Different providers word their messages differently — do not assume every message is formatted like CBE's.

Extract the following from this SMS:
- amount: the money transferred in ETB (Birr), as a plain number only — no currency symbol, no commas, no words.
- senderName: the full name of the person who SENT/transferred the money TO this account — never the account holder who is RECEIVING it. Read the sentence carefully to tell the two apart in whatever format this particular message uses:
  - On CBE messages the sender's name is usually shown in parentheses after "from account ...", e.g. in "...from account 1*******3216 (Kibur Yirga Teshager) to your account..." the senderName is "Kibur Yirga Teshager" — NOT the "Dear <name>" greeting at the start, which is the account holder receiving the money.
  - Telebirr and other providers may word it differently (e.g. a sentence naming who paid/transferred, with no parentheses, or the payer's name and phone number given directly rather than after "from account"). In every case, pick the person on the PAYING/SENDING side of the sentence, whatever the exact wording, not the account holder who received the funds.
  - Telebirr's incoming-payment notification often does NOT name the sender at all — if there genuinely is no name anywhere in the message, use null rather than guessing or inventing one.
- transactionId: the transaction reference number, if the message shows one (labels vary: "Transaction No", "Txn No", "Reference No", "FT number", etc.). Many messages don't show one — use null in that case, never guess.

Reply ONLY with valid JSON, no explanation, no markdown, no extra text before or after.
Format: {"amount": 500, "senderName": "Abebe Kebede", "transactionId": "DK53QAWNT3"}
Use null for any field you cannot find.

SMS:
${smsText}`;

    // Netlify's own log capture for this app has been confirmed completely
    // unusable in earlier debugging sessions (get-request-logs always
    // returns an empty "logs" array no matter what's console.error'd), so a
    // raised maxTokens budget that STILL produced "Unreadable" on a clean,
    // ordinary SMS (reported after the fix above shipped) can't be diagnosed
    // from server logs at all. Every attempt below now carries its raw B.AI
    // response text (or the thrown error) back up via a `rawText`/`debug`
    // property on whatever it returns/throws, so the caller can write it
    // straight into the sms_detections MongoDB record — which the admin
    // panel already renders — instead of a log line nobody can read.
    // Models to try, in order. Previously this hammered MODEL_IDS.DEEPSEEK_FLASH
    // ('DeepSeek-V4.1-Flash') twice — but that model ID has been deprecated/
    // removed by the B.AI gateway (confirmed 2026-11-04 via the new debugInfo
    // surface: "Error: The model 'DeepSeek-V4.1-Flash' does not exist"), so
    // every single call failed immediately with an empty raw response,
    // regardless of maxTokens or prompt wording — which is why the earlier
    // maxTokens/prompt fix did not resolve the user's report of a still-
    // "Unreadable" brand-new SMS. GEMINI_FLASH is swapped in as primary (it's
    // the proven-reliable model used for LETTER_EXTRACTION/CV_EXTRACTION/
    // GENERIC_EXTRACTION elsewhere, and as Smart Finder's/Fit Check's working
    // fallback), with DEEPSEEK_PRO as a genuinely different second attempt
    // instead of retrying the same (now-working) model twice.
    const modelsToTry = [MODEL_IDS.GEMINI_FLASH, MODEL_IDS.DEEPSEEK_PRO];
    let lastErr;
    let lastRawText = null;
    for (let attempt = 1; attempt <= modelsToTry.length; attempt++) {
        try {
            const result = await callAI({
                model: modelsToTry[attempt - 1],
                messages: [
                    { role: 'system', content: 'You extract fields from bank SMS messages. You reply with valid JSON only.' },
                    { role: 'user',   content: prompt }
                ],
                maxTokens: 300,
                temperature: 0,
                json: true,
                timeoutMs: 15000,
                attempts: 2
            });
            lastRawText = result.text;
            const parsed = parseJsonLoose(result.text);
            return { parsed, rawText: result.text, finishReason: result.finishReason };
        } catch (err) {
            lastErr = err;
            console.error(`extractSmsFields: attempt ${attempt} (model ${modelsToTry[attempt - 1]}) failed:`, err.message);
        }
    }
    lastErr.rawText = lastRawText; // whatever text (if any) the last attempt actually got back, for debugging
    throw lastErr;
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

    const outcome = computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount, pending.paymentMethod);
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

// Shared by both the transaction-number and name+amount match paths below:
// credits the matched pending payment and marks the SMS record resolved
// accordingly. Never rejects — if the amount doesn't cover the chosen pack,
// the SMS is flagged but the pending payment is left for an admin.
async function resolveAutoVerifyMatch(db, pending, smsCol, smsDocId) {
    const result = await verifyPendingPayment(db, pending);

    if (result.status === 'insufficient') {
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

// ── Auto verify — transaction number match first, then name + exact amount —
// for every payment method. Never rejects. If the matched pending payment's
// amount doesn't cover its chosen plan, it's simply left pending (status
// stays 'pending' in pending_payments) for an admin to resolve.
async function tryAutoVerify(db, amount, senderName, smsBody, smsDocId, transactionId, paymentMethod) {
    const pendingCol = db.collection('pending_payments');
    const smsCol     = db.collection('sms_detections');

    // Transaction number first — confirmed 2026-11-05: Telebirr's own
    // incoming-payment SMS carries no sender name at all, but its
    // transaction number matches the one on the payer's own receipt. A
    // transaction reference is a far stronger signal than name-similarity
    // (it's a unique bank reference), so when both sides have one and it
    // matches, that's authoritative on its own — no need for amount to line
    // up exactly either, since the SMS's own stated amount and the payer's
    // claimed amount can differ slightly (Telebirr's confirmation shows the
    // fee-inclusive deducted total, not necessarily the same figure the
    // SMS states — see TELEBIRR_FEE_TOLERANCE_ETB in lib/packs.js, which is
    // what actually governs how much of that difference is absorbed).
    if (transactionId) {
        const txnCandidates = await pendingCol.find({
            status:        'pending',
            transactionId: transactionId
        }).toArray();
        if (txnCandidates.length === 1) {
            return await resolveAutoVerifyMatch(db, txnCandidates[0], smsCol, smsDocId);
        }
        // length > 1 (shouldn't happen — transactionId is meant to be unique
        // per the anti-resubmission guard in process-payment.js) or 0 falls
        // through to the name+amount path below.
    }

    const candidates = await pendingCol.find({
        status:        'pending',
        claimedAmount: amount
    }).toArray();

    const scored = candidates
        // Channel guard: don't let a CBE SMS match a Telebirr pending
        // payment (or vice versa) just because amount+name happen to line
        // up — only applied when BOTH sides' channel is actually known, so
        // it never blocks a match that would have worked before this
        // existed (classifySmsPaymentMethod can return null for an
        // unrecognized sender string).
        .filter(c => !paymentMethod || !c.paymentMethod || c.paymentMethod === paymentMethod)
        .map(c => ({ c, score: nameSimilarity(senderName, c.claimedSenderName) }))
        .filter(x => x.score >= NAME_MATCH_THRESHOLD)
        // Highest score first; a tie (e.g. the SAME person paying the SAME
        // amount twice in a row — a real, confirmed case) breaks to whichever
        // pending payment has been waiting longest, so a genuine repeat
        // payment still resolves in submission order instead of blocking
        // every match after it forever (see the long comment on
        // tryMatchExistingSms below for how this was found).
        .sort((a, b) => b.score - a.score || new Date(a.c.submittedAt) - new Date(b.c.submittedAt));

    // Auto-resolve whenever there's a best match — either a single candidate,
    // a clear score winner, or a tie broken by submission order above.
    if (scored.length >= 1) {
        return await resolveAutoVerifyMatch(db, scored[0].c, smsCol, smsDocId);
    }

    // No candidate even passes the name-similarity threshold — leave visible
    // for admin review (name + amount are already stored on the SMS record).
    await smsCol.updateOne(
        { _id: smsDocId },
        { $set: { status: 'waiting' } }
    );
    return { status: 'waiting' };
}

// ── Reverse match: a pending payment was just submitted — check whether a
// bank SMS already arrived for it earlier and is sitting unmatched ─────────
// ROOT CAUSE (found 2026-11-04): tryAutoVerify() above only runs at the
// moment an SMS arrives, matching it against pending_payments that ALREADY
// exist at that instant. But the Android app forwards the bank SMS the
// moment it lands on the phone, which is routinely BEFORE the user has
// finished filling in and submitting the payment-claim form on the site —
// confirmed from a real case where the SMS's own "Waiting for matching
// payment" admin card is timestamped 19:44:44 and the matching pending
// payment the user submitted is timestamped three minutes later, 19:47:39.
// At 19:44 there was nothing to match against, so the SMS was correctly
// left 'waiting' — but once the pending payment showed up afterward,
// nothing ever re-checked that already-stored SMS against it, so it sat in
// "Waiting for matching payment" (and the payment sat in Pending) forever,
// even though the SMS had since become perfectly readable. This closes that
// gap from the other direction: call right after a pending payment is
// inserted, so a same-amount/same-name SMS that arrived earlier gets picked
// up immediately instead of only an admin noticing and resolving it by hand.
//
// SECOND ROOT CAUSE (found 2026-11-05, same case): even with the above fix
// deployed, a repeat case still stuck in Pending. Turned out this payment
// WAS correctly matched against — but the match was a 2-way tie: the user's
// earlier unresolved SMS (19:44:44, same name, same amount, never manually
// verified by the admin as suggested) and the new SMS (20:19:10) both had
// IDENTICAL name+amount scores against this new payment. The old strict
// "only resolve if there's a single clear winner" rule treats a tie as "no
// confident match" and refuses to guess — which is the right instinct for
// two DIFFERENT people, but wrong for the same person legitimately paying
// the same amount more than once: every payment after the first duplicate
// would stay stuck forever, each one tying against the still-unresolved
// previous one. Fixed by breaking ties to the OLDEST unresolved SMS (the
// one that's been waiting longest) rather than refusing to pick — same
// policy a human admin would apply, and it now resolves duplicates in
// first-in-first-out order instead of jamming the whole queue.
async function resolveReverseMatch(db, pending, sms, smsCol) {
    const result = await verifyPendingPayment(db, pending);

    if (result.status === 'insufficient') {
        await smsCol.updateOne(
            { _id: sms._id },
            { $set: { status: 'insufficient_for_chosen_plan', matchedUserId: pending.userId, resolvedAt: new Date() } }
        );
        return { status: 'insufficient_for_chosen_plan' };
    }

    await smsCol.updateOne(
        { _id: sms._id },
        { $set: { status: result.status, matchedUserId: pending.userId, resolvedAt: new Date() } }
    );
    return result;
}

async function tryMatchExistingSms(db, pending) {
    const smsCol = db.collection('sms_detections');

    // Transaction number first — see the matching comment on tryAutoVerify's
    // own transactionId branch. Authoritative on its own when both sides
    // have one and it matches: no exact-amount requirement, since Telebirr's
    // SMS amount and the payer's claimed amount can differ by the provider's
    // fee (absorbed by TELEBIRR_FEE_TOLERANCE_ETB in lib/packs.js, not by
    // requiring an exact match here).
    if (pending.transactionId) {
        const txnCandidates = await smsCol.find({
            status:        { $in: ['waiting', 'ambiguous'] },
            transactionId: pending.transactionId
        }).toArray();
        if (txnCandidates.length === 1) {
            return await resolveReverseMatch(db, pending, txnCandidates[0], smsCol);
        }
    }

    const candidates = await smsCol.find({
        status: { $in: ['waiting', 'ambiguous'] },
        amount: pending.claimedAmount
    }).toArray();

    const scored = candidates
        // Same channel guard as tryAutoVerify — only filters when both
        // sides' channel is actually known.
        .filter(s => !pending.paymentMethod || !s.paymentMethod || s.paymentMethod === pending.paymentMethod)
        .map(s => ({ s, score: nameSimilarity(pending.claimedSenderName, s.senderName) }))
        .filter(x => x.score >= NAME_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score || new Date(a.s.createdAt) - new Date(b.s.createdAt));

    if (scored.length === 0) {
        return { status: 'no_match' };
    }

    return await resolveReverseMatch(db, pending, scored[0].s, smsCol);
}

module.exports.tryMatchExistingSms = tryMatchExistingSms;

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

        // Extract with DeepSeek — also capture raw debug info (see the long
        // comment above extractSmsFields): console.error alone is provably
        // invisible for this app, so whatever happened gets written onto the
        // record itself instead, where the admin SMS Detections panel can
        // actually show it.
        let extracted = { amount: null, senderName: null };
        let debugInfo = null;
        try {
            const { parsed, rawText, finishReason } = await extractSmsFields(smsBody);
            extracted = parsed || {};
            debugInfo = { rawText: (rawText || '').slice(0, 500), finishReason: finishReason || null };
        } catch (err) {
            console.error('SMS extraction failed:', err.message);
            debugInfo = {
                error:   (err.message || 'unknown error').slice(0, 300),
                rawText: (err.rawText || '').slice(0, 500)
            };
        }

        // Defense in depth: strip anything but digits/./- before Number()
        // in case the model still returns something like "ETB 99.00" or
        // "99,00" despite the prompt's "plain number only" instruction —
        // Number("ETB 99.00") is NaN, and NaN is falsy, which would have
        // silently produced the exact same "unreadable" result this whole
        // fix is for, just from a different direction (bad format rather
        // than a truncated/missing response).
        const rawAmount = extracted.amount != null ? String(extracted.amount).replace(/[^\d.\-]/g, '') : '';
        const parsedAmount = rawAmount ? Number(rawAmount) : NaN;
        const normalizedAmount = Number.isFinite(parsedAmount) ? parsedAmount : null;
        const normalizedName   = extracted.senderName ? String(extracted.senderName).trim() : null;
        // Telebirr's incoming-payment SMS to the admin's phone has been
        // confirmed to carry NO sender name at all (unlike CBE's
        // parenthetical name) but DOES carry a transaction number that
        // matches the payer's own receipt — so a message is readable with
        // EITHER a name OR a transaction number, not name alone.
        const normalizedTxnId  = extracted.transactionId ? String(extracted.transactionId).trim().toLowerCase() : null;
        const smsPaymentMethod = classifySmsPaymentMethod(sender);

        // Store SMS detection record
        const insertResult = await col.insertOne({
            smsBody,
            sender:        sender || 'unknown',
            paymentMethod: smsPaymentMethod, // 'cbe' | 'telebirr' | null — see classifySmsPaymentMethod
            receivedAt:    receivedAt ? new Date(receivedAt) : new Date(),
            createdAt:     new Date(),
            amount:        normalizedAmount,
            senderName:    normalizedName,
            transactionId: normalizedTxnId,
            status:        (normalizedAmount && (normalizedName || normalizedTxnId)) ? 'extracted' : 'unreadable',
            debugInfo  // only meaningful (and only shown by the admin UI) when status is 'unreadable'
        });

        if (!normalizedAmount || (!normalizedName && !normalizedTxnId)) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status:  'unreadable',
                    message: 'Could not extract amount and a sender name or transaction number from SMS'
                })
            };
        }

        const result = await tryAutoVerify(db, normalizedAmount, normalizedName, smsBody, insertResult.insertedId, normalizedTxnId, smsPaymentMethod);

        return { statusCode: 200, body: JSON.stringify(result) };

    } catch (error) {
        console.error('receive-sms error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
};