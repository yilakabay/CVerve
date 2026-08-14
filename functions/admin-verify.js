// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify-one' | 'reject', pendingId?, amountIssue?, reason? }
//
// Manual review path — used when a payment wasn't auto-resolved by SMS
// detection within 30 minutes and the user clicked "Report" on it, or for
// any pending payment the admin wants to resolve directly.
//
// The user always picks a plan (Basic or Pro) before paying — chosenPlan is
// stored on the pending record. This function NEVER activates a different
// plan than the one the user chose, regardless of how much they paid.
//
// 'verify-one' only works when the pending payment's amount actually covers
// its chosenPlan's price. If it doesn't, there's nothing to verify — only
// 'reject' applies.
//
// 'reject' has two shapes:
//   - amountIssue: true  → ONLY valid when the amount is under 49 ETB (can't
//     fund either plan). Sends the standard "amount too low" message with a
//     refund offered for the full amount.
//   - amountIssue: false/omitted → a free-text reason is required. No refund
//     is offered automatically — this covers every other rejection (admin
//     suspects the screenshot is fake, the payment never shows up on the
//     bank statement, chose Pro but paid less than Pro's price, etc). This
//     is a deliberate choice: offering an automatic refund on a payment the
//     admin doesn't actually trust would let a scammer collect money that
//     was never really sent.
//
// Matching is name + amount only, everywhere — no transaction ID is ever
// used for matching, only optionally stored on the pending record to block
// resubmission of the exact same payment.

const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan prices — kept identical across process-payment.js / receive-sms.js ──
const PLAN_PRICES = { basic: 49, pro: 79 };
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function computeVerifyOutcome(chosenPlan, amount) {
  const tierPrice = PLAN_PRICES[chosenPlan];
  if (amount < tierPrice) return { canVerify: false };
  const excess = Math.round((amount - tierPrice) * 100) / 100;
  const canUpgradeToPro = chosenPlan === 'basic' && excess >= PLAN_PRICES.pro;
  return { canVerify: true, tierPrice, excess, canUpgradeToPro };
}

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
      const pending = pendingDocs.map(p => {
        const outcome = computeVerifyOutcome(p.chosenPlan, p.claimedAmount);
        return {
          pendingId:            p._id.toString(),
          userId:                p.userId,
          amount:                p.claimedAmount,
          senderName:            p.claimedSenderName,
          chosenPlan:            p.chosenPlan,
          transactionId:         p.transactionId || null,
          paymentMethod:         p.paymentMethod,
          reported:              p.reported,
          submittedAt:           p.submittedAt,
          canVerify:             outcome.canVerify,
          isUniversallyInsufficient: p.claimedAmount < PLAN_PRICES.basic,
          amountIssueApplicable: !outcome.canVerify
        };
      });
      return { statusCode: 200, body: JSON.stringify({ success: true, pending }) };
    }

    // ── verify-one ────────────────────────────────────────────────────────────
    // Always activates exactly pending.chosenPlan — never a different tier.
    if (action === 'verify-one') {
      const { pendingId } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found. It may already have been resolved.' }) };

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
        verifiedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_manual',
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
        resolvedBy: 'admin_manual'
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, userId: pending.userId, amount: pending.claimedAmount, plan, planExpiry, excess: outcome.excess })
      };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    // The "amount issue" toggle applies whenever the payment couldn't be
    // verified for the chosen plan — i.e. amount < 49 (regardless of which
    // plan was chosen), OR chosenPlan is Pro and amount is 49–78.99 (enough
    // for Basic but not Pro). Same rule as computeVerifyOutcome.canVerify.
    //
    //   amountIssue: true  → standard "amount too low" message, full amount
    //     refund-eligible, and — if the amount is enough to cover Basic while
    //     Pro was chosen — an "Activate Basic" offer.
    //   amountIssue: false → admin-typed reason only, no refund/tip/upgrade
    //     buttons (covers suspected fraud / payment not on the bank statement
    //     / any other non-amount reason).
    if (action === 'reject') {
      const { pendingId, amountIssue, reason } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found' }) };

      const amountIssueApplicable = !computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount).canVerify;

      let finalReason, refundEligible, refundAmount, canActivateBasic = false;
      if (amountIssueApplicable && amountIssue === true) {
        if (pending.claimedAmount < PLAN_PRICES.basic) {
          finalReason = `Your payment of ${pending.claimedAmount} ETB is below the minimum amount required to activate a plan.`;
        } else {
          finalReason = `Your payment of ${pending.claimedAmount} ETB is not enough to activate the ${pending.chosenPlan} plan you selected.`;
        }
        refundEligible   = true;
        refundAmount     = pending.claimedAmount;
        canActivateBasic = pending.chosenPlan === 'pro' && pending.claimedAmount >= PLAN_PRICES.basic;
      } else {
        const trimmedReason = (reason || '').trim();
        if (!trimmedReason) {
          return { statusCode: 400, body: JSON.stringify({ error: 'A rejection reason is required.' }) };
        }
        finalReason    = trimmedReason;
        refundEligible = false;
        refundAmount   = 0;
      }

      await pendingCol.deleteOne({ _id: pending._id });

      await writeNotification(usersCol, pending.userId, {
        type: 'payment_rejected',
        amount: pending.claimedAmount,
        chosenPlan: pending.chosenPlan,
        reason: finalReason,
        refundEligible,
        refundAmount,
        canActivateBasic,
        basicActivationUsed: false,
        resolvedBy: 'admin_manual'
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Payment has been rejected and the user notified.' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-verify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};