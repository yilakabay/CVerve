const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');

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
            { $push: { notifications: { ...notification, createdAt: new Date() } } }
        );
    } catch (e) {
        console.error('writeNotification error:', e.message);
    }
}

// ── Auto verify logic ─────────────────────────────────────────────────────────
async function tryAutoVerify(db, paymentId, smsAmount, smsBody, smsDocId) {
    const pendingCol  = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');
    const usersCol    = db.collection('users');
    const smsCol      = db.collection('sms_detections');

    const pending = await pendingCol.findOne({ paymentId: { $regex: new RegExp('^' + paymentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }, status: 'pending' });

    if (!pending) {
        // No user submitted yet — keep waiting (TTL removes after 3 days)
        await smsCol.updateOne(
            { _id: smsDocId },
            { $set: { status: 'waiting', paymentId, amount: smsAmount } }
        );
        return { status: 'waiting' };
    }

    const amountMatches = Math.abs(pending.amount - smsAmount) <= 1;

    if (!amountMatches) {
        // Flag for manual admin review
        await smsCol.updateOne(
            { _id: smsDocId },
            { $set: {
                status:         'amount_mismatch',
                matchedUserId:  pending.userId,
                userAmount:     pending.amount,
                smsAmount,
                resolvedAt:     new Date()
            }}
        );
        return {
            status:     'amount_mismatch',
            userId:     pending.userId,
            userAmount: pending.amount,
            smsAmount
        };
    }

    // ── Match found — auto verify ─────────────────────────────────────────────
    await verifiedCol.insertOne({
        paymentId:     pending.paymentId,
        userId:        pending.userId,
        amount:        pending.amount,
        paymentMethod: pending.paymentMethod,
        verifiedAt:    new Date(),
        submittedAt:   pending.submittedAt,
        autoVerified:  true,
        smsBody
    });

    await pendingCol.deleteOne({ _id: pending._id });

    await usersCol.findOneAndUpdate(
        { phoneNumber: pending.userId },
        { $inc: { balance: pending.amount } },
        { upsert: false }
    );

    await smsCol.updateOne(
        { _id: smsDocId },
        { $set: {
            status:        'verified',
            matchedUserId: pending.userId,
            resolvedAt:    new Date()
        }}
    );

    // ── Write verified notification to user ───────────────────────────────────
    await writeNotification(usersCol, pending.userId, {
        type:      'payment_verified',
        amount:    pending.amount,
        paymentId: pending.paymentId
    });

    return {
        status: 'verified',
        userId: pending.userId,
        amount: pending.amount
    };
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
        const normalizedSmsPaymentId = extracted.paymentId ? extracted.paymentId.trim().toLowerCase() : null;
        const insertResult = await col.insertOne({
            smsBody,
            sender:     sender || 'unknown',
            receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
            createdAt:  new Date(),
            paymentId:  normalizedSmsPaymentId,
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

        const result = await tryAutoVerify(
            db,
            normalizedSmsPaymentId,
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