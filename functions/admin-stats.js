// functions/admin-stats.js
// NEW FILE — does not modify any existing function.
//
// POST body: { token, revenuePeriod? }
//   revenuePeriod — 'today' | 'week' | 'month' | '3month' | '6month' | 'year'
//                   (defaults to 'month')
//
// Returns:
//   {
//     totalUsers, activeUsers, superActiveUsers, inactiveUsers,
//     revenue: { period, amount, refunds, net }
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
// Revenue          = sum of verified `payments.amount` in the selected period
//                    minus sum of `refund_requests.amount` where
//                    status:'refunded' and resolvedAt falls in that period.
//
// IMPORTANT CAVEAT: `lastActiveAt` only exists on users going forward from
// whenever increment-usage.js's new $set line is deployed — there is no
// historical backfill, because no prior version of this system recorded a
// per-action timestamp. Active/Inactive numbers will under-count until 30
// days of real usage has accumulated after deploy.

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
    const db          = client.db('cverve');
    const usersCol     = db.collection('users');
    const paymentsCol  = db.collection('payments');
    const refundsCol   = db.collection('refund_requests');

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

    const revenueAgg = await paymentsCol.aggregate([
      { $match: { verifiedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const grossRevenue = (revenueAgg[0] && revenueAgg[0].total) || 0;

    const refundsAgg = await refundsCol.aggregate([
      { $match: { status: 'refunded', resolvedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalRefunds = (refundsAgg[0] && refundsAgg[0].total) || 0;

    const netRevenue = Math.round((grossRevenue - totalRefunds) * 100) / 100;

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
          gross: grossRevenue,
          refunds: totalRefunds,
          net: netRevenue
        }
      })
    };

  } catch (error) {
    console.error('admin-stats error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};