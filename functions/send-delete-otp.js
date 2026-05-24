// functions/send-delete-otp.js
// POST body: { phoneNumber }
//
// Sends a Telegram OTP to confirm account deletion.
// User must already exist and already have Telegram linked (they're logged in,
// so both are guaranteed — but we check defensively).

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('delete_otp_codes');
    const tgCol    = db.collection('telegram_chats');

    // Confirm account exists
    const user = await usersCol.findOne({ phoneNumber });
    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Account not found.' }) };
    }

    // Rate-limit: max 3 per phone per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCount = await otpCol.countDocuments({ phoneNumber, createdAt: { $gte: tenMinutesAgo } });
    if (recentCount >= 3) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Too many attempts. Please wait a few minutes.' })
      };
    }

    // Look up Telegram chat
    const tgRecord = await tgCol.findOne({ phoneNumber });
    if (!tgRecord) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No Telegram account linked to this phone. Please contact support.' })
      };
    }

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await otpCol.findOneAndUpdate(
      { phoneNumber },
      { $set: { phoneNumber, otp, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );

    const result = await httpsPost(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: tgRecord.chatId,
        text: `⚠️ *CVerve Account Deletion Request*\n\nYour confirmation code is:\n\n\`${otp}\`\n\nThis code expires in *10 minutes*.\n\n*If you did not request this, ignore this message — your account is safe.*`,
        parse_mode: 'Markdown'
      }
    );

    if (!result.ok) {
      console.error('Telegram sendMessage failed:', result);
      return { statusCode: 502, body: JSON.stringify({ error: 'Failed to send Telegram message. Please try again.' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Confirmation code sent to your Telegram.' })
    };

  } catch (err) {
    console.error('send-delete-otp error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};