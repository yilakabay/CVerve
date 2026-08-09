// functions/extract-payment-screenshot.js
// POST body: { userId, password, imageBase64, imageMime, paymentMethod }
//
// Used by the payment flow for ALL payment methods (CBE, CBEBirr, Telebirr).
// The user uploads a screenshot of their own payment confirmation; this
// function reads it with Gemini vision and extracts:
//   - amount       (ETB transferred) — REQUIRED
//   - senderName   (full name on the sending account) — REQUIRED
//   - transactionId (bank reference number) — OPTIONAL, may not be present
//
// amount + senderName are the only fields ever used for matching against the
// real bank SMS (see receive-sms.js / admin-verify.js) — matching is name +
// amount only, for every payment method, full stop.
//
// transactionId, when the screenshot happens to show one, is stored ONLY to
// block a user from resubmitting the exact same screenshot/payment again
// (anti-duplicate / anti-scam-resubmission). It has no role in matching. If
// the screenshot doesn't show a transaction ID at all, that's fine — it's
// simply skipped, and the payment still proceeds on amount + senderName.
//
// This function does NOT create a pending payment — it's a pure extract +
// validate step. If a transactionId IS found and already used, it's rejected
// here, before any pending_payments record is written, so a reused screenshot
// never reaches the backend as a new "pending" entry.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

async function extractWithGemini(base64, mime) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });

  const prompt = `This is a screenshot of a bank/mobile-money payment confirmation
(Ethiopian bank or wallet — CBE, CBE Birr, or Telebirr).
Extract exactly these three fields:
- amount: the amount transferred, in ETB (Birr), as a plain number (no currency symbol, no commas).
- senderName: the full name of the person who SENT the money (the payer / "From" name on the receipt — not the receiver).
- transactionId: the transaction reference number, if shown (often labeled "Reference No", "Transaction Ref", "FT number"). Many receipts DO NOT show this — that is completely fine, use null in that case. Never guess one.

Reply ONLY with valid JSON, no markdown, no explanation, in exactly this shape:
{"amount": 250, "senderName": "Abebe Kebede", "transactionId": "FT1234567890"}

If amount or senderName cannot be found, use null for that field.`;

  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType: mime || 'image/jpeg' } },
    { text: prompt }
  ]);
  const text = result.response.text().trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(text);
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, imageBase64, imageMime, paymentMethod } = body;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required.' }) };
  }
  if (!imageBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A payment screenshot is required.' }) };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key.' }) };
  }

  try {
    await client.connect();
    const db          = client.db('cverve');
    const usersCol     = db.collection('users');
    const pendingCol   = db.collection('pending_payments');
    const verifiedCol  = db.collection('payments');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'You already have a pending payment awaiting verification. Please wait until it is reviewed.' })
      };
    }

    // ── Extract with Gemini vision ──────────────────────────────────────────
    let extracted;
    try {
      extracted = await extractWithGemini(imageBase64, imageMime);
    } catch (err) {
      console.error('extract-payment-screenshot Gemini error:', err.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not read the screenshot. Please upload a clear, uncropped screenshot of your payment confirmation.' }) };
    }

    const amount         = extracted && extracted.amount != null ? Number(extracted.amount) : null;
    const senderName      = extracted && extracted.senderName ? String(extracted.senderName).trim() : '';
    const transactionId   = extracted && extracted.transactionId ? String(extracted.transactionId).trim() : '';

    if (!amount || !senderName) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          error: 'Could not clearly read the amount and sender name from this screenshot. Please make sure both are visible and try again.'
        })
      };
    }

    // ── Duplicate check — ONLY when a transaction ID was actually found.
    //    This is purely an anti-resubmission guard; it never affects matching. ──
    if (transactionId) {
      const normalizedId = transactionId.toLowerCase();
      const alreadyPending  = await pendingCol.findOne({ transactionId: normalizedId }, { collation: { locale: 'en', strength: 2 } });
      const alreadyVerified = await verifiedCol.findOne({ transactionId: normalizedId }, { collation: { locale: 'en', strength: 2 } });
      if (alreadyPending || alreadyVerified) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: false,
            error: 'This payment has already been submitted. Please do not resubmit the same payment.'
          })
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        amount,
        senderName,
        transactionId: transactionId || null,
        paymentMethod: paymentMethod || 'unknown'
      })
    };

  } catch (error) {
    console.error('extract-payment-screenshot error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};