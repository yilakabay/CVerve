// functions/activate-pro-upgrade.js
// POST body: { userId, password, verifiedPaymentId }
//
// Triggered by the user tapping "Activate Pro" on a plan_activated
// notification (only shown when they chose & verified Basic with excess
// that itself covers Pro's price). This is fully automatic — no admin
// involvement — but with two important rules:
//
//   1. The excess amount is read from the trusted `payments` (verified)
//      record referenced by verifiedPaymentId, NEVER trusted from the
//      client, and can only be used once (upgradeUsed flag).
//
//   2. This does NOT start a fresh 30-day Pro cycle. It's treated as
//      upgrading the CURRENT Basic period in place, so Pro inherits the
//      Basic plan's existing expiry date. If that Basic period has already
//      expired by the time the user clicks this, upgrading would activate
//      Pro for zero remaining time — so instead this returns `expired: true`
//      and the app offers Refund/Tip for the excess instead of upgrading.
//
// Any leftover excess beyond Pro's own price (excess - 79) is reported back
// so the app can offer Refund/Tip for the remainder.

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const PRO_PRICE = 79;

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

  const { userId, password, verifiedPaymentId } = body;

  if (!userId || !verifiedPaymentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and verifiedPaymentId are required.' }) };
  }

  try {
    await client.connect();
    const db          = client.db('cverve');
    const usersCol     = db.collection('users');
    const verifiedCol  = db.collection('payments');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    let verifiedDoc;
    try { verifiedDoc = await verifiedCol.findOne({ _id: new ObjectId(verifiedPaymentId), userId }); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid verifiedPaymentId.' }) }; }

    if (!verifiedDoc) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Payment record not found.' }) };
    }
    if (verifiedDoc.plan !== 'basic') {
      return { statusCode: 400, body: JSON.stringify({ error: 'This upgrade only applies to a verified Basic payment.' }) };
    }
    if (verifiedDoc.upgradeUsed) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This upgrade has already been used.' }) };
    }
    if (!verifiedDoc.excess || verifiedDoc.excess < PRO_PRICE) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Not enough excess from this payment to cover Pro.' }) };
    }

    // Must still be on the Basic plan from THIS payment, and it must not
    // have already expired — otherwise upgrading would activate Pro for
    // zero remaining time.
    if (user.plan !== 'basic' || !user.planExpiry || new Date(user.planExpiry) <= new Date()) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          expired: true,
          excessAmount: verifiedDoc.excess,
          message: 'Your Basic plan has already expired, so it can no longer be upgraded to Pro. You can request a refund or leave the excess as a tip instead.'
        })
      };
    }

    // ── Upgrade in place — inherit the existing expiry, do not start a new cycle ──
    const planExpiry = user.planExpiry;
    await usersCol.updateOne(
      { phoneNumber: userId },
      {
        $set: {
          plan:            'pro',
          planActivatedAt: new Date(),
          planExpiry:      planExpiry,
          usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
        }
      }
    );

    const leftover = Math.round((verifiedDoc.excess - PRO_PRICE) * 100) / 100;

    await verifiedCol.updateOne(
      { _id: verifiedDoc._id },
      { $set: { upgradeUsed: true, upgradedAt: new Date(), upgradeLeftover: leftover } }
    );

    await writeNotification(usersCol, userId, {
      type:            'plan_activated',
      plan:            'pro',
      upgradeFromBasic: true,
      amount:          verifiedDoc.excess,
      excess:          leftover,
      refundEligible:  leftover > 0,
      refundAmount:    leftover,
      expiry:          planExpiry,
      resolvedBy:      'system_auto'
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, plan: 'pro', planExpiry, leftover })
    };

  } catch (error) {
    console.error('activate-pro-upgrade error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};