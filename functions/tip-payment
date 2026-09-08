// functions/tip-payment.js  (NEW)
// POST body: { userId, password, notificationId, verifiedPaymentId? }
//
// Called when the user taps "Leave as Tip" on a plan_activated or
// payment_rejected notification's excess amount. Previously this button
// had NO backend call at all — it only set a localStorage flag so the UI
// wouldn't show the buttons again. That meant tipped money was never
// tracked anywhere and never became real revenue.
//
// This function is the counterpart to request-refund.js: instead of
// collecting bank details and creating a refund_requests doc, it converts
// the matching pending_revenue balance directly into revenue.
//
// The amount tipped is ALWAYS read from the trusted pending_revenue record
// (matched by notificationId), never trusted from the client — this
// mirrors how activate-pro-upgrade.js never trusts a client-supplied
// amount. This also means a tip can only ever be used once: once the
// pending_revenue doc is marked 'resolved', a repeat call is rejected.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, notificationId } = body;
  if (!userId || !notificationId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and notificationId are required.' }) };
  }

  try {
    await client.connect();
    const db                = client.db('cverve');
    const usersCol          = db.collection('users');
    const pendingRevenueCol = db.collection('pending_revenue');
    const revenueEventsCol  = db.collection('revenue_events');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    const pendingDoc = await pendingRevenueCol.findOne({ notificationId, userId });
    if (!pendingDoc) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Could not find this payment record. It may already have been resolved.' }) };
    }
    if (pendingDoc.status !== 'pending' || !(pendingDoc.amount > 0)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This amount has already been refunded or tipped.' }) };
    }

    const tippedAmount = pendingDoc.amount;

    await pendingRevenueCol.updateOne(
      { _id: pendingDoc._id },
      { $set: { amount: 0, status: 'resolved', updatedAt: new Date() } }
    );

    await revenueEventsCol.insertOne({
      notificationId,
      userId,
      amount:            tippedAmount,
      reason:            'tip',
      verifiedPaymentId: pendingDoc.verifiedPaymentId || null,
      createdAt:         new Date()
    });

    await writeNotification(usersCol, userId, {
      type:   'tip_received',
      amount: tippedAmount
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Thank you for your tip!', amount: tippedAmount })
    };

  } catch (error) {
    console.error('tip-payment error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};