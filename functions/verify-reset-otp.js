// functions/verify-reset-otp.js
// POST body: { phoneNumber, otp }
//
// Verifies the reset OTP and returns a short-lived resetToken.
// The client then calls reset-password with that token + new password.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phoneNumber, otp } = body;

  if (!phoneNumber || !otp) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number and OTP are required' }) };
  }

  try {
    await client.connect();
    const db     = client.db('cverve');
    const otpCol = db.collection('reset_otp_codes');

    const record = await otpCol.findOne({ phoneNumber });

    if (!record) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No reset code found. Please request a new one.' }) };
    }
    if (record.verified) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This code has already been used. Please request a new one.' }) };
    }
    if (new Date() > new Date(record.expiresAt)) {
      await otpCol.deleteOne({ phoneNumber });
      return { statusCode: 400, body: JSON.stringify({ error: 'Code has expired. Please request a new one.' }) };
    }
    if (record.otp !== otp.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Incorrect code. Please check and try again.' }) };
    }

    // Mark OTP as used
    await otpCol.updateOne({ phoneNumber }, { $set: { verified: true } });

    // Issue a short-lived reset token (valid 15 minutes)
    const resetToken  = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

    // Store the token in a reset_tokens collection
    const tokensCol = db.collection('reset_tokens');
    await tokensCol.findOneAndUpdate(
      { phoneNumber },
      { $set: { phoneNumber, resetToken, expiresAt: tokenExpiry, createdAt: new Date() } },
      { upsert: true }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, resetToken })
    };

  } catch (err) {
    console.error('verify-reset-otp error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};