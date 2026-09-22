// functions/verify-otp.js
// POST body: { phoneNumber, otp }
//
// Verifies the OTP, then either:
//   - creates a brand-new account (first time this phone has ever verified), or
//   - logs the existing account in (returning web user)
// and issues a sessionToken either way — this now replaces password
// everywhere in the app as the "prove it's you" credential on every request.
//
// Still enforces: one account per phone number, one account per Telegram
// user ID (tgUserId).

const { MongoClient } = require('mongodb');
const { generateSessionToken } = require('./lib/session');

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

    // OTP is good — consume it either way.
    await otpCol.deleteOne({ phoneNumber });

    const tgRecord = await tgCol.findOne({ phoneNumber });
    const sessionToken = generateSessionToken();

    // ── Existing account → this is just a login ──────────────────────────────
    const existingUser = await usersCol.findOne({ phoneNumber });
    if (existingUser) {
      await usersCol.updateOne({ phoneNumber }, { $set: { sessionToken, lastLoginAt: new Date() } });

      const rawNotifs     = existingUser.notifications || [];
      const notifications = rawNotifs.map(n => ({
        ...n,
        id: n.id || null, type: n.type || '', amount: n.amount || 0,
        createdAt: n.createdAt || null, read: n.read === true
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          status:       'login',
          success:      true,
          sessionToken,
          phoneNumber,
          tokens:       existingUser.tokens || 0,
          balance:      existingUser.tokens || 0,
          notifications,
          unreadCount:  notifications.filter(n => !n.read).length
        })
      };
    }

    // ── Brand-new account ─────────────────────────────────────────────────────

    // Fraud check: Telegram user ID already used for another account?
    if (tgRecord && tgRecord.tgUserId) {
      const existingByTg = await usersCol.findOne({ tgUserId: tgRecord.tgUserId });
      if (existingByTg) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This Telegram account has already been used to register. Only one account per person is allowed.'
          })
        };
      }
    }

    await usersCol.insertOne({
      phoneNumber,
      tgUserId:       tgRecord?.tgUserId || null,
      sessionToken,
      balance:        0,      // legacy ETB field — unused
      tokens:         0,      // CT balance — starts at 0, no free access
      tokensMigrated: true,
      notifications:  [],
      createdAt:      new Date(),
      lastLoginAt:    new Date()
    });

    console.log(`User created: ${phoneNumber} (tgUserId: ${tgRecord?.tgUserId || 'unknown'})`);

    return {
      statusCode: 201,
      body: JSON.stringify({
        status:      'new',
        success:     true,
        sessionToken,
        phoneNumber,
        tokens:      0,
        balance:     0,
        notifications: [],
        unreadCount: 0
      })
    };

  } catch (error) {
    console.error('verify-otp error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};