// Accepts transaction ID and amount directly from the user, validates, and stores as "pending".

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

  const { userId, paymentId, amount, paymentMethod } = body;

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

    // Check for duplicate
    const alreadyPending  = await pendingCol.findOne({ paymentId: trimmedPaymentId });
    const alreadyVerified = await verifiedCol.findOne({ paymentId: trimmedPaymentId });

    if (alreadyPending || alreadyVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This transaction ID has already been submitted or used. Please do not resubmit the same transaction.' })
      };
    }

    // Store as pending
    await pendingCol.insertOne({
      paymentId: trimmedPaymentId,
      userId,
      amount: numericAmount,
      paymentMethod: paymentMethod || 'unknown',
      status: 'pending',
      submittedAt: new Date()
    });

    console.log('Payment stored as pending:', trimmedPaymentId, 'amount:', numericAmount, 'user:', userId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        pending: true,
        message: 'Payment submitted. Awaiting admin verification (within 6 hours).',
        paymentId: trimmedPaymentId,
        amount: numericAmount
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