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
// Any leftover after Pro's own price (amount - 79) is reported back
// so the app can offer Refund/Tip for the remainder.
//
// ── REVENUE MODEL ──────────────────────────────────────────────────────
// Basic's tier price (49) was already counted as revenue at verification
// time. The excess above that has been sitting in `pending_revenue`, NOT
// counted as revenue. Upgrading to Pro "spends" part of that pending
// balance — (79 - 49) = 30 — to reach Pro's tier price. That 30 becomes
// real revenue (written to `revenue_events`) and is removed from the
// pending balance. Whatever remains (leftover) stays in `pending_revenue`,
// still awaiting a refund/tip decision.
//
// ── FIX ───────────────────────────────────────────────────────────────
// The pending_revenue doc for the original excess was created tied to the
// notificationId of the ORIGINAL verify notification. This function writes
// a BRAND NEW notification for the upgrade result (with its own new id),
// which is the one the app actually shows Tip/Refund buttons on. The
// pending_revenue doc's `notificationId` was previously left pointing at
// the old, now-irrelevant notification — so tip-payment.js could never
// find it (Tip always failed with "couldn't find or already resolved"),
// and manage-refunds.js's 'complete' action could never find it either
// (the refund itself still worked and notified the user, but Pending
// Revenue was never actually decremented). Fixed by re-tagging the pending
// doc with the NEW notification's id whenever leftover remains, so every
// later action (tip, refund) correctly finds and resolves it.

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

  const { userId, password, verifiedPaymentId } = body;

  if (!userId || !verifiedPaymentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and verifiedPaymentId are required.' }) };
  }

  try {
    await client.connect();
    const db                = client.db('cverve');
    const usersCol          = db.collection('users');
    const verifiedCol       = db.collection('payments');
    const pendingRevenueCol = db.collection('pending_revenue');
    const revenueEventsCol  = db.collection('revenue_events');

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
    if (!verifiedDoc.amount || verifiedDoc.amount < PRO_PRICE) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This payment is not enough to cover Pro.' }) };
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

    // Leftover is computed from the ORIGINAL total amount paid, not from
    // Basic's excess — upgrading just reallocates the whole payment toward
    // Pro's price instead of Basic's, it doesn't need Basic's price AND
    // Pro's price stacked on top of each other.
    const leftover = Math.round((verifiedDoc.amount - PRO_PRICE) * 100) / 100;

    // The portion of the pending excess that's "spent" reaching Pro's tier
    // price from Basic's tier price. This is what converts from pending
    // balance into real, counted revenue.
    const usedForUpgrade = Math.round((PRO_PRICE - (verifiedDoc.tierPrice || 49)) * 100) / 100;

    await verifiedCol.updateOne(
      { _id: verifiedDoc._id },
      { $set: { upgradeUsed: true, upgradedAt: new Date(), upgradeLeftover: leftover } }
    );

    const notifId = crypto.randomUUID();

    // Move `usedForUpgrade` out of pending_revenue and into revenue_events.
    // Whatever's left in the pending doc (should equal `leftover`) stays
    // pending — and is now RE-TAGGED with the new notification's id, so
    // it can actually be found by tip-payment.js / manage-refunds.js when
    // the user acts on THIS notification (the old one it was tied to no
    // longer has any buttons pointing at it).
    const pendingDoc = await pendingRevenueCol.findOne({
      verifiedPaymentId: verifiedDoc._id.toString(),
      sourceType:        'verified_excess',
      status:            'pending'
    });
    if (pendingDoc) {
      const remaining = Math.round((pendingDoc.amount - usedForUpgrade) * 100) / 100;
      if (remaining > 0) {
        await pendingRevenueCol.updateOne(
          { _id: pendingDoc._id },
          { $set: { amount: remaining, notificationId: notifId, status: 'pending', updatedAt: new Date() } }
        );
      } else {
        await pendingRevenueCol.updateOne(
          { _id: pendingDoc._id },
          { $set: { amount: 0, status: 'resolved', updatedAt: new Date() } }
        );
      }
    }
    if (usedForUpgrade > 0) {
      await revenueEventsCol.insertOne({
        notificationId:    notifId,
        userId,
        amount:            usedForUpgrade,
        reason:            'upgrade',
        verifiedPaymentId: verifiedDoc._id.toString(),
        createdAt:         new Date()
      });
    }

    await writeNotification(usersCol, userId, {
      id:              notifId,
      type:            'plan_activated',
      plan:            'pro',
      upgradeFromBasic: true,
      amount:          verifiedDoc.amount,
      excess:          leftover,
      refundEligible:  leftover > 0,
      refundAmount:    leftover,
      // Points refund/tip requests back at the ORIGINAL verified payment
      // (its _id doesn't change on upgrade), so they can be correctly
      // linked to the right sourceType for revenue accounting.
      verifiedPaymentId: verifiedDoc._id.toString(),
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