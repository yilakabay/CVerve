// functions/process-payment.js
// POST body: { userId, password, paymentId, paymentMethod?, checkOnly? }
//
// The user only ever submits a transaction ID — never an amount or a chosen plan.
// The actual amount is determined automatically by receive-sms.js (SMS detection)
// or, if that fails within 30 minutes, by an admin during manual review
// (admin-verify.js). The plan tier is then resolved from that amount:
//   < 199 ETB            → no plan activated, rejected (full refund offered)
//   199 ETB – 398.99 ETB → Basic activated (any excess above 199 refund-eligible)
//   >= 399 ETB           → Pro activated   (any excess above 399 refund-eligible)
//
// This function's only job is to:
//   1. Record the pending payment (paymentId + submittedAt, no amount yet).
//   2. Immediately send a "System" notification acknowledging receipt.
//   3. Support checkOnly to let the app poll pending/resolved status and decide
//      when to show the "Report" button (30+ minutes with no resolution).

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

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

  const { userId, password, paymentId, paymentMethod, checkOnly } = body;

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
          paymentId:       pending.paymentId,
          submittedAt:     pending.submittedAt,
          reported:        !!pending.reported,
          canReport:       ageMs >= THIRTY_MIN_MS && !pending.reported,
          minutesElapsed:  Math.floor(ageMs / 60000)
        })
      };
    }

    // ── Normal payment submission ──────────────────────────────────────────────
    if (!paymentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Transaction ID is required.' }) };
    }
    const trimmedPaymentId = String(paymentId).trim().toLowerCase();
    if (!trimmedPaymentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Transaction ID cannot be empty.' }) };
    }

    const verifiedCol = db.collection('payments');

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'You already have a pending payment awaiting verification. Please wait until it is reviewed.' })
      };
    }

    // Check for duplicate transaction ID
    const alreadyPending  = await pendingCol.findOne({ paymentId: trimmedPaymentId }, { collation: { locale: 'en', strength: 2 } });
    const alreadyVerified = await verifiedCol.findOne({ paymentId: trimmedPaymentId }, { collation: { locale: 'en', strength: 2 } });
    if (alreadyPending || alreadyVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This transaction ID has already been submitted. Please do not resubmit the same transaction.' })
      };
    }

    // ── Store as pending — amount is unknown until SMS detection or admin review ──
    await pendingCol.insertOne({
      paymentId:     trimmedPaymentId,
      userId,
      paymentMethod: paymentMethod || 'unknown',
      status:        'pending',
      reported:      false,
      submittedAt:   new Date()
    });

    // ── Immediate acknowledgement notification, from "System" ──────────────────
    await writeNotification(db, userId, {
      type:      'payment_received',
      paymentId: trimmedPaymentId
    });

    console.log(`Payment pending: ${trimmedPaymentId}, user: ${userId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:    true,
        pending:    true,
        message:    'We received your payment. Our system will review and activate your plan within a few minutes.',
        paymentId:  trimmedPaymentId
      })
    };

  } catch (error) {
    console.error('process-payment error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};