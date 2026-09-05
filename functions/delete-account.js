// functions/delete-account.js
// POST body: { phoneNumber, otp }
//
// Verifies the deletion OTP then permanently removes personal data for this
// user:
//   - users
//   - user_profiles
//   - otp_codes / reset_otp_codes / delete_otp_codes
//   - reset_tokens
//   - pending_payments (still-pending ones)
//   (verified payments are kept for accounting records)
//
// ── Anti-abuse: what this intentionally does NOT delete ─────────────────────
// telegram_chats and usage_ledger are deliberately left alone. Deleting them
// used to be how a scammer reset their free-plan usage: delete the account,
// which wiped the Telegram↔phone link, freeing that Telegram identity to
// link a fresh phone number and register a brand new account with a zeroed
// usage counter. Now:
//   - usage_ledger (keyed by tgUserId) is never touched here at all — it's
//     the permanent lifetime-usage record create-user.js checks before
//     handing out a "fresh" quota.
//   - telegram_chats is kept too (so the tgUserId↔phoneNumber link survives),
//     but scrubbed of the non-essential personal fields (first name,
//     username, chat id) right below — only the identity linkage needed for
//     fraud/abuse prevention remains. Those fields get refreshed
//     automatically the next time this Telegram account messages the bot, so
//     nothing is lost if they come back legitimately.
// This is a deliberate, narrow exception to "permanently removes ALL data"
// for fraud-prevention purposes — worth a line in your privacy policy/ToS.

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

    // ── Delete personal data ───────────────────────────────────────────────────

    // 1. User account
    await db.collection('users').deleteOne({ phoneNumber });

    // 2. Stored profile
    await db.collection('user_profiles').deleteOne({ userId: phoneNumber });

    // 3. Telegram chat records — kept (see note at top), but scrubbed of
    // non-essential personal fields. tgUserId and phoneNumber stay so the
    // fraud/abuse-prevention checks in telegram-webhook.js and the usage
    // ledger in create-user.js keep working correctly if this person
    // registers again.
    const scrub = {
      $set:   { accountDeletedAt: new Date() },
      $unset: { firstName: '', username: '', chatId: '' }
    };
    await db.collection('telegram_chats').updateMany({ phoneNumber }, scrub);
    if (user.tgUserId) {
      await db.collection('telegram_chats').updateMany({ tgUserId: user.tgUserId }, scrub);
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
    //
    // Note: usage_ledger (db.collection('usage_ledger')) is intentionally
    // left completely untouched — see the comment at the top of this file.

    console.log(`Account deleted: ${phoneNumber} (tgUserId: ${user.tgUserId || 'none'}) — Telegram identity link retained for abuse prevention.`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Account permanently deleted.' })
    };

  } catch (err) {
    console.error('delete-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};