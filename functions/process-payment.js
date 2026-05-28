// Accepts transaction ID and amount directly from the user, validates, and stores as "pending".
// Also supports checkOnly=true to let the frontend check if the user has a pending payment
// without submitting a new one (used to show the warning immediately when the popup opens).

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function isValidReceiverAmount(amount) {
  return !isNaN(amount) && amount >= 100;
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

  const { userId, paymentId, amount, paymentMethod, checkOnly } = body;

  // ── checkOnly mode ────────────────────────────────────────────────────────
  if (checkOnly) {
    if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId is required for checkOnly.' }) };
    }
    try {
      await client.connect();
      const db = client.db('cverve');
      const pendingCol = db.collection('pending_payments');
      const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
      return {
        statusCode: 200,
        body: JSON.stringify({ hasPending: !!userHasPending })
      };
    } catch (error) {
      console.error('Check pending error:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' })
      };
    }
  }

  // ── Normal payment submission ─────────────────────────────────────────────
  if (!userId || !paymentId || amount === undefined || amount === null || amount === '') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Transaction ID and amount are required.' })
    };
  }

  const numericAmount = parseFloat(String(amount).replace(/[^\d.]/g, ''));

  if (!isValidReceiverAmount(numericAmount)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Amount must be at least 100 ETB. You entered: ${amount} ETB.` })
    };
  }

  const trimmedPaymentId = String(paymentId).trim();
  if (!trimmedPaymentId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Transaction ID cannot be empty.' })
    };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const pendingCol  = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');
    const smsCol      = db.collection('sms_detections');
    const usersCol    = db.collection('users');

    // Block if this user already has a pending payment
    const userHasPending = await pendingCol.findOne({ userId, status: 'pending' });
    if (userHasPending) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'You already have a pending payment awaiting verification. You cannot submit a new payment until it is verified.'
        })
      };
    }

    // Check for duplicate transaction ID
    const alreadyPending  = await pendingCol.findOne({ paymentId: trimmedPaymentId });
    const alreadyVerified = await verifiedCol.findOne({ paymentId: trimmedPaymentId });

    if (alreadyPending || alreadyVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This transaction ID has already been submitted or used. Please do not resubmit the same transaction.' })
      };
    }

    // ── Check if SMS already received for this transaction ID ─────────────────
    // This handles the case where the bank SMS arrived before the user submitted
    const existingSms = await smsCol.findOne({
      paymentId: trimmedPaymentId,
      status: { $in: ['extracted', 'waiting'] }
    });

    if (existingSms && existingSms.amount) {
      const amountMatches = Math.abs(existingSms.amount - numericAmount) <= 1;
      if (amountMatches) {
        // SMS already received and amounts match — auto verify instantly
        await verifiedCol.insertOne({
          paymentId:     trimmedPaymentId,
          userId,
          amount:        numericAmount,
          paymentMethod: paymentMethod || 'unknown',
          verifiedAt:    new Date(),
          submittedAt:   new Date(),
          autoVerified:  true,
          smsBody:       existingSms.smsBody
        });
        await usersCol.findOneAndUpdate(
          { phoneNumber: userId },
          { $inc: { balance: numericAmount } },
          { upsert: false }
        );
        await smsCol.updateOne(
          { _id: existingSms._id },
          { $set: { status: 'verified', matchedUserId: userId, resolvedAt: new Date() } }
        );
        return {
          statusCode: 200,
          body: JSON.stringify({
            success:      true,
            autoVerified: true,
            message:      '✓ Payment instantly verified! Your balance has been updated.',
            amount:       numericAmount
          })
        };
      }
    }

    // ── Store as pending (normal flow) ────────────────────────────────────────
    await pendingCol.insertOne({
      paymentId: trimmedPaymentId,
      userId,
      amount:        numericAmount,
      paymentMethod: paymentMethod || 'unknown',
      status:        'pending',
      submittedAt:   new Date()
    });

    console.log('Payment stored as pending:', trimmedPaymentId, 'amount:', numericAmount, 'user:', userId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        pending: true,
        message: 'Payment submitted. Awaiting admin verification (within 6 hours).',
        paymentId: trimmedPaymentId,
        amount:    numericAmount
      })
    };

  } catch (error) {
    console.error('Payment processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' })
    };
  }
};