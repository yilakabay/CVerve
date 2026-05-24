// functions/delete-account.js
// POST body: { phoneNumber, otp }
//
// Verifies the deletion OTP then permanently removes ALL data for this user:
//   - users
//   - user_profiles
//   - telegram_chats (both tgUserId and phoneNumber indexed docs)
//   - otp_codes / reset_otp_codes / delete_otp_codes
//   - reset_tokens
//   - pending_payments (still-pending ones)
//   (verified payments are kept for accounting records)

const { MongoClient } = require('mongodb');

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
    const db = client.db('cverve');

    const otpCol = db.collection('delete_otp_codes');

    // ── Verify OTP ────────────────────────────────────────────────────────────
    const record = await otpCol.findOne({ phoneNumber });

    if (!record) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No confirmation code found. Please request a new one.' }) };
    }
    if (new Date() > new Date(record.expiresAt)) {
      await otpCol.deleteOne({ phoneNumber });
      return { statusCode: 400, body: JSON.stringify({ error: 'Code has expired. Please request a new one.' }) };
    }
    if (record.otp !== otp.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Incorrect code. Please check and try again.' }) };
    }

    // ── Confirm account still exists ──────────────────────────────────────────
    const user = await db.collection('users').findOne({ phoneNumber });
    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Account not found.' }) };
    }

    // ── Delete all user data ──────────────────────────────────────────────────

    // 1. User account
    await db.collection('users').deleteOne({ phoneNumber });

    // 2. Stored profile
    await db.collection('user_profiles').deleteOne({ userId: phoneNumber });

    // 3. Telegram chat records (indexed by both tgUserId and phoneNumber)
    await db.collection('telegram_chats').deleteMany({ phoneNumber });
    if (user.tgUserId) {
      await db.collection('telegram_chats').deleteMany({ tgUserId: user.tgUserId });
    }

    // 4. All OTP / token collections
    await db.collection('otp_codes').deleteOne({ phoneNumber });
    await db.collection('reset_otp_codes').deleteOne({ phoneNumber });
    await db.collection('delete_otp_codes').deleteOne({ phoneNumber });
    await db.collection('reset_tokens').deleteOne({ phoneNumber });

    // 5. Pending payments (unverified, so no funds have been credited)
    await db.collection('pending_payments').deleteMany({ userId: phoneNumber });

    // Note: verified payments (db.collection('payments')) are intentionally
    // kept for financial audit records but contain no sensitive personal data
    // beyond the phone number.

    console.log(`Account permanently deleted: ${phoneNumber} (tgUserId: ${user.tgUserId || 'none'})`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Account permanently deleted.' })
    };

  } catch (err) {
    console.error('delete-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};