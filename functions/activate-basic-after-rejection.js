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
    const db       = client.db('cverve');
    const usersCol = db.collection('users');

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

    await writeNotification(usersCol, userId, {
      type:            'plan_activated',
      plan:            'basic',
      amount:          amount,
      excess:          excess,
      refundEligible:  excess > 0,
      refundAmount:    excess,
      canUpgradeToPro: false, // excess here is always < 30 ETB (49–78 range), never enough to cover Pro
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