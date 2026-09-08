// functions/request-refund.js
// POST body: { userId, password, notificationId, amount, bankName, accountFullName, accountIdentifier,
//              sourceType?, verifiedPaymentId? }
//
// Called when the user taps "Refund" on a payment_rejected or plan_activated
// (with excess) notification. Collects their bank/wallet details and creates
// a refund request for the admin to process manually from the Refunds tab.
//
// accountFullName is always required. accountIdentifier's meaning depends on
// bankName: an account number for CBE, or a phone number for CBEBirr/Telebirr
// — the app labels the field accordingly before sending it here.
//
// notificationId (the notification's own id, not a transaction ID — matching
// throughout this payment system is by sender name + amount only) is used to
// dedupe: a user can't submit two refund requests for the same notification.
//
// ── sourceType / verifiedPaymentId (NEW, both optional) ─────────────────────
// These exist purely for accurate revenue accounting on the admin dashboard,
// and are entirely additive — omitting them changes nothing about how a
// refund request is created, reviewed, or paid out.
//
// The problem they solve: a refund can come from two very different places,
// and without tagging which one, the admin dashboard can't tell them apart:
//
//   'verified_excess'   — the notification being refunded was a
//                          plan_activated notification with a real
//                          verifiedPaymentId (i.e. money that WAS added to
//                          the `payments` collection and counted as
//                          revenue). Refunding this should reduce revenue.
//
//   'rejected_payment'  — the notification being refunded was a
//                          payment_rejected notification, which by
//                          definition was never written to `payments` and
//                          was never counted as revenue in the first place.
//                          Refunding this has zero effect on revenue — the
//                          money in and money out both happened outside the
//                          counted total.
//
// The app should send whichever applies based on the notification it's
// refunding: pass `verifiedPaymentId: notification.verifiedPaymentId` and
// `sourceType: 'verified_excess'` when refunding a plan_activated
// notification (it will have a verifiedPaymentId); pass
// `sourceType: 'rejected_payment'` when refunding a payment_rejected
// notification (it won't have one).
//
// If the app doesn't send sourceType (e.g. before this update ships to
// app.html), it's stored as null and admin-stats.js will NOT subtract it
// from revenue — under-counting the refund is the safer failure mode than
// wrongly deflating revenue for money that may never have been counted.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });
const VALID_BANKS = ['CBE', 'Telebirr', 'CBEBirr'];
const VALID_SOURCE_TYPES = ['verified_excess', 'rejected_payment'];

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const {
    userId, password, notificationId, amount, bankName, accountFullName, accountIdentifier,
    sourceType, verifiedPaymentId
  } = body;
  if (!userId || !notificationId || amount === undefined || amount === null || !bankName || !accountFullName || !accountIdentifier) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'userId, notificationId, amount, bankName, accountFullName, and accountIdentifier are all required.' })
    };
  }
  const numericAmount = parseFloat(String(amount).replace(/[^\d.]/g, ''));
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid refund amount.' }) };
  }
  if (!VALID_BANKS.includes(bankName)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bankName must be one of: CBE, Telebirr, CBEBirr.' }) };
  }
  const trimmedName = String(accountFullName).trim();
  if (trimmedName.length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter the full account holder name.' }) };
  }
  const trimmedIdentifier = String(accountIdentifier).trim();
  if (trimmedIdentifier.length < 3) {
    const label = bankName === 'CBE' ? 'account number' : 'phone number';
    return { statusCode: 400, body: JSON.stringify({ error: `Please enter a valid ${label}.` }) };
  }

  // Optional, additive — unrecognized/missing values just stay null rather
  // than causing an error, so older app versions keep working unchanged.
  const safeSourceType = VALID_SOURCE_TYPES.includes(sourceType) ? sourceType : null;
  const safeVerifiedPaymentId = (safeSourceType === 'verified_excess' && verifiedPaymentId)
    ? String(verifiedPaymentId)
    : null;

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const refundsCol = db.collection('refund_requests');
    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }
    // Prevent duplicate refund requests for the same notification
    const existing = await refundsCol.findOne({ notificationId, userId, status: { $ne: 'refunded' } });
    if (existing) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A refund request for this payment is already pending review.' }) };
    }
    await refundsCol.insertOne({
      id: crypto.randomUUID(),
      notificationId,
      userId,
      amount:            numericAmount,
      bankName,
      accountFullName:   trimmedName,
      accountIdentifier: trimmedIdentifier,
      status:            'pending',
      createdAt:         new Date(),
      // NEW — additive, used only by admin-stats.js for revenue accuracy.
      sourceType:         safeSourceType,        // 'verified_excess' | 'rejected_payment' | null
      verifiedPaymentId:  safeVerifiedPaymentId  // links back to payments._id when applicable
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Your refund request has been submitted. Our Payment Review Team will process it manually.' })
    };
  } catch (error) {
    console.error('request-refund error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};