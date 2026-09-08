// functions/admin-stats.js
//
// POST body: { token, revenuePeriod? }
//   revenuePeriod — 'today' | 'week' | 'month' | '3month' | '6month' | 'year'
//                   (defaults to 'month')
//
// Returns:
//   {
//     totalUsers, activeUsers, superActiveUsers, inactiveUsers,
//     revenue: {
//       period, gross, tipsAndUpgrades, net,
//       refundsOnPendingExcess, refundsOnRejected, refundsUnclassified
//     },
//     pendingRevenue
//   }
//
// ── Definitions (per product spec) ──────────────────────────────────────
// Total Users      = all registered accounts, excluding deleted ones.
// Active Users     = users with at least one SUCCESSFUL letter generation,
//                    fit/not-fit check, or Smart Finder run in the last 30
//                    days. Tracked via `lastActiveAt` (set by
//                    increment-usage.js on every successful action) and
//                    `lastSmartFinderRunAt` (already set by increment-usage.js
//                    when a Smart Finder run is claimed).
// Super Active     = users who upgraded their plan in the last 30 days,
//                    i.e. `planActivatedAt` within 30 days.
// Inactive Users   = Total Users minus Active Users (by the definition above).
//
// ── Revenue — REVAMPED for the pending-revenue model ─────────────────────
// Previously, gross revenue summed the FULL amount paid the moment a
// payment was verified, and a small set of refund rules tried to patch
// around the fact that some of that "revenue" wasn't actually earned yet.
//
// The new model is simpler and more accurate:
//
//   gross = sum of each verified payment's TIER PRICE only (49 for Basic,
//     79 for Pro) in the period — the part that's unambiguously earned the
//     moment a plan is activated. Any amount above the tier price
//     ("excess") is NOT included here — it starts life in the
//     `pending_revenue` collection instead (see admin-verify.js,
//     activate-basic-after-rejection.js), not as revenue.
//
//   tipsAndUpgrades = sum of `revenue_events.amount` in the period — money
//     that started as a pending excess and was converted into real revenue,
//     either because the user tipped it (tip-payment.js) or used it to
//     cover part of a Basic→Pro upgrade (activate-pro-upgrade.js).
//
//   net = gross + tipsAndUpgrades
//
// Refunds NEVER reduce net anymore, for either sourceType — because by the
// time a refund is requested, the money being refunded was still sitting
// in `pending_revenue`, not counted as revenue in the first place (that's
// the whole point of the pending bucket). Completing a refund
// (manage-refunds.js) only removes it from pending_revenue. The three
// refund figures below are reported purely for admin visibility, not
// subtracted from anything:
//
//   refundsOnPendingExcess — refunds completed on a 'verified_excess'
//     pending balance (e.g. the leftover after an upgrade, or an unused
//     excess). Zero revenue effect.
//   refundsOnRejected      — refunds completed on a 'rejected_payment'
//     pending balance (a genuine payment that was too small to activate
//     any plan). Zero revenue effect.
//   refundsUnclassified    — refund_requests with no sourceType at all
//     (legacy data from before this feature, or a client that hasn't been
//     updated). Also zero revenue effect; surfaced so it can be reviewed.
//
// ── pendingRevenue ────────────────────────────────────────────────────────
// A live running total — NOT period-scoped, same as Active/Inactive Users
// — of every pending_revenue doc still in status 'pending'. This is the
// "how much outstanding excess money is currently sitting with us,
// unresolved" figure for the new dashboard box.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

// Query fragment that excludes deleted users whether your delete flow is a
// hard delete (nothing to exclude — this is a no-op) or a soft delete using
// either `isDeleted: true` or a present `deletedAt`. Safe either way.
const NOT_DELETED_FILTER = {
  $and: [
    { isDeleted: { $ne: true } },
    { deletedAt: { $exists: false } }
  ]
};

function periodStart(period) {
  const now = new Date();
  const start = new Date(now);
  switch (period) {
    case 'today':   start.setHours(0, 0, 0, 0); break;
    case 'week':    start.setDate(now.getDate() - 7); break;
    case '3month':  start.setMonth(now.getMonth() - 3); break;
    case '6month':  start.setMonth(now.getMonth() - 6); break;
    case 'year':    start.setFullYear(now.getFullYear() - 1); break;
    case 'month':
    default:        start.setMonth(now.getMonth() - 1); break;
  }
  return start;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, revenuePeriod } = body;

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  try {
    await client.connect();
    const db                = client.db('cverve');
    const usersCol          = db.collection('users');
    const paymentsCol       = db.collection('payments');
    const refundsCol        = db.collection('refund_requests');
    const revenueEventsCol  = db.collection('revenue_events');
    const pendingRevenueCol = db.collection('pending_revenue');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // ── Total Users ──────────────────────────────────────────────────────
    const totalUsers = await usersCol.countDocuments(NOT_DELETED_FILTER);

    // ── Active Users ─────────────────────────────────────────────────────
    const activeFilter = {
      ...NOT_DELETED_FILTER,
      $or: [
        { lastActiveAt:          { $gte: thirtyDaysAgo } },
        { lastSmartFinderRunAt:  { $gte: thirtyDaysAgo } }
      ]
    };
    const activeUsers = await usersCol.countDocuments(activeFilter);

    // ── Super Active Users (upgraded plan in last 30 days) ─────────────────
    const superActiveUsers = await usersCol.countDocuments({
      ...NOT_DELETED_FILTER,
      planActivatedAt: { $gte: thirtyDaysAgo }
    });

    // ── Inactive Users ───────────────────────────────────────────────────
    const inactiveUsers = Math.max(0, totalUsers - activeUsers);

    // ── Revenue ──────────────────────────────────────────────────────────
    const period = revenuePeriod || 'month';
    const since  = periodStart(period);

    // Gross: sum of tierPrice only — the part earned immediately, the
    // moment a plan is verified/activated. Excess is NOT included here.
    const grossAgg = await paymentsCol.aggregate([
      { $match: { verifiedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$tierPrice' } } }
    ]).toArray();
    const grossRevenue = (grossAgg[0] && grossAgg[0].total) || 0;

    // Tips + upgrade-conversions in the period — pending excess that became
    // real revenue.
    const eventsAgg = await revenueEventsCol.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const tipsAndUpgrades = (eventsAgg[0] && eventsAgg[0].total) || 0;

    const netRevenue = Math.round((grossRevenue + tipsAndUpgrades) * 100) / 100;

    // Refund breakdowns — reported for visibility only, never subtracted.
    const refundsOnPendingExcessAgg = await refundsCol.aggregate([
      { $match: { status: 'refunded', resolvedAt: { $gte: since }, sourceType: 'verified_excess' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsOnPendingExcess = (refundsOnPendingExcessAgg[0] && refundsOnPendingExcessAgg[0].total) || 0;

    const refundsOnRejectedAgg = await refundsCol.aggregate([
      { $match: { status: 'refunded', resolvedAt: { $gte: since }, sourceType: 'rejected_payment' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsOnRejected = (refundsOnRejectedAgg[0] && refundsOnRejectedAgg[0].total) || 0;

    const refundsUnclassifiedAgg = await refundsCol.aggregate([
      {
        $match: {
          status: 'refunded',
          resolvedAt: { $gte: since },
          $or: [ { sourceType: { $exists: false } }, { sourceType: null } ]
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsUnclassified = (refundsUnclassifiedAgg[0] && refundsUnclassifiedAgg[0].total) || 0;

    // ── Pending Revenue — a live running total, not period-scoped ──────────
    const pendingAgg = await pendingRevenueCol.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const pendingRevenue = (pendingAgg[0] && pendingAgg[0].total) || 0;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        totalUsers,
        activeUsers,
        superActiveUsers,
        inactiveUsers,
        revenue: {
          period,
          gross:                   grossRevenue,
          tipsAndUpgrades,         // converted from pending — added to net
          net:                     netRevenue,
          refundsOnPendingExcess,  // informational only — zero revenue effect
          refundsOnRejected,       // informational only — zero revenue effect
          refundsUnclassified      // informational only — zero revenue effect
        },
        pendingRevenue
      })
    };

  } catch (error) {
    console.error('admin-stats error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};