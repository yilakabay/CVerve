// functions/activate-basic-after-rejection.js
// POST body: { userId, password, notificationId }
//
// Triggered by the user tapping "Activate Basic" on a payment_rejected
// notification. Only appears when: the admin rejected a Pro-chosen payment
// specifically because the amount issue toggle was ON (a genuine payment,
// just not enough for Pro) AND that amount was enough to cover Basic —
// admin-verify.js sets canActivateBasic on the notification for exactly
// this case.
//
// Unlike activate-pro-upgrade.js, this is NOT an upgrade of an existing
// plan — nothing was ever activated from this payment, so it starts a
// completely fresh 30-day Basic cycle from today. Any leftover excess above
// Basic's price is reported back so the app can offer Refund/Tip for it.
//
// The notification itself is the source of truth for the amount (the admin
// already vouched for it being genuine via the amount-issue toggle), and is
// marked basicActivationUsed to prevent replay.
//
// ── FIX (previously two connected bugs) ──────────────────────────────────
// 1. This never wrote a `payments` doc, so the 49 ETB tier price it
//    activates was never counted anywhere in revenue — it just vanished.
//    Now it writes a proper `payments` doc (tierPrice 49, real excess),
//    exactly like every other successful verification, so admin-stats.js
//    correctly counts the 49 the moment Basic is activated.
// 2. When the original Pro payment was rejected, admin-verify.js had
//    already written the FULL amount (49 or 55) into `pending_revenue` as
//    a 'rejected_payment' entry, offering the user a refund or a tip on
//    it. That old entry was never closed out when the user chose "Activate
//    Basic" instead — meaning the same money could still be refunded or
//    tipped separately even after it had already been spent activating a
//    plan. This now explicitly resolves (zeroes out) that old entry the
//    moment Basic is successfully activated, and creates a fresh
//    'verified_excess' pending entry ONLY for the genuine leftover above
//    Basic's price (0 for a 49 ETB payment, 6 for a 55 ETB payment, etc.).

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const BASIC_PRICE = 49;
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

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
    const verifiedCol       = db.collection('payments');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    const notif = (user.notifications || []).find(n => n.id === notificationId);
    if (!notif) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Notification not found.' }) };
    }
    if (notif.type !== 'payment_rejected' || !notif.canActivateBasic) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available for this notification.' }) };
    }
    if (notif.basicActivationUsed) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This has already been used.' }) };
    }

    const amount = notif.amount;
    if (!amount || amount < BASIC_PRICE) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This payment does not cover the Basic plan.' }) };
    }
    const excess = Math.round((amount - BASIC_PRICE) * 100) / 100;

    const now        = new Date();
    const planExpiry = new Date(now.getTime() + PLAN_DURATION_MS);

    await usersCol.updateOne(
      { phoneNumber: userId },
      {
        $set: {
          plan:            'basic',
          planActivatedAt: now,
          planExpiry:      planExpiry,
          usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
        }
      }
    );

    // Mark the original notification as used (positional array update) to prevent replay
    await usersCol.updateOne(
      { phoneNumber: userId, 'notifications.id': notificationId },
      { $set: { 'notifications.$.basicActivationUsed': true } }
    );

    // ── FIX 1: actually count the 49 ETB tier price as revenue ────────────
    // Every other path that activates a plan writes a `payments` doc so
    // admin-stats.js can sum tierPrice into gross revenue. This path never
    // did — fixed now, using the same shape as admin-verify.js's
    // verify-one so nothing downstream needs to special-case it.
    const insertResult = await verifiedCol.insertOne({
      userId,
      amount,
      senderName:    null, // not captured on this path — the rejected pending record is gone by now
      plan:          'basic',
      tierPrice:     BASIC_PRICE,
      excess,
      paymentMethod: 'unknown',
      transactionId: null,
      verifiedAt:    now,
      submittedAt:   notif.createdAt || now,
      resolvedBy:    'system_auto_basic_after_rejection',
      upgradeUsed:   false
    });

    // ── FIX 2: close out the OLD pending_revenue entry from the rejection ──
    // admin-verify.js wrote the full rejected amount (49 or 55) into
    // pending_revenue, tagged to THIS notification's id, offering a
    // refund/tip on the whole thing. That money has now been spent
    // activating Basic, so that old entry must be resolved — otherwise the
    // same money could still be refunded or tipped on top of being used.
    await pendingRevenueCol.updateOne(
      { notificationId, status: 'pending' },
      { $set: { amount: 0, status: 'resolved', updatedAt: new Date() } }
    );

    const newNotifId = crypto.randomUUID();

    // A fresh pending_revenue entry is created ONLY for the genuine
    // leftover above Basic's price (e.g. 6 for a 55 ETB payment; nothing
    // at all for an exact 49 ETB payment) — linked to the NEW notification,
    // and now correctly linked to the real payments doc above.
    if (excess > 0) {
      await pendingRevenueCol.insertOne({
        notificationId:    newNotifId,
        userId,
        amount:            excess,
        sourceType:        'verified_excess',
        verifiedPaymentId: insertResult.insertedId.toString(),
        status:            'pending',
        createdAt:         new Date(),
        updatedAt:         new Date()
      });
    }

    await writeNotification(usersCol, userId, {
      id:              newNotifId,
      type:            'plan_activated',
      plan:            'basic',
      amount:          amount,
      excess:          excess,
      refundEligible:  excess > 0,
      refundAmount:    excess,
      canUpgradeToPro: false, // excess here is always < 30 ETB (49–78 range), never enough to cover Pro
      verifiedPaymentId: insertResult.insertedId.toString(),
      expiry:          planExpiry,
      resolvedBy:      'system_auto'
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, plan: 'basic', planExpiry, excess })
    };

  } catch (error) {
    console.error('activate-basic-after-rejection error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};