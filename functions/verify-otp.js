// functions/verify-otp.js
// POST body: { phoneNumber, otp, password, confirmPassword }
//
// Verifies OTP then creates the user. Also enforces:
//   - One account per phone number
//   - One account per Telegram user ID (tgUserId)

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

  const { phoneNumber, otp, password, confirmPassword } = body;

  if (!phoneNumber || !otp || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number, OTP, and password are required' }) };
  }
  if (password !== confirmPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Passwords do not match' }) };
  }
  if (password.length < 6) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters long' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('otp_codes');
    const tgCol    = db.collection('telegram_chats');

    // ── Verify OTP ────────────────────────────────────────────────────────────
    const record = await otpCol.findOne({ phoneNumber });

    if (!record) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No OTP found for this number. Please request a new one.' }) };
    }
    if (record.verified) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This OTP has already been used. Please request a new one.' }) };
    }
    if (new Date() > new Date(record.expiresAt)) {
      await otpCol.deleteOne({ phoneNumber });
      return { statusCode: 400, body: JSON.stringify({ error: 'OTP has expired. Please request a new one.' }) };
    }
    if (record.otp !== otp.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Incorrect OTP. Please check and try again.' }) };
    }

    // ── Fraud checks ──────────────────────────────────────────────────────────

    // 1. Phone already registered?
    const existingByPhone = await usersCol.findOne({ phoneNumber });
    if (existingByPhone) {
      await otpCol.deleteOne({ phoneNumber });
      return { statusCode: 409, body: JSON.stringify({ error: 'An account with this phone number already exists.' }) };
    }

    // 2. Telegram user ID already used for another account?
    const tgRecord = await tgCol.findOne({ phoneNumber });
    if (tgRecord && tgRecord.tgUserId) {
      const existingByTg = await usersCol.findOne({ tgUserId: tgRecord.tgUserId });
      if (existingByTg) {
        await otpCol.deleteOne({ phoneNumber });
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This Telegram account has already been used to register. Only one account per person is allowed.'
          })
        };
      }
    }

    // ── Create user ───────────────────────────────────────────────────────────
    const hashedPassword = await bcrypt.hash(password, 10);
    await usersCol.insertOne({
      phoneNumber,
      password: hashedPassword,
      tgUserId: tgRecord?.tgUserId || null,   // store tgUserId on the user doc for future checks
      balance: 0,
      createdAt: new Date()
    });

    // Clean up OTP
    await otpCol.deleteOne({ phoneNumber });

    console.log(`User created: ${phoneNumber} (tgUserId: ${tgRecord?.tgUserId || 'unknown'})`);

    return {
      statusCode: 201,
      body: JSON.stringify({ success: true, message: 'Account created successfully! Please log in.', phoneNumber })
    };

  } catch (error) {
    console.error('verify-otp error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};