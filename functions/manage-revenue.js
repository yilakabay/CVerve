// functions/manage-revenue.js  (NEW)
// POST body: { token, action: 'reset' | 'subtract', amount?, reason? }
//
// Admin-only utility for correcting the revenue numbers on the dashboard.
//
// 'reset'    → wipes BOTH Revenue and Pending Revenue back to zero, "start
//              fresh" style. It does NOT delete any underlying payment,
//              refund, or notification history — those stay exactly as
//              they are for record-keeping. Instead it stamps a
//              `revenue_resets` doc with the current time, and admin-stats.js
//              simply ignores anything dated before the most recent reset
//              when adding up Gross, Tips+Upgrades, and Pending Revenue.
//              Any currently-open pending_revenue entries are also marked
//              resolved as of the reset, so old unresolved excess amounts
//              don't linger in the Pending Revenue box after a reset.
//
// 'subtract' → manually removes a specific amount from Revenue ONLY (never
//              touches Pending Revenue). Useful for correcting a mistake,
//              writing off a chargeback, etc. Written to a
//              `revenue_adjustments` collection and summed into net revenue
//              by admin-stats.js. `amount` must be a positive number (the
//              amount to subtract); `reason` is optional free text stored
//              for your own records.

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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, action } = body;

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  try {
    await client.connect();
    const db                   = client.db('cverve');
    const revenueResetsCol     = db.collection('revenue_resets');
    const revenueAdjustmentsCol = db.collection('revenue_adjustments');
    const pendingRevenueCol    = db.collection('pending_revenue');

    if (action === 'reset') {
      const resetAt = new Date();

      await revenueResetsCol.insertOne({
        resetAt,
        resetBy: 'admin'
      });

      // Close out any currently-open pending balances so the Pending
      // Revenue box reads 0 immediately — the underlying documents are
      // kept (not deleted) for history, just marked resolved.
      await pendingRevenueCol.updateMany(
        { status: 'pending' },
        { $set: { status: 'resolved', resolvedReason: 'admin_reset', updatedAt: resetAt } }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Revenue and Pending Revenue have been reset to zero.', resetAt })
      };
    }

    if (action === 'subtract') {
      const { amount, reason } = body;
      const numericAmount = Number(amount);
      if (!numericAmount || isNaN(numericAmount) || numericAmount <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A positive amount to subtract is required.' }) };
      }

      await revenueAdjustmentsCol.insertOne({
        amount:    -Math.abs(Math.round(numericAmount * 100) / 100), // always stored negative
        reason:    (reason || '').trim() || null,
        createdAt: new Date(),
        createdBy: 'admin'
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: `${numericAmount} has been subtracted from Revenue.` })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use reset or subtract.' }) };

  } catch (error) {
    console.error('manage-revenue error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};