// functions/process-payment.js
// POST body: { userId, sessionToken, amount, senderName, chosenPlan, transactionId?, paymentMethod?, checkOnly? }
//
// The user picks a CT top-up pack (see lib/packs.js) BEFORE paying. That
// choice is stored on the pending record and is the anchor for everything
// that happens next: what shows on the admin's Pending tab, whether a payment
// can be verified at all, and what a Verify/Reject notification says. The
// system always respects what the user chose; it never silently credits a
// different pack just because the amount happens to cover it (see
// receive-sms.js / admin-verify.js for the full decision logic).
//
// NOTE: the field is still called `chosenPlan` in the database and in the
// request body (kept so older data and admin screens keep working) — it now
// simply holds a PACK id such as 'ind_1m'.
//
// amount + senderName are REQUIRED — they are the only fields ever used for
// matching against the real bank SMS. Matching is name + amount only, for
// every payment method, with no fallback to any transaction ID.
//
// transactionId is OPTIONAL. When the screenshot happens to show one, it's
// stored purely to block the user from resubmitting the exact same payment
// again (anti-duplicate / anti-scam-resubmission) — it plays no role in
// matching or activation.
//
// This function's only job is to:
//   1. Record the pending payment (amount, senderName, chosenPlan, optional
//      transactionId, submittedAt).
//   2. Immediately send a "System" notification acknowledging receipt.
//   3. Support checkOnly to let the app poll pending/resolved status and decide
//      when to show the "Report" button (30+ minutes with no resolution).

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { checkSession } = require('./lib/session');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const { resolvePack, formatCT } = require('./lib/packs');
const { tryMatchExistingSms } = require('./receive-sms');

async function writeNotification(db, userId, notification) {
  try {
    await db.collection('users').updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { id: crypto.randomUUID(), read: false, ...notification, createdAt: new Date() } } }
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
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, sessionToken, amount, senderName, chosenPlan, transactionId, paymentMethod, checkOnly } = body;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required.' }) };
  }

  try {
    await client.connect();
    const db         = client.db('cverve');
    const usersCol   = db.collection('users');
    const pendingCol = db.collection('pending_payments');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (!checkSession(user, sessionToken)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session expired. Please log in again.' }) };
    }

    // ── checkOnly mode — used by the app to decide whether to show the Report button ──
    if (checkOnly) {
      const pending = await pendingCol.findOne({ userId, status: 'pending' });
      if (!pending) {
        return { statusCode: 200, body: JSON.stringify({ hasPending: false }) };
      }
      const ageMs        = Date.now() - new Date(pending.submittedAt).getTime();
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      return {
        statusCode: 200,
        body: JSON.stringify({
          hasPending:      true,
          pendingId:       pending._id.toString(),
          amount:          pending.claimedAmount,
          senderName:      pending.claimedSenderName,
          chosenPlan:      pending.chosenPlan,
          submittedAt:     pending.submittedAt,
          reported:        !!pending.reported,
          canReport:       ageMs >= THIRTY_MIN_MS && !pending.reported,
          minutesElapsed:  Math.floor(ageMs / 60000)
        })
      };
    }

    // ── Normal payment submission ──────────────────────────────────────────────
    const parsedAmount = Number(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A valid amount is required.' }) };
    }
    const trimmedSenderName   = senderName ? String(senderName).trim() : '';
    const trimmedTransactionId = transactionId ? String(transactionId).trim().toLowerCase() : null;
    // Telebirr's own transaction-confirmation screen (the payer's own history
    // view) never shows a sender name at all — there's no "From" field, only
    // "Transaction To: <receiver>" and a transaction number — confirmed from
    // a real screenshot the extraction AI correctly couldn't find a name on.
    // A transaction number is just as strong a matching signal (it's a
    // unique bank reference), so either one is accepted instead of requiring
    // senderName unconditionally.
    if (!trimmedSenderName && !trimmedTransactionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Sender name or a transaction number is required.' }) };
    }
    const chosenPack = resolvePack(chosenPlan);
    if (!chosenPack) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please choose a CT pack before paying.' }) };
    }

    const verifiedCol = db.collection('payments');

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'You already have a pending payment awaiting verification. Please wait until it is reviewed.' })
      };
    }

    // Duplicate check — ONLY when a transaction ID is present (anti-resubmission guard)
    if (trimmedTransactionId) {
      const alreadyPending  = await pendingCol.findOne({ transactionId: trimmedTransactionId }, { collation: { locale: 'en', strength: 2 } });
      const alreadyVerified = await verifiedCol.findOne({ transactionId: trimmedTransactionId }, { collation: { locale: 'en', strength: 2 } });
      if (alreadyPending || alreadyVerified) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'This payment has already been submitted. Please do not resubmit the same payment.' })
        };
      }
    }

    // ── Store as pending — final resolution happens via SMS detection or admin review ──
    const insertResult = await pendingCol.insertOne({
      userId,
      paymentMethod:     paymentMethod || 'unknown',
      status:            'pending',
      reported:          false,
      submittedAt:       new Date(),
      claimedAmount:     parsedAmount,
      claimedSenderName: trimmedSenderName,
      chosenPlan:        chosenPack.id,
      // Optional — present only when the screenshot happened to show one.
      // Used solely to block resubmission of this exact payment; never used
      // for matching against the SMS.
      transactionId:     trimmedTransactionId
    });

    // ── Catch the SMS-arrived-before-the-form case ──────────────────────────
    // The Android app forwards the bank SMS the instant it lands on the
    // phone, which can be (and in a confirmed real case, was) several
    // minutes BEFORE the user finishes filling in and submitting this form.
    // receive-sms.js's own auto-match only looks at pending_payments that
    // exist at the moment the SMS arrives, so an SMS that arrived early has
    // nothing to match yet and is left "waiting" — and until now, nothing
    // ever re-checked it once the matching pending payment showed up here.
    // This closes that gap from the payment side: if an already-logged,
    // still-unmatched SMS fits this payment (same amount, same sender name),
    // verify immediately instead of leaving both stuck until an admin
    // notices and resolves it by hand.
    let matchResult = { status: 'no_match' };
    try {
      matchResult = await tryMatchExistingSms(db, {
        _id:               insertResult.insertedId,
        userId,
        claimedAmount:     parsedAmount,
        claimedSenderName: trimmedSenderName,
        chosenPlan:        chosenPack.id,
        paymentMethod:     paymentMethod || 'unknown',
        transactionId:     trimmedTransactionId,
        submittedAt:       new Date()
      });
    } catch (e) {
      console.error('tryMatchExistingSms error:', e.message);
    }

    // Only send the generic "received, awaiting verification" notification
    // when it WASN'T just auto-verified above — verifyPendingPayment() (via
    // tryMatchExistingSms) already sends its own "plan_activated" notification,
    // and the pending_payments row it matched no longer exists to reference.
    if (matchResult.status !== 'verified') {
      await writeNotification(db, userId, {
        type:       'payment_received',
        pendingId:  insertResult.insertedId.toString(),
        amount:     parsedAmount,
        chosenPlan: chosenPack.id
      });
    }

    console.log(`Payment pending: user=${userId}, amount=${parsedAmount}, sender=${trimmedSenderName}, chosenPack=${chosenPack.id} (${formatCT(chosenPack.tokens)}), smsMatch=${matchResult.status}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:    true,
        pending:    true,
        message:    'We received your payment. Our system will review it and add your CT within a few minutes.',
        pendingId:  insertResult.insertedId.toString()
      })
    };

  } catch (error) {
    console.error('process-payment error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};