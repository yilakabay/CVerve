// functions/create-user.js
// Called by verify-otp after OTP confirmed.
//
// ── No free access ─────────────────────────────────────────────────────────
// New accounts start with 0 CT. Nothing that uses AI works until the user
// tops up (browsing jobs, saving jobs and merging PDFs stay free because they
// use no AI). There is no gift to abuse by deleting and re-registering.
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { phoneNumber, password } = parsed;
  if (!phoneNumber || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number and password are required' })
    };
  }
  try {
    await client.connect();
    const db        = client.db('cverve');
    const usersCol  = db.collection('users');
    const tgCol     = db.collection('telegram_chats');

    // Check if user already exists
    const existingUser = await usersCol.findOne({ phoneNumber });
    if (existingUser) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'User already exists with this phone number' })
      };
    }

    // ── Resolve Telegram identity for this phone ─────────────────────────────
    // Should exist — registration is always preceded by sharing a phone
    // number to the bot, which creates this link before the OTP is even sent.
    const tgLink   = await tgCol.findOne({ phoneNumber });
    const tgUserId = tgLink ? tgLink.tgUserId : null;

    // New accounts always start with 0 CT (no free access).
    const startingTokens = 0;

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    await usersCol.insertOne({
      phoneNumber,
      password:       hashedPassword,
      tgUserId:       tgUserId || null,
      balance:        0,               // legacy ETB field — unused
      tokens:         startingTokens,  // CT balance (starts at 0)
      tokensMigrated: true,
      notifications:  [],
      createdAt:      new Date()
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true,
        phoneNumber,
        tokens:  startingTokens
      })
    };
  } catch (error) {
    console.error('create-user error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};