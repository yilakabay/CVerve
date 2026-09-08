// functions/admin-stats.js
//
// POST body: { token, revenuePeriod? }
//   revenuePeriod — 'today' | 'week' | 'month' | '3month' | '6month' | 'year'
//                   (defaults to 'month')
//
// Returns:
//   {
//     totalUsers, activeUsers, superActiveUsers, inactiveUsers,
//     revenue: { period, gross, refundsDeducted, refundsExcluded, refundsUnclassified, net }
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
// ── Revenue — the part that needs real care ─────────────────────────────
// Gross revenue = sum of `payments.amount` in the period. This collection
// ONLY ever gets a row when a payment was actually verified (by admin,
// by report-resolution, or by SMS auto-verify) — never for rejected
// payments, never for admin overrides/comps (those go to `subscriptions`
// with amount:null, not `payments`). So gross already correctly:
//   - counts the FULL amount paid even when the user later upgrades
//     Basic→Pro using the excess (activate-pro-upgrade.js keeps the same
//     payments._id and the same `amount` field — it never creates a second
//     payments row), and
//   - excludes comps/gifts/manual overrides entirely.
//
// Refunds are where it gets tricky: a refund_requests doc can represent
// TWO different situations that must be treated differently:
//
//   sourceType: 'verified_excess'  → refunding money that WAS counted in
//     gross above (e.g. the leftover after a Basic→Pro upgrade, or excess
//     above a plan's price). This SHOULD reduce net revenue — money that
//     was counted as earned is being given back.
//
//   sourceType: 'rejected_payment' → refunding a payment that was REJECTED
//     and therefore was NEVER written to `payments` and NEVER counted in
//     gross. Money physically came in and is going back out, but since it
//     was never counted as revenue to begin with, refunding it should have
//     ZERO effect on the revenue figure — subtracting it would incorrectly
//     make revenue look lower than what was actually, verifiably earned.
//
//   sourceType: null (legacy / not yet sent by app.html) → cannot be
//     classified. These are surfaced separately as `refundsUnclassified`
//     rather than silently guessed at. See request-refund.js for the
//     client-side change needed to start populating sourceType going
//     forward — until that ships, refunds will show here as unclassified
//     and will NOT be subtracted from gross (under-counting a refund is a
//     safer failure than wrongly deflating true revenue).
//
// net = gross - refundsDeducted   (refundsDeducted only includes
//       sourceType: 'verified_excess' refunds completed in the period)

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

    // Gross: every verified payment counts its FULL amount, once — upgrades
    // reuse the same payments._id so there's no double-counting risk here.
    const grossAgg = await paymentsCol.aggregate([
      { $match: { verifiedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const grossRevenue = (grossAgg[0] && grossAgg[0].total) || 0;

    // Refunds that DID reduce already-counted revenue.
    const deductedAgg = await refundsCol.aggregate([
      { $match: { status: 'refunded', resolvedAt: { $gte: since }, sourceType: 'verified_excess' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsDeducted = (deductedAgg[0] && deductedAgg[0].total) || 0;

    // Refunds that were correctly excluded because the underlying payment
    // was never counted as revenue (rejected payments) — shown for
    // transparency, not subtracted.
    const excludedAgg = await refundsCol.aggregate([
      { $match: { status: 'refunded', resolvedAt: { $gte: since }, sourceType: 'rejected_payment' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsExcluded = (excludedAgg[0] && excludedAgg[0].total) || 0;

    // Refunds with no sourceType at all — can't be classified yet (either
    // completed before this feature shipped, or app.html hasn't been
    // updated to send sourceType). Also shown for transparency; also not
    // subtracted, since we can't verify they reduced counted revenue.
    const unclassifiedAgg = await refundsCol.aggregate([
      {
        $match: {
          status: 'refunded',
          resolvedAt: { $gte: since },
          $or: [ { sourceType: { $exists: false } }, { sourceType: null } ]
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const refundsUnclassified = (unclassifiedAgg[0] && unclassifiedAgg[0].total) || 0;

    const netRevenue = Math.round((grossRevenue - refundsDeducted) * 100) / 100;

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
          gross:               grossRevenue,
          refundsDeducted,     // reduced net — refunds on money that WAS counted
          refundsExcluded,     // did not reduce net — refunds on rejected/never-counted payments
          refundsUnclassified, // did not reduce net — unknown source, needs review
          net: netRevenue
        }
      })
    };

  } catch (error) {
    console.error('admin-stats error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};