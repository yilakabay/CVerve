// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify' | 'reject', entries?, pendingId? }
//
// Manual review path — used when a payment wasn't auto-resolved by SMS detection
// within 30 minutes and the user clicked "Report" on it.
//
// 'verify' entries are { name, amount } — the admin reads the sender's name and
// amount off their own bank SMS/app and types them in; the matching pending
// payment is found by exact amount + fuzzy name match (same rule as the
// automatic SMS path in receive-sms.js). No transaction ID is used anywhere
// in this matching — it never exists as a fallback.
//
// 'reject' takes a pendingId (the pending record's Mongo _id) rather than a
// transaction ID, since a screenshot may not have shown one.

const { MongoClient } = require('mongodb');
const { ObjectId } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan tier resolution — kept identical to receive-sms.js ──────────────────
const PLAN_PRICES = { basic: 49, pro: 79 };
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Name matching — identical rule to receive-sms.js ──────────────────────────
function normalizeNameTokens(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}
function nameSimilarity(a, b) {
  const tokensA = normalizeNameTokens(a);
  const tokensB = normalizeNameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter(t => setB.has(t)).length;
  const smaller = Math.min(tokensA.length, tokensB.length);
  return overlap / smaller;
}
const NAME_MATCH_THRESHOLD = 0.5;

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
      const pendingDocs = await pendingCol
        .find({ status: 'pending' })
        .sort({ reported: -1, submittedAt: 1 })
        .limit(100)
        .toArray();
      const pending = pendingDocs.map(p => ({
        pendingId:     p._id.toString(),
        userId:        p.userId,
        amount:        p.claimedAmount,
        senderName:    p.claimedSenderName,
        transactionId: p.transactionId || null,
        paymentMethod: p.paymentMethod,
        reported:      p.reported,
        submittedAt:   p.submittedAt,
        plan:          p.plan || null
      }));
      return { statusCode: 200, body: JSON.stringify({ success: true, pending }) };
    }

    // ── verify ────────────────────────────────────────────────────────────────
    // entry shape: { name, amount, plan } — matched by exact amount + fuzzy name,
    // exactly like the automatic SMS path. No transaction ID involved anywhere.
    if (action === 'verify') {
      const { entries } = body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'entries array is required' }) };
      }

      const results = [];

      for (const entry of entries) {
        const entryName = String(entry.name || '').trim();
        const entryAmt  = parseFloat(String(entry.amount || '').replace(/[^\d.]/g, ''));
        const entryPlan = entry.plan;

        if (!entryName) { results.push({ name: entryName, status: 'skipped', reason: 'Empty name' }); continue; }
        if (isNaN(entryAmt) || entryAmt <= 0) { results.push({ name: entryName, status: 'skipped', reason: 'Invalid amount' }); continue; }
        if (!entryPlan || !PLAN_PRICES[entryPlan]) { results.push({ name: entryName, status: 'skipped', reason: 'No plan selected' }); continue; }

        const candidates = await pendingCol.find({ status: 'pending', claimedAmount: entryAmt }).toArray();
        const scored = candidates
          .map(c => ({ c, score: nameSimilarity(entryName, c.claimedSenderName) }))
          .filter(x => x.score >= NAME_MATCH_THRESHOLD)
          .sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
          results.push({ name: entryName, status: 'not_found', amount: entryAmt, reason: 'No pending payment matches this name and amount' });
          continue;
        }
        if (scored.length > 1 && scored[0].score === scored[1].score) {
          results.push({ name: entryName, status: 'ambiguous', amount: entryAmt, reason: 'Multiple pending payments match this name and amount — resolve individually from the Pending tab' });
          continue;
        }

        const pending   = scored[0].c;
        const tierPrice = PLAN_PRICES[entryPlan];
        const excess     = Math.round((entryAmt - tierPrice) * 100) / 100;

        await verifiedCol.insertOne({
          userId: pending.userId, amount: entryAmt, senderName: pending.claimedSenderName,
          plan: entryPlan, tierPrice, excess,
          paymentMethod: pending.paymentMethod || 'unknown',
          transactionId: pending.transactionId || null,
          verifiedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_manual'
        });
        await pendingCol.deleteOne({ _id: pending._id });

        const planExpiry = await activatePlan(usersCol, pending.userId, entryPlan);

        await writeNotification(usersCol, pending.userId, {
          type: 'plan_activated', plan: entryPlan, amount: entryAmt, expiry: planExpiry,
          refundEligible: excess > 0, refundAmount: excess > 0 ? excess : 0
        });

        results.push({ name: entryName, status: 'verified', userId: pending.userId, amount: entryAmt, plan: entryPlan, planExpiry, excess });
      }

      const verifiedCount = results.filter(r => r.status === 'verified').length;
      return { statusCode: 200, body: JSON.stringify({ success: true, results, verifiedCount }) };
    }

    // ── verify-one ────────────────────────────────────────────────────────────
    // Used by the individual "✓ Verify" button on a specific pending card,
    // which already knows exactly which pending record it's acting on.
    if (action === 'verify-one') {
      const { pendingId, plan } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };
      if (!plan || !PLAN_PRICES[plan]) return { statusCode: 400, body: JSON.stringify({ error: 'A valid plan (basic or pro) is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found. It may already have been resolved.' }) };

      const tierPrice = PLAN_PRICES[plan];
      const excess     = Math.round((pending.claimedAmount - tierPrice) * 100) / 100;

      await verifiedCol.insertOne({
        userId: pending.userId, amount: pending.claimedAmount, senderName: pending.claimedSenderName,
        plan, tierPrice, excess,
        paymentMethod: pending.paymentMethod || 'unknown',
        transactionId: pending.transactionId || null,
        verifiedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_manual'
      });
      await pendingCol.deleteOne({ _id: pending._id });

      const planExpiry = await activatePlan(usersCol, pending.userId, plan);

      await writeNotification(usersCol, pending.userId, {
        type: 'plan_activated', plan, amount: pending.claimedAmount, expiry: planExpiry,
        refundEligible: excess > 0, refundAmount: excess > 0 ? excess : 0
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, userId: pending.userId, amount: pending.claimedAmount, plan, planExpiry, excess })
      };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    // For invalid/fake payments — no payment actually occurred, no refund.
    if (action === 'reject') {
      const { pendingId } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found' }) };

      await pendingCol.deleteOne({ _id: pending._id });

      await writeNotification(usersCol, pending.userId, {
        type: 'payment_rejected', invalidTransaction: true,
        refundEligible: false
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Payment has been rejected and removed.' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-verify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};