// functions/receive-sms.js
// Receives bank SMS forwarded from the admin's Android device, extracts the
// transaction ID and amount via Gemini, matches it to a pending payment by
// paymentId, then resolves which plan tier that amount qualifies for:
//   < 199 ETB            → rejected, no plan activated. Full amount is refund-eligible.
//   199 ETB – 398.99 ETB → Basic activated. Any amount above 199 is refund-eligible.
//   >= 399 ETB           → Pro activated.   Any amount above 399 is refund-eligible.
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
const PLAN_PRICES = { basic: 199, pro: 399 };
function resolvePlanTier(amount) {
  if (amount < 199) return null;      // too low — reject, nothing activated
  if (amount < 399) return 'basic';
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

// ── Gemini extraction ─────────────────────────────────────────────────────────
async function extractWithGemini(smsText) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel(
        { model: 'gemini-2.5-flash' },
        { apiVersion: 'v1beta' }
    );
    const prompt = `You are a payment SMS parser for Ethiopian banks (CBE, CBEBirr, Telebirr).
Extract the transaction/reference ID and the transferred amount from this SMS.

Rules:
- Transaction ID is usually labeled: Ref, Reference, Transaction ID, TxnID, FT number
- Amount is the money transferred in ETB (Birr)
- Reply ONLY with valid JSON, no explanation, no markdown
- Format: {"paymentId": "FT1234567890", "amount": 500}
- If you cannot find a value use null

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

    if (!plan) {
        // ── Amount too low — reject, nothing activated, full refund-eligible ───
        await verifiedCol.insertOne({
            paymentId:     pending.paymentId,
            userId:        pending.userId,
            amount:        smsAmount,
            plan:          null,
            status:        'rejected_low_amount',
            paymentMethod: pending.paymentMethod || 'unknown',
            resolvedAt:    new Date(),
            submittedAt:   pending.submittedAt,
            ...extra
        });
        await pendingCol.deleteOne({ _id: pending._id });

        await writeNotification(usersCol, pending.userId, {
            type:           'payment_rejected',
            amount:         smsAmount,
            paymentId:      pending.paymentId,
            refundEligible: true,
            refundAmount:   smsAmount
        });

        return { status: 'rejected_low_amount', userId: pending.userId, amount: smsAmount };
    }

    // ── Plan qualifies — activate, and flag any excess above the tier price ───
    const tierPrice = PLAN_PRICES[plan];
    const excess     = Math.round((smsAmount - tierPrice) * 100) / 100;

    await verifiedCol.insertOne({
        paymentId:     pending.paymentId,
        userId:        pending.userId,
        amount:        smsAmount,
        plan,
        tierPrice,
        excess,
        paymentMethod: pending.paymentMethod || 'unknown',
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
        paymentId:      pending.paymentId,
        expiry:         planExpiry,
        refundEligible: excess > 0,
        refundAmount:   excess > 0 ? excess : 0
    });

    return { status: 'verified', userId: pending.userId, amount: smsAmount, plan, excess };
}

// ── Auto verify logic ─────────────────────────────────────────────────────────
async function tryAutoVerify(db, paymentId, smsAmount, smsBody, smsDocId) {
    const pendingCol  = db.collection('pending_payments');
    const smsCol      = db.collection('sms_detections');

    const pending = await pendingCol.findOne({ paymentId, status: 'pending' }, { collation: { locale: 'en', strength: 2 } });

    if (!pending) {
        // No user submitted yet — keep waiting (TTL removes after 3 days)
        await smsCol.updateOne(
            { _id: smsDocId },
            { $set: { status: 'waiting', paymentId, amount: smsAmount } }
        );
        return { status: 'waiting' };
    }

    const result = await resolvePendingPayment(db, pending, smsAmount, smsBody, {});

    await smsCol.updateOne(
        { _id: smsDocId },
        { $set: { status: result.status, matchedUserId: pending.userId, resolvedAt: new Date() } }
    );

    return result;
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
        let extracted = { paymentId: null, amount: null };
        try {
            extracted = await extractWithGemini(smsBody);
        } catch (err) {
            console.error('Gemini extraction failed:', err.message);
        }

        // Store SMS detection record
        const insertResult = await col.insertOne({
            smsBody,
            sender:     sender || 'unknown',
            receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
            createdAt:  new Date(),
            paymentId:  extracted.paymentId ? extracted.paymentId.trim().toLowerCase() : null,
            amount:     extracted.amount    || null,
            status:     extracted.paymentId ? 'extracted' : 'unreadable'
        });

        if (!extracted.paymentId || !extracted.amount) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status:  'unreadable',
                    message: 'Could not extract payment details from SMS'
                })
            };
        }

        const normalizedPaymentId = extracted.paymentId ? extracted.paymentId.trim().toLowerCase() : null;
        const result = await tryAutoVerify(
            db,
            normalizedPaymentId,
            extracted.amount,
            smsBody,
            insertResult.insertedId
        );

        return { statusCode: 200, body: JSON.stringify(result) };

    } catch (error) {
        console.error('receive-sms error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
};