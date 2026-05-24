// functions/verify-otp.js
// POST body: { phoneNumber, otp, password, confirmPassword }
// Verifies the OTP then creates the user account if valid.

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
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { phoneNumber, otp, password, confirmPassword } = body;

  if (!phoneNumber || !otp || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number, OTP, and password are required' })
    };
  }

  if (password !== confirmPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Passwords do not match' }) };
  }

  if (password.length < 6) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters long' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('otp_codes');

    // Check OTP record
    const record = await otpCol.findOne({ phoneNumber });

    if (!record) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No OTP found for this number. Please request a new one.' })
      };
    }

    if (record.verified) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This OTP has already been used. Please request a new one.' })
      };
    }

    if (new Date() > new Date(record.expiresAt)) {
      await otpCol.deleteOne({ phoneNumber });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'OTP has expired. Please request a new one.' })
      };
    }

    if (record.otp !== otp.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Incorrect OTP. Please check and try again.' })
      };
    }

    // OTP is valid — check user doesn't already exist (race-condition guard)
    const existing = await usersCol.findOne({ phoneNumber });
    if (existing) {
      await otpCol.deleteOne({ phoneNumber });
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'An account with this phone number already exists.' })
      };
    }

    // Create the user
    const hashedPassword = await bcrypt.hash(password, 10);
    await usersCol.insertOne({
      phoneNumber,
      password: hashedPassword,
      balance: 0,
      createdAt: new Date()
    });

    // Mark OTP as used (then clean up)
    await otpCol.deleteOne({ phoneNumber });

    console.log(`User created: ${phoneNumber}`);

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true,
        message: 'Account created successfully! Please log in.',
        phoneNumber
      })
    };

  } catch (error) {
    console.error('verify-otp error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error. Please try again.' })
    };
  }
};