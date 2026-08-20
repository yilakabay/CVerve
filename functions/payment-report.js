// functions/payment-report.js
//
// THREE actions live in this one function now:
//
// 1) USER REPORT (no `action` field, or action:'report')
//    POST body: { userId, password, pendingId }
//    Called when the user taps "Report" on the account page — shown only
//    once a payment has been pending 30+ minutes with no automatic
//    resolution from SMS detection. Flags the pending_payments doc so it
//    surfaces in the admin's Reports tab.
//
// 2) ADMIN LIST (action:'list')
//    POST body: { token, action: 'list' }
//    Returns every pending_payments doc that has been reported, for the
//    admin Reports tab.
//
// 3) ADMIN RESPOND (action:'respond')
//    POST body: { token, action: 'respond', reportId, decision: 'verify' | 'reject', reason? }
//    reportId is the pending_payments doc's _id (same value shown as
//    r._id in the Reports tab). 'verify' activates the user's chosenPlan
//    exactly as admin-verify.js does. 'reject' requires a reason and does
//    NOT auto-offer a refund (matches the Reports tab UI, which only
//    collects a free-text reason, no amount-issue toggle).
//
// Matching throughout this system is by sender name + amount only — never
// a transaction ID.

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const PLAN_PRICES = { basic: 49, pro: 79 };
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

function computeVerifyOutcome(chosenPlan, amount) {
  const tierPrice = PLAN_PRICES[chosenPlan];
  if (amount < tierPrice) return { canVerify: false };
  const excess = Math.round((amount - tierPrice) * 100) / 100;
  const canUpgradeToPro = chosenPlan === 'basic' && amount >= PLAN_PRICES.pro;
  return { canVerify: true, tierPrice, excess, canUpgradeToPro };
}

function tierLabelForAge(reportedAt) {
  const ageMs = Date.now() - new Date(reportedAt).getTime();
  const hour  = 60 * 60 * 1000;
  if (ageMs >= 7 * 24 * hour) return '1week';
  if (ageMs >= 72 * hour)     return '72hr';
  if (ageMs >= hour)          return '1hr';
  return '30min';
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const action = body.action || 'report';

  try {
    await client.connect();
    const db         = client.db('cverve');
    const usersCol    = db.collection('users');
    const pendingCol  = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');

    // ── ADMIN: list reported pending payments ────────────────────────────
    if (action === 'list') {
      if (!verifyToken(body.token)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
      }
      const docs = await pendingCol
        .find({ status: 'pending', reported: true })
        .sort({ reportedAt: 1 })
        .limit(100)
        .toArray();

      const reports = docs.map(p => ({
        _id:         p._id.toString(),
        paymentId:   p._id.toString(),
        userId:      p.userId,
        amount:      p.claimedAmount,
        senderName:  p.claimedSenderName,
        chosenPlan:  p.chosenPlan,
        reportedAt:  p.reportedAt,
        submittedAt: p.submittedAt,
        tierLabel:   tierLabelForAge(p.reportedAt)
      }));

      return { statusCode: 200, body: JSON.stringify({ success: true, reports }) };
    }

    // ── ADMIN: verify or reject a reported payment ────────────────────────
    if (action === 'respond') {
      if (!verifyToken(body.token)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
      }
      const { reportId, decision, reason } = body;
      if (!reportId || !decision) {
        return { statusCode: 400, body: JSON.stringify({ error: 'reportId and decision are required.' }) };
      }

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(reportId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid reportId.' }) }; }
      if (!pending) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Reported payment not found. It may already have been resolved.' }) };
      }

      if (decision === 'verify') {
        const outcome = computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount);
        if (!outcome.canVerify) {
          return { statusCode: 400, body: JSON.stringify({ error: `This amount does not cover the ${pending.chosenPlan} plan. Reject it instead.` }) };
        }

        const plan       = pending.chosenPlan;
        const planExpiry = await activatePlan(usersCol, pending.userId, plan);

        const insertResult = await verifiedCol.insertOne({
          userId: pending.userId, amount: pending.claimedAmount, senderName: pending.claimedSenderName,
          plan, tierPrice: outcome.tierPrice, excess: outcome.excess,
          paymentMethod: pending.paymentMethod || 'unknown',
          transactionId: pending.transactionId || null,
          verifiedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_report',
          upgradeUsed: false
        });
        await pendingCol.deleteOne({ _id: pending._id });

        await writeNotification(usersCol, pending.userId, {
          type: 'plan_activated', plan, amount: pending.claimedAmount,
          excess: outcome.excess,
          refundEligible: outcome.excess > 0, refundAmount: outcome.excess,
          canUpgradeToPro: outcome.canUpgradeToPro,
          verifiedPaymentId: insertResult.insertedId.toString(),
          expiry: planExpiry,
          resolvedBy: 'admin_report'
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, userId: pending.userId, amount: pending.claimedAmount, plan, planExpiry, excess: outcome.excess }) };
      }

      if (decision === 'reject') {
        const trimmedReason = (reason || '').trim();
        if (!trimmedReason) {
          return { statusCode: 400, body: JSON.stringify({ error: 'A rejection reason is required.' }) };
        }

        await pendingCol.deleteOne({ _id: pending._id });

        await writeNotification(usersCol, pending.userId, {
          type: 'payment_rejected',
          amount: pending.claimedAmount,
          chosenPlan: pending.chosenPlan,
          reason: trimmedReason,
          refundEligible: false,
          refundAmount: 0,
          canActivateBasic: false,
          basicActivationUsed: false,
          resolvedBy: 'admin_report'
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Payment has been rejected and the user notified.' }) };
      }

      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown decision.' }) };
    }

    // ── USER: submit a report (default action) ────────────────────────────
    const { userId, password, pendingId } = body;
    if (!userId || !pendingId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId and pendingId are required.' }) };
    }

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    let pending;
    try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId), userId, status: 'pending' }); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId.' }) }; }
    if (!pending) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found for your account. It may already have been resolved.' }) };
    }

    const ageMs = Date.now() - new Date(pending.submittedAt).getTime();
    if (ageMs < 30 * 60 * 1000) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please wait until 30 minutes have passed since your payment before reporting.' }) };
    }

    await pendingCol.updateOne(
      { _id: pending._id },
      { $set: { reported: true, reportedAt: new Date() } }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Your payment has been flagged for manual review by our Payment Review Team.' })
    };

  } catch (error) {
    console.error('payment-report error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};