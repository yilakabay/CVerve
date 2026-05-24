// functions/reset-password.js
// POST body: { phoneNumber, resetToken, newPassword, confirmPassword }
//
// Validates the reset token issued by verify-reset-otp, then updates the
// user's password in the users collection.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

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

  const { phoneNumber, resetToken, newPassword, confirmPassword } = body;

  if (!phoneNumber || !resetToken || !newPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number, reset token, and new password are required' }) };
  }
  if (newPassword !== confirmPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Passwords do not match' }) };
  }
  if (newPassword.length < 6) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters long' }) };
  }

  try {
    await client.connect();
    const db        = client.db('cverve');
    const usersCol  = db.collection('users');
    const tokensCol = db.collection('reset_tokens');
    const otpCol    = db.collection('reset_otp_codes');

    // Validate the reset token
    const tokenRecord = await tokensCol.findOne({ phoneNumber });

    if (!tokenRecord) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or expired reset session. Please start over.' }) };
    }
    if (tokenRecord.resetToken !== resetToken) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid reset token. Please start over.' }) };
    }
    if (new Date() > new Date(tokenRecord.expiresAt)) {
      await tokensCol.deleteOne({ phoneNumber });
      return { statusCode: 400, body: JSON.stringify({ error: 'Reset session expired. Please start over.' }) };
    }

    // Check user exists
    const user = await usersCol.findOne({ phoneNumber });
    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Account not found.' }) };
    }

    // Hash and save new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await usersCol.updateOne({ phoneNumber }, { $set: { password: hashedPassword, updatedAt: new Date() } });

    // Clean up token and OTP records
    await tokensCol.deleteOne({ phoneNumber });
    await otpCol.deleteOne({ phoneNumber });

    console.log(`Password reset for: ${phoneNumber}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Password reset successfully.' })
    };

  } catch (err) {
    console.error('reset-password error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};