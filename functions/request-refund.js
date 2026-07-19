// functions/request-refund.js
// POST body: { userId, password, paymentId, amount, bankName, accountFullName }
//
// Called when the user taps "Refund" on a payment_rejected or plan_activated
// (with excess) notification. Collects their bank details and creates a refund
// request for the admin to process manually from the Refunds tab.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const VALID_BANKS = ['CBE', 'Telebirr', 'CBEBirr'];

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, paymentId, amount, bankName, accountFullName } = body;

  if (!userId || !paymentId || amount === undefined || amount === null || !bankName || !accountFullName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId, paymentId, amount, bankName, and accountFullName are all required.' }) };
  }

  const numericAmount = parseFloat(String(amount).replace(/[^\d.]/g, ''));
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid refund amount.' }) };
  }

  if (!VALID_BANKS.includes(bankName)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bankName must be one of: CBE, Telebirr, CBEBirr.' }) };
  }

  const trimmedName = String(accountFullName).trim();
  if (trimmedName.length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter the full account holder name.' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const refundsCol = db.collection('refund_requests');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    const trimmedPaymentId = String(paymentId).trim().toLowerCase();

    // Prevent duplicate refund requests for the same payment
    const existing = await refundsCol.findOne({ paymentId: trimmedPaymentId, userId, status: { $ne: 'refunded' } });
    if (existing) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A refund request for this payment is already pending review.' }) };
    }

    await refundsCol.insertOne({
      id: crypto.randomUUID(),
      paymentId:       trimmedPaymentId,
      userId,
      amount:          numericAmount,
      bankName,
      accountFullName: trimmedName,
      status:          'pending',
      createdAt:        new Date()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Your refund request has been submitted. Our Payment Review Team will process it manually.' })
    };

  } catch (error) {
    console.error('request-refund error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};