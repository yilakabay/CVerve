// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify-one' | 'reject', pendingId?, amountIssue?, reason? }
//
// Manual review path — used when a payment wasn't auto-resolved by SMS
// detection within 30 minutes and the user clicked "Report" on it, or for
// any pending payment the admin wants to resolve directly.
//
// The user always picks a CT pack before paying (see lib/packs.js) — it is
// stored on the pending record as `chosenPlan` (field name kept for
// compatibility; it holds a pack id). This function NEVER credits a different
// pack than the one the user chose, regardless of how much they paid.
//
// 'verify-one' only works when the pending payment's amount actually covers
// the chosen pack's price. If it doesn't, there's nothing to verify — only
// 'reject' applies.
//
// 'reject' has two shapes:
//   - amountIssue: true  → valid when the amount doesn't cover the chosen
//     pack. Sends the standard "amount too low" message with a refund (or
//     tip) offered for the full amount.
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
//
// ── REVENUE MODEL (UPDATED) ──────────────────────────────────────────────
// Gross revenue (see admin-stats.js) now only ever counts a plan's TIER
// PRICE (49 for Basic, 79 for Pro) the moment it's verified — never the
// full amount paid. Any amount above the tier price ("excess") is NOT
// revenue yet. Instead it's written to a new `pending_revenue` collection
// as an outstanding balance. It only becomes real revenue if/when the user
// tips it (tip-payment.js) or uses it to upgrade to Pro
// (activate-pro-upgrade.js). If it's refunded instead (request-refund.js +
// manage-refunds.js), it's simply removed from pending_revenue with zero
// effect on revenue — because it was never counted as revenue in the first
// place.
//
// The same applies to a rejected payment where the admin explicitly flags
// "amount issue" (case: amount is genuine but too low to activate any
// plan) — that whole amount goes to pending_revenue too, since real money
// came in and the user might choose to tip it instead of asking for it
// back. A rejection for any OTHER reason (suspected fraud, etc.) does NOT
// touch pending_revenue at all — there's no refund/tip path for those.

const { MongoClient, ObjectId } = require('mongodb');
const { computeVerifyOutcome, creditTokens, MIN_PACK_PRICE, resolvePack } = require('./lib/packs');
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

// notification.id can be supplied by the caller (so it can be pre-linked to
// a pending_revenue entry created in the same request); otherwise a fresh
// one is generated here, same as before.
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

// Creates the pending_revenue entry that tracks an unresolved excess amount
// until it's tipped, used for an upgrade, or refunded away.
async function createPendingRevenue(pendingRevenueCol, { notificationId, userId, amount, sourceType, verifiedPaymentId }) {
  if (!(amount > 0)) return;
  await pendingRevenueCol.insertOne({
    notificationId,
    userId,
    amount,
    sourceType,          // 'verified_excess' | 'rejected_payment'
    verifiedPaymentId:   verifiedPaymentId || null,
    status:              'pending',
    createdAt:           new Date(),
    updatedAt:           new Date()
  });
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
    const db               = client.db('cverve');
    const pendingCol       = db.collection('pending_payments');
    const verifiedCol      = db.collection('payments');
    const usersCol         = db.collection('users');
    const pendingRevenueCol = db.collection('pending_revenue');

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
        const pk = resolvePack(p.chosenPlan);
        return {
          pendingId:            p._id.toString(),
          userId:                p.userId,
          amount:                p.claimedAmount,
          senderName:            p.claimedSenderName,
          chosenPlan:            pk ? pk.id : p.chosenPlan,
          packLabel:             pk ? pk.label : String(p.chosenPlan || ''),
          packPrice:             pk ? pk.price : null,
          transactionId:         p.transactionId || null,
          paymentMethod:         p.paymentMethod,
          reported:              p.reported,
          submittedAt:           p.submittedAt,
          canVerify:             outcome.canVerify,
          isUniversallyInsufficient: p.claimedAmount < MIN_PACK_PRICE,
          amountIssueApplicable: !outcome.canVerify
        };
      });
      return { statusCode: 200, body: JSON.stringify({ success: true, pending }) };
    }

    // ── verify-one ────────────────────────────────────────────────────────────
    // Always credits exactly the pack in pending.chosenPlan — never a different one.
    if (action === 'verify-one') {
      const { pendingId } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found. It may already have been resolved.' }) };

      const outcome = computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount);
      if (!outcome.canVerify) {
        return { statusCode: 400, body: JSON.stringify({ error: `This amount does not cover the pack the user chose. Reject it instead.` }) };
      }

      const pack = outcome.pack;
      await creditTokens(usersCol, pending.userId, pack.tokens);

      // Revenue-relevant: only tierPrice is ever "earned" immediately.
      // The insert below still stores the FULL amount on the payments doc
      // (needed for upgrade math / audit trail / refund linking) — but
      // admin-stats.js now sums `tierPrice`, not `amount`, for gross.
      const insertResult = await verifiedCol.insertOne({
        userId: pending.userId, amount: pending.claimedAmount, senderName: pending.claimedSenderName,
        plan: pack.id, tokens: pack.tokens, tierPrice: outcome.tierPrice, excess: outcome.excess,
        paymentMethod: pending.paymentMethod || 'unknown',
        transactionId: pending.transactionId || null,
        verifiedAt: new Date(), submittedAt: pending.submittedAt, resolvedBy: 'admin_manual',
        upgradeUsed: false
      });
      await pendingCol.deleteOne({ _id: pending._id });

      const notifId = crypto.randomUUID();

      // Excess (if any) becomes an outstanding pending_revenue balance —
      // NOT revenue yet — until tipped, used for a Pro upgrade, or refunded.
      await createPendingRevenue(pendingRevenueCol, {
        notificationId:    notifId,
        userId:            pending.userId,
        amount:            outcome.excess,
        sourceType:        'verified_excess',
        verifiedPaymentId: insertResult.insertedId.toString()
      });

      await writeNotification(usersCol, pending.userId, {
        id: notifId,
        type: 'plan_activated',   // (name kept for the app; it now means "CT added")
        plan: pack.id, tokens: pack.tokens, packLabel: pack.label, amount: pending.claimedAmount,
        excess: outcome.excess,
        refundEligible: outcome.excess > 0, refundAmount: outcome.excess,
        verifiedPaymentId: insertResult.insertedId.toString(),
        resolvedBy: 'admin_manual'
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, userId: pending.userId, amount: pending.claimedAmount, plan: pack.id, tokens: pack.tokens, packLabel: pack.label, excess: outcome.excess })
      };
    }

    // ── reject ────────────────────────────────────────────────────────────────
    // The "amount issue" toggle applies whenever the payment couldn't be
    // verified for the chosen pack (amount is below that pack's price).
    //
    //   amountIssue: true  → standard "amount too low" message, full amount
    //     refund-eligible (and tracked in pending_revenue, since it can be
    //     tipped instead of refunded).
    //   amountIssue: false → admin-typed reason only, no refund/tip buttons
    //     (covers suspected fraud / payment not on the bank statement / any
    //     other non-amount reason). Nothing is written to pending_revenue.
    if (action === 'reject') {
      const { pendingId, amountIssue, reason } = body;
      if (!pendingId) return { statusCode: 400, body: JSON.stringify({ error: 'pendingId is required' }) };

      let pending;
      try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId) }); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId' }) }; }
      if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'Pending payment not found' }) };

      const amountIssueApplicable = !computeVerifyOutcome(pending.chosenPlan, pending.claimedAmount).canVerify;

      let finalReason, refundEligible, refundAmount;
      if (amountIssueApplicable && amountIssue === true) {
        const pk = resolvePack(pending.chosenPlan);
        if (pending.claimedAmount < MIN_PACK_PRICE) {
          finalReason = `Your payment of ${pending.claimedAmount} ETB is below the minimum amount required to buy CT (${MIN_PACK_PRICE} ETB).`;
        } else {
          finalReason = `Your payment of ${pending.claimedAmount} ETB is not enough to buy the ${pk ? pk.label : 'CT'} pack you selected${pk ? ` (${pk.price} ETB)` : ''}.`;
        }
        refundEligible   = true;
        refundAmount     = pending.claimedAmount;
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

      const notifId = crypto.randomUUID();

      // This payment was never written to `payments` (it was rejected), so
      // it was never counted as revenue. If it's genuinely a real payment
      // that's just too small (amountIssue branch), it still goes into
      // pending_revenue as sourceType 'rejected_payment' — refunding it
      // later has zero revenue effect, but tipping it does add to revenue.
      if (refundEligible) {
        await createPendingRevenue(pendingRevenueCol, {
          notificationId:    notifId,
          userId:            pending.userId,
          amount:            refundAmount,
          sourceType:        'rejected_payment',
          verifiedPaymentId: null
        });
      }

      await writeNotification(usersCol, pending.userId, {
        id: notifId,
        type: 'payment_rejected',
        amount: pending.claimedAmount,
        chosenPlan: pending.chosenPlan,
        reason: finalReason,
        refundEligible,
        refundAmount,
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