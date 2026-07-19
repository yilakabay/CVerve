// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify' | 'reject', entries?, paymentId? }
//
// Manual review path — used when a payment wasn't auto-resolved by SMS detection
// within 30 minutes and the user clicked "Report" on it.
//
// 'verify' entries now only need { paymentId, amount } — the admin checks their
// own bank statement/app for the real amount and enters it; the plan tier is
// then resolved automatically using the exact same rules as receive-sms.js:
//   < 199 ETB            → rejected, nothing activated, full refund-eligible
//   199 ETB – 398.99 ETB → Basic activated, excess above 199 refund-eligible
//   >= 399 ETB           → Pro activated,   excess above 399 refund-eligible
//
// 'reject' is for when the transaction ID itself is invalid/fake — no payment
// was actually made, so there's nothing to refund.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan tier resolution — kept identical to receive-sms.js ──────────────────
const PLAN_PRICES = { basic: 199, pro: 399 };
function resolvePlanTier(amount) {
  if (amount < 199) return null;
  if (amount < 399) return 'basic';
  return 'pro';
}
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
      { $push: { notifications: { id: crypto.randomUUID(), read: false, ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
  }
}

async function activatePlan(usersCol, userId, plan) {
  const now    = new Date();
  const expiry = new Date(now.getTime() + PLAN_DURATION_MS);
  await usersCol.updateOne(
    { phoneNumber: userId },
    {
      $set: {
        plan,
        planActivatedAt: now,
        planExpiry:      expiry,
        usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
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
    // Reported (30+ min, user clicked Report) entries surface first.
    if (action === 'list') {
      const pending = await pendingCol
        .find({ status: 'pending' })
        .sort({ reported: -1, submittedAt: 1 })
        .limit(100)
        .toArray();
      return { statusCode: 200, body: JSON.stringify({ success: true, pending }) };
    }

    // ── verify ────────────────────────────────────────────────────────────────
    // entry shape: { paymentId, amount } — plan is resolved automatically from amount.
    if (action === 'verify') {
      const { entries } = body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'entries array is required' }) };
      }

      const results = [];

      for (const entry of entries) {
        const entryId  = String(entry.paymentId || '').trim().toLowerCase();
        const entryAmt = parseFloat(String(entry.amount || '').replace(/[^\d.]/g, ''));

        if (!entryId) { results.push({ paymentId: entryId, status: 'skipped', reason: 'Empty payment ID' }); continue; }
        if (isNaN(entryAmt) || entryAmt <= 0) { results.push({ paymentId: entryId, status: 'skipped', reason: 'Invalid amount' }); continue; }

        const pending = await pendingCol.findOne({ paymentId: entryId, status: 'pending' }, { collation: { locale: 'en', strength: 2 } });
        if (!pending) { results.push({ paymentId: entryId, status: 'not_found', reason: 'No pending payment found with this ID' }); continue; }

        const plan = resolvePlanTier(entryAmt);

        if (!plan) {
          // Amount too low — reject, nothing activated, full refund-eligible
          await verifiedCol.insertOne({
            paymentId: pending.paymentId, userId: pending.userId, amount: entryAmt, plan: null,
            status: 'rejected_low_amount', paymentMethod: pending.paymentMethod || 'unknown',
            resolvedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_manual'
          });
          await pendingCol.deleteOne({ _id: pending._id });
          await writeNotification(usersCol, pending.userId, {
            type: 'payment_rejected', amount: entryAmt, paymentId: pending.paymentId,
            refundEligible: true, refundAmount: entryAmt
          });
          results.push({ paymentId: entryId, status: 'rejected_low_amount', userId: pending.userId, amount: entryAmt });
          continue;
        }

        const tierPrice = PLAN_PRICES[plan];
        const excess     = Math.round((entryAmt - tierPrice) * 100) / 100;

        await verifiedCol.insertOne({
          paymentId: pending.paymentId, userId: pending.userId, amount: entryAmt, plan, tierPrice, excess,
          paymentMethod: pending.paymentMethod || 'unknown', verifiedAt: new Date(),
          submittedAt: pending.submittedAt, resolvedBy: 'admin_manual'
        });
        await pendingCol.deleteOne({ _id: pending._id });

        const planExpiry = await activatePlan(usersCol, pending.userId, plan);

        await writeNotification(usersCol, pending.userId, {
          type: 'plan_activated', plan, amount: entryAmt, paymentId: pending.paymentId, expiry: planExpiry,
          refundEligible: excess > 0, refundAmount: excess > 0 ? excess : 0
        });

        results.push({ paymentId: entryId, status: 'verified', userId: pending.userId, amount: entryAmt, plan, planExpiry, excess });
      }

      const verifiedCount = results.filter(r => r.status === 'verified').length;
      return { statusCode: 200, body: JSON.stringify({ success: true, results, verifiedCount }) };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    // For invalid/fake transaction IDs — no payment actually occurred, no refund.
    if (action === 'reject') {
      const { paymentId } = body;
      if (!paymentId) return { statusCode: 400, body: JSON.stringify({ error: 'paymentId is required' }) };

      const pid     = String(paymentId).trim().toLowerCase();
      const pending = await pendingCol.findOne({ paymentId: pid, status: 'pending' }, { collation: { locale: 'en', strength: 2 } });
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found with that ID' }) };

      await pendingCol.deleteOne({ _id: pending._id });

      await writeNotification(usersCol, pending.userId, {
        type: 'payment_rejected', paymentId: pending.paymentId, invalidTransaction: true,
        refundEligible: false
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, message: `Payment ${paymentId} has been rejected and removed.` }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-verify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};