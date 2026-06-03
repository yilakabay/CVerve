// functions/process-payment.js
// Accepts transaction ID, amount, and optionally a planRequested field.
// Validates, then stores as "pending" for admin verification.
// Also supports checkOnly=true to check pending status without submitting.
//
// SESSION 3 CHANGES:
//   - Removed the 100 ETB minimum. Minimum is now the plan price (270 or 599).
//     Validation is: amount must be >= 1 ETB and match the plan price (±1 ETB tolerance).
//   - Added planRequested field stored in pending_payments document.
//   - Admin will read planRequested when verifying to activate the correct plan.
//   - Auto-verify path (SMS match) also stores planRequested and activates plan.
//   - All other logic (duplicate check, pending-block, checkOnly) unchanged.

const { MongoClient } = require('mongodb');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan prices ───────────────────────────────────────────────────────────────
const PLAN_PRICES = { basic: 270, pro: 599 };

// ── Activate a plan on the user document ─────────────────────────────────────
// Called only during auto-verify (SMS match). Admin-verify path calls subscribe-plan.
async function activatePlan(db, userId, plan) {
  const usersCol = db.collection('users');
  const expiry   = new Date();
  expiry.setMonth(expiry.getMonth() + 1); // 1-month subscription

  await usersCol.updateOne(
    { phoneNumber: userId },
    {
      $set: {
        plan:            plan,
        planExpiry:      expiry,
        planActivatedAt: new Date(),
        // Reset usage counters on every new subscription
        usageCounts: { letters: 0, pdfMerges: 0, cvBuilds: 0 }
      }
    },
    { upsert: false }
  );
}

// ── Write a notification to the user document ─────────────────────────────────
async function writeNotification(db, userId, notification) {
  try {
    await db.collection('users').updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { userId, paymentId, amount, paymentMethod, planRequested, checkOnly } = body;

  // ── checkOnly mode ────────────────────────────────────────────────────────
  if (checkOnly) {
    if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId is required for checkOnly.' }) };
    }
    try {
      await client.connect();
      const db         = client.db('cverve');
      const pendingCol = db.collection('pending_payments');
      const pending    = await pendingCol.findOne({ userId, status: 'pending' });
      return {
        statusCode: 200,
        body: JSON.stringify({
          hasPending: !!pending,
          payment: pending ? {
            paymentId:     pending.paymentId,
            amount:        pending.amount,
            planRequested: pending.planRequested || null,
            submittedAt:   pending.submittedAt
          } : null
        })
      };
    } catch (error) {
      console.error('checkOnly error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred.' }) };
    }
  }

  // ── Normal payment submission ──────────────────────────────────────────────
  if (!userId || !paymentId || amount === undefined || amount === null || amount === '') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'userId, paymentId, and amount are required.' })
    };
  }

  const numericAmount    = parseFloat(String(amount).replace(/[^\d.]/g, ''));
  const trimmedPaymentId = String(paymentId).trim().toLowerCase();

  if (isNaN(numericAmount) || numericAmount < 1) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Amount must be a positive number.' })
    };
  }

  if (!trimmedPaymentId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Transaction ID cannot be empty.' })
    };
  }

  // ── Validate planRequested and amount against plan price ──────────────────
  const validPlans = ['basic', 'pro'];
  if (planRequested && !validPlans.includes(planRequested)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid plan. Choose "basic" or "pro".' })
    };
  }

  if (planRequested) {
    const expectedPrice = PLAN_PRICES[planRequested];
    if (Math.abs(numericAmount - expectedPrice) > 1) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Amount ${numericAmount} ETB does not match the ${planRequested} plan price of ${expectedPrice} ETB.`
        })
      };
    }
  }

  try {
    await client.connect();
    const db           = client.db('cverve');
    const pendingCol   = db.collection('pending_payments');
    const verifiedCol  = db.collection('payments');
    const smsCol       = db.collection('sms_detections');

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'You already have a pending payment awaiting verification. Please wait until it is reviewed.'
        })
      };
    }

    // Check for duplicate transaction ID
    const alreadyPending  = await pendingCol.findOne(
      { paymentId: trimmedPaymentId },
      { collation: { locale: 'en', strength: 2 } }
    );
    const alreadyVerified = await verifiedCol.findOne(
      { paymentId: trimmedPaymentId },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (alreadyPending || alreadyVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'This transaction ID has already been submitted. Please do not resubmit the same transaction.'
        })
      };
    }

    // ── Check if SMS already received for this transaction ID (auto-verify) ──
    const existingSms = await smsCol.findOne({
      paymentId: trimmedPaymentId,
      status: { $in: ['extracted', 'waiting'] }
    });

    if (existingSms && existingSms.amount) {
      const amountMatches = Math.abs(existingSms.amount - numericAmount) <= 1;
      if (amountMatches) {
        // Insert into verified payments
        await verifiedCol.insertOne({
          paymentId:     trimmedPaymentId,
          userId,
          amount:        numericAmount,
          planRequested: planRequested || null,
          paymentMethod: paymentMethod || 'unknown',
          verifiedAt:    new Date(),
          submittedAt:   new Date(),
          autoVerified:  true,
          smsBody:       existingSms.smsBody
        });

        // Mark SMS as verified
        await smsCol.updateOne(
          { _id: existingSms._id },
          { $set: { status: 'verified', matchedUserId: userId, resolvedAt: new Date() } }
        );

        // Activate plan if requested, otherwise credit balance (legacy-safe)
        if (planRequested && PLAN_PRICES[planRequested]) {
          await activatePlan(db, userId, planRequested);
          await writeNotification(db, userId, {
            type:      'plan_activated',
            plan:      planRequested,
            amount:    numericAmount,
            paymentId: trimmedPaymentId
          });
        } else {
          // Fallback: credit balance for legacy-style top-ups
          await db.collection('users').updateOne(
            { phoneNumber: userId },
            { $inc: { balance: numericAmount } },
            { upsert: false }
          );
          await writeNotification(db, userId, {
            type:      'payment_verified',
            amount:    numericAmount,
            paymentId: trimmedPaymentId
          });
        }

        return {
          statusCode: 200,
          body: JSON.stringify({
            success:      true,
            autoVerified: true,
            message:      planRequested
              ? `✓ Payment verified! Your ${planRequested} plan is now active.`
              : '✓ Payment instantly verified! Your balance has been updated.',
            amount:        numericAmount,
            planRequested: planRequested || null
          })
        };
      }
    }

    // ── Store as pending (normal flow) ────────────────────────────────────────
    await pendingCol.insertOne({
      paymentId:     trimmedPaymentId,
      userId,
      amount:        numericAmount,
      planRequested: planRequested || null,
      paymentMethod: paymentMethod || 'unknown',
      status:        'pending',
      submittedAt:   new Date()
    });

    console.log(`Payment pending: ${trimmedPaymentId}, amount: ${numericAmount}, plan: ${planRequested || 'none'}, user: ${userId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:       true,
        pending:       true,
        message:       planRequested
          ? `Payment submitted. Your ${planRequested} plan will activate once verified (within 6 hours).`
          : 'Payment submitted. Awaiting admin verification (within 6 hours).',
        paymentId:     trimmedPaymentId,
        amount:        numericAmount,
        planRequested: planRequested || null
      })
    };

  } catch (error) {
    console.error('process-payment error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' })
    };
  }
};