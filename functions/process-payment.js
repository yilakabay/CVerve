// functions/process-payment.js
// POST body: { userId, password, amount, senderName, chosenPlan, transactionId?, paymentMethod?, checkOnly? }
//
// The user picks a plan (Basic or Pro) BEFORE paying. That choice — chosenPlan
// — is stored on the pending record and is the anchor for everything that
// happens next: what shows on the admin's Pending tab, whether a payment can
// be verified at all, and what a Verify/Reject notification says. The system
// always respects what the user chose; it never silently activates a
// different tier just because the amount happens to cover it (see
// receive-sms.js / admin-verify.js for the full decision logic).
//
// amount + senderName are REQUIRED — they are the only fields ever used for
// matching against the real bank SMS. Matching is name + amount only, for
// every payment method, with no fallback to any transaction ID.
//
// transactionId is OPTIONAL. When the screenshot happens to show one, it's
// stored purely to block the user from resubmitting the exact same payment
// again (anti-duplicate / anti-scam-resubmission) — it plays no role in
// matching or activation.
//
// This function's only job is to:
//   1. Record the pending payment (amount, senderName, chosenPlan, optional
//      transactionId, submittedAt).
//   2. Immediately send a "System" notification acknowledging receipt.
//   3. Support checkOnly to let the app poll pending/resolved status and decide
//      when to show the "Report" button (30+ minutes with no resolution).

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const VALID_PLANS = ['basic', 'pro'];

async function writeNotification(db, userId, notification) {
  try {
    await db.collection('users').updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { id: crypto.randomUUID(), read: false, ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, amount, senderName, chosenPlan, transactionId, paymentMethod, checkOnly } = body;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required.' }) };
  }

  try {
    await client.connect();
    const db         = client.db('cverve');
    const usersCol   = db.collection('users');
    const pendingCol = db.collection('pending_payments');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    // ── checkOnly mode — used by the app to decide whether to show the Report button ──
    if (checkOnly) {
      const pending = await pendingCol.findOne({ userId, status: 'pending' });
      if (!pending) {
        return { statusCode: 200, body: JSON.stringify({ hasPending: false }) };
      }
      const ageMs        = Date.now() - new Date(pending.submittedAt).getTime();
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      return {
        statusCode: 200,
        body: JSON.stringify({
          hasPending:      true,
          pendingId:       pending._id.toString(),
          amount:          pending.claimedAmount,
          senderName:      pending.claimedSenderName,
          chosenPlan:      pending.chosenPlan,
          submittedAt:     pending.submittedAt,
          reported:        !!pending.reported,
          canReport:       ageMs >= THIRTY_MIN_MS && !pending.reported,
          minutesElapsed:  Math.floor(ageMs / 60000)
        })
      };
    }

    // ── Normal payment submission ──────────────────────────────────────────────
    const parsedAmount = Number(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A valid amount is required.' }) };
    }
    const trimmedSenderName = senderName ? String(senderName).trim() : '';
    if (!trimmedSenderName) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Sender name is required.' }) };
    }
    if (!chosenPlan || !VALID_PLANS.includes(chosenPlan)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A plan (basic or pro) must be selected before paying.' }) };
    }
    const trimmedTransactionId = transactionId ? String(transactionId).trim().toLowerCase() : null;

    const verifiedCol = db.collection('payments');

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'You already have a pending payment awaiting verification. Please wait until it is reviewed.' })
      };
    }

    // Duplicate check — ONLY when a transaction ID is present (anti-resubmission guard)
    if (trimmedTransactionId) {
      const alreadyPending  = await pendingCol.findOne({ transactionId: trimmedTransactionId }, { collation: { locale: 'en', strength: 2 } });
      const alreadyVerified = await verifiedCol.findOne({ transactionId: trimmedTransactionId }, { collation: { locale: 'en', strength: 2 } });
      if (alreadyPending || alreadyVerified) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'This payment has already been submitted. Please do not resubmit the same payment.' })
        };
      }
    }

    // ── Store as pending — final resolution happens via SMS detection or admin review ──
    const insertResult = await pendingCol.insertOne({
      userId,
      paymentMethod:     paymentMethod || 'unknown',
      status:            'pending',
      reported:          false,
      submittedAt:       new Date(),
      claimedAmount:     parsedAmount,
      claimedSenderName: trimmedSenderName,
      chosenPlan,
      // Optional — present only when the screenshot happened to show one.
      // Used solely to block resubmission of this exact payment; never used
      // for matching against the SMS.
      transactionId:     trimmedTransactionId
    });

    // ── Immediate acknowledgement notification, from "System" ──────────────────
    await writeNotification(db, userId, {
      type:       'payment_received',
      pendingId:  insertResult.insertedId.toString(),
      amount:     parsedAmount,
      chosenPlan
    });

    console.log(`Payment pending: user=${userId}, amount=${parsedAmount}, sender=${trimmedSenderName}, chosenPlan=${chosenPlan}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:    true,
        pending:    true,
        message:    'We received your payment. Our system will review and activate your plan within a few minutes.',
        pendingId:  insertResult.insertedId.toString()
      })
    };

  } catch (error) {
    console.error('process-payment error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};