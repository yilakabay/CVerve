// functions/send-otp.js
// POST body: { phoneNumber }
//
// Looks up the user's Telegram chat_id (stored when they shared their phone with the bot),
// generates a 6-digit OTP, stores it, then sends it via Telegram.
//
// FIX: If a valid OTP was already sent (not expired, already delivered), we return
// success immediately without generating/sending a new one. This prevents the
// autopoll from firing a second OTP when Telegram is linked right after the first send.

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

  const { phoneNumber } = body;

  if (!phoneNumber) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number is required' }) };
  }
  if (!/^(09|07)\d{8}$/.test(phoneNumber)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number must start with 09 or 07 and be 10 digits total' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Telegram bot not configured' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('otp_codes');
    const tgCol    = db.collection('telegram_chats');

    // Check if user already exists
    const existing = await usersCol.findOne({ phoneNumber });
    if (existing) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'An account with this phone number already exists. Please log in.' })
      };
    }

    // Rate-limit: max 3 OTPs per phone per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCount = await otpCol.countDocuments({ phoneNumber, createdAt: { $gte: tenMinutesAgo } });
    if (recentCount >= 3) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes and try again.' })
      };
    }

    // Look up Telegram chat_id for this phone number
    const tgRecord = await tgCol.findOne({ phoneNumber });

    if (!tgRecord) {
      // User hasn't linked Telegram yet.
      // Store the OTP so the webhook can deliver it the moment they share their phone.
      const otp       = generateOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await otpCol.findOneAndUpdate(
        { phoneNumber },
        { $set: { phoneNumber, otp, expiresAt, verified: false, delivered: false, createdAt: new Date() } },
        { upsert: true }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          needsTelegram: true,
          message: 'Please open the bot and share your phone number first, then come back here.'
        })
      };
    }

    // ── Telegram IS linked — check if a valid OTP was already sent ──────────
    // This is the key fix: the autopoll calls send-otp again after the user
    // shares their phone. If we already sent an OTP that hasn't expired, we
    // just return success without sending a second one.
    const existingOtp = await otpCol.findOne({ phoneNumber, verified: false });
    if (existingOtp && new Date() < new Date(existingOtp.expiresAt) && existingOtp.delivered) {
      console.log(`OTP already delivered for ${phoneNumber}, skipping duplicate send`);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Verification code already sent to your Telegram!' })
      };
    }

    // Generate and send a fresh OTP
    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await otpCol.findOneAndUpdate(
      { phoneNumber },
      { $set: { phoneNumber, otp, expiresAt, verified: false, delivered: false, createdAt: new Date() } },
      { upsert: true }
    );

    // Send OTP via Telegram
    const result = await httpsPost(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: tgRecord.chatId,
        text: `🔐 *Your CVerve verification code is:*\n\n\`${otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`,
        parse_mode: 'Markdown'
      }
    );

    if (!result.ok) {
      console.error('Telegram sendMessage failed:', result);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Failed to send Telegram message. Please try again.' })
      };
    }

    // Mark as delivered so autopoll won't send again
    await otpCol.updateOne({ phoneNumber }, { $set: { delivered: true } });

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