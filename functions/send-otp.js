// functions/send-otp.js
// POST body: { phoneNumber, checkOnly? }
//
// Used by the web login flow for BOTH new and returning users — there is no
// password anymore, so "log in" and "register" are the same action: prove
// you own this phone via a Telegram-delivered OTP. verify-otp.js decides
// whether to create a new account or just start a session, based on whether
// the phone already has one.
//
// If checkOnly === true: just checks whether this phone's Telegram chat_id
//   is linked yet, without generating or sending an OTP (used for polling
//   while the user is over in the bot sharing their phone).

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phoneNumber, checkOnly } = body;

  if (!phoneNumber) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number is required' }) };
  }
  if (!/^(09|07)\d{8}$/.test(phoneNumber)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number must start with 09 or 07 and be 10 digits total' }) };
  }

  try {
    await client.connect();
    const db     = client.db('cverve');
    const otpCol = db.collection('otp_codes');
    const tgCol  = db.collection('telegram_chats');

    // ── checkOnly mode: just report whether Telegram is linked, never send ──
    if (checkOnly) {
      const tgRecord = await tgCol.findOne({ phoneNumber });
      if (!tgRecord) {
        return { statusCode: 200, body: JSON.stringify({ success: false, needsTelegram: true }) };
      }
      return { statusCode: 200, body: JSON.stringify({ success: true, needsTelegram: false }) };
    }

    // ── Full send mode ────────────────────────────────────────────────────────
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Telegram bot not configured' }) };
    }

    // Rate-limit: max 3 OTPs per phone per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCount = await otpCol.countDocuments({ phoneNumber, createdAt: { $gte: tenMinutesAgo } });
    if (recentCount >= 3) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes and try again.' }) };
    }

    // Look up Telegram chat_id for this phone number
    const tgRecord = await tgCol.findOne({ phoneNumber });

    if (!tgRecord) {
      // Not linked yet — tell the client to send the user to the bot first.
      // No OTP generated/stored yet.
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          needsTelegram: true,
          message: 'Please open the bot and share your phone number first, then come back here.'
        })
      };
    }

    // Reuse an existing unexpired OTP if present — prevents double-OTP when
    // a poll fires right after the initial send-otp call already stored one.
    const existingOtp = await otpCol.findOne({ phoneNumber });
    let otp, expiresAt;
    if (existingOtp && !existingOtp.verified && new Date() < new Date(existingOtp.expiresAt)) {
      otp       = existingOtp.otp;
      expiresAt = existingOtp.expiresAt;
    } else {
      otp       = generateOtp();
      expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await otpCol.findOneAndUpdate(
        { phoneNumber },
        { $set: { phoneNumber, otp, expiresAt, verified: false, createdAt: new Date() } },
        { upsert: true }
      );
    }

    const result = await httpsPost(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: tgRecord.chatId,
        text: `🔐 *Your CVcase verification code is:*\n\n\`${otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`,
        parse_mode: 'Markdown'
      }
    );

    if (!result.ok) {
      console.error('Telegram sendMessage failed:', result);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to send Telegram message. Please try again.' }) };
    }

    console.log(`OTP sent via Telegram to chat_id ${tgRecord.chatId} for phone ${phoneNumber}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Verification code sent to your Telegram!' })
    };

  } catch (err) {
    console.error('send-otp error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};