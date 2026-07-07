// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify' | 'reject', entries?, paymentId? }
//
// CHANGED IN SESSION 4:
//   verify action now activates a plan subscription instead of crediting balance.
//   Each entry must carry a `plan` field ('free'|'basic'|'pro').
//   The pending_payments document stores the chosen plan; admin supplies it on verify.
//   Legacy balance $inc is removed; $inc { balance } is no longer called.
//
// Reject flow is unchanged.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan catalogue — kept in sync with get-user.js ───────────────────────────
const VALID_PLANS = ['free', 'basic', 'pro'];

const PLAN_PRICES = { free: 0, basic: 199, pro: 399 };

// Plan subscription is valid for 30 days from activation
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

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

async function writeNotification(usersCol, userId, notification) {
  try {
    await usersCol.updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
  }
}

// Activate a plan on the user document
async function activatePlan(usersCol, userId, plan) {
  const now    = new Date();
  const expiry = new Date(now.getTime() + PLAN_DURATION_MS);
  await usersCol.findOneAndUpdate(
    { phoneNumber: userId },
    {
      $set: {
        plan,
        planActivatedAt: now,
        planExpiry:      plan === 'free' ? null : expiry,
        // Reset usage counters to zero at the start of the new plan period
        usageCounts: {
          letters:     0,
          merges:      0,
          cvBuilds:    0,
          periodStart: now
        }
      }
    },
    { upsert: false }
  );
  return expiry;
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
    const db          = client.db('cverve');
    const pendingCol  = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');
    const usersCol    = db.collection('users');

    // ── list ──────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const pending = await pendingCol
        .find({ status: 'pending' })
        .sort({ submittedAt: -1 })
        .limit(100)
        .toArray();
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, pending })
      };
    }

    // ── verify ────────────────────────────────────────────────────────────────
    // entry shape: { paymentId, amount, plan }
    // `plan` is required: admin must select which plan to activate for this payment.
    if (action === 'verify') {
      const { entries } = body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'entries array is required' }) };
      }

      const results = [];

      for (const entry of entries) {
        const entryId  = String(entry.paymentId || '').trim().toLowerCase();
        const entryAmt = parseFloat(String(entry.amount || '').replace(/[^\d.]/g, ''));
        const entryPlan = String(entry.plan || '').toLowerCase().trim();

        // ── Validate entry fields ────────────────────────────────────────────
        if (!entryId) {
          results.push({ paymentId: entryId, status: 'skipped', reason: 'Empty payment ID' });
          continue;
        }
        if (isNaN(entryAmt)) {
          results.push({ paymentId: entryId, status: 'skipped', reason: 'Invalid amount' });
          continue;
        }
        if (!VALID_PLANS.includes(entryPlan)) {
          results.push({ paymentId: entryId, status: 'skipped', reason: `Invalid plan "${entryPlan}". Must be: free, basic, or pro.` });
          continue;
        }

        // ── Verify price matches plan (soft check — admin can override) ───────
        // We warn in the result but still allow if admin confirmed via the UI
        const expectedPrice = PLAN_PRICES[entryPlan];
        const priceMismatch = expectedPrice > 0 && Math.abs(entryAmt - expectedPrice) > 1;

        // ── Find pending payment ─────────────────────────────────────────────
        const pending = await pendingCol.findOne(
          { paymentId: entryId, status: 'pending' },
          { collation: { locale: 'en', strength: 2 } }
        );

        if (!pending) {
          results.push({ paymentId: entryId, status: 'not_found', reason: 'No pending payment found with this ID' });
          continue;
        }

        if (Math.abs(pending.amount - entryAmt) > 1) {
          results.push({
            paymentId: entryId,
            status:    'amount_mismatch',
            reason:    `Submitted amount ${entryAmt} does not match recorded amount ${pending.amount}`
          });
          continue;
        }

        // ── Move to verified payments ────────────────────────────────────────
        await verifiedCol.insertOne({
          paymentId:     pending.paymentId,
          userId:        pending.userId,
          amount:        pending.amount,
          plan:          entryPlan,
          receiverName:  pending.receiverName  || null,
          paymentMethod: pending.paymentMethod || 'unknown',
          verifiedAt:    new Date(),
          submittedAt:   pending.submittedAt
        });

        await pendingCol.deleteOne({ _id: pending._id });

        // ── Activate plan on user document ───────────────────────────────────
        const planExpiry = await activatePlan(usersCol, pending.userId, entryPlan);

        // ── Notify user ──────────────────────────────────────────────────────
        await writeNotification(usersCol, pending.userId, {
          type:      'plan_activated',
          plan:      entryPlan,
          amount:    pending.amount,
          paymentId: pending.paymentId,
          expiry:    entryPlan !== 'free' ? planExpiry : null,
        });

        results.push({
          paymentId:   entryId,
          status:      'verified',
          userId:      pending.userId,
          amount:      pending.amount,
          plan:        entryPlan,
          planExpiry:  entryPlan !== 'free' ? planExpiry : null,
          ...(priceMismatch ? { warning: `Amount ${entryAmt} ETB differs from standard ${entryPlan} price ${expectedPrice} ETB` } : {})
        });
      }

      const verifiedCount = results.filter(r => r.status === 'verified').length;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, results, verifiedCount })
      };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    if (action === 'reject') {
      const { paymentId } = body;
      if (!paymentId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'paymentId is required' }) };
      }

      const pid     = String(paymentId).trim().toLowerCase();
      const pending = await pendingCol.findOne(
        { paymentId: pid, status: 'pending' },
        { collation: { locale: 'en', strength: 2 } }
      );

      if (!pending) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found with that ID' }) };
      }

      await pendingCol.deleteOne({ _id: pending._id });

      await writeNotification(usersCol, pending.userId, {
        type:      'payment_rejected',
        amount:    pending.amount,
        paymentId: pending.paymentId
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `Payment ${paymentId} has been rejected and removed.`
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-verify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};