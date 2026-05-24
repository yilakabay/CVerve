// functions/send-reset-otp.js
// POST body: { phoneNumber }
//
// Like send-otp but for password reset:
//   - Requires the user to ALREADY have an account (opposite of send-otp)
//   - Stores a reset OTP in reset_otp_codes collection
//   - Sends it via Telegram if the phone is linked, otherwise tells the client
//     to show the "open bot" step (needsTelegram: true)

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
  if (!/^(09|07)\d{8}$/.test(phoneNumber)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number must start with 09 or 07 and be 10 digits total' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('reset_otp_codes');
    const tgCol    = db.collection('telegram_chats');

    // User must exist to reset their password
    const user = await usersCol.findOne({ phoneNumber });
    if (!user) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No account found with this phone number.' })
      };
    }

    // Rate-limit: max 3 reset OTPs per phone per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCount = await otpCol.countDocuments({ phoneNumber, createdAt: { $gte: tenMinutesAgo } });
    if (recentCount >= 3) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Too many attempts. Please wait a few minutes and try again.' })
      };
    }

    // Look up Telegram chat_id for this phone number
    const tgRecord = await tgCol.findOne({ phoneNumber });

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Store the OTP
    await otpCol.findOneAndUpdate(
      { phoneNumber },
      { $set: { phoneNumber, otp, expiresAt, verified: false, createdAt: new Date() } },
      { upsert: true }
    );

    if (!tgRecord) {
      // Phone not linked to Telegram yet — tell client to show the "open bot" step
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          needsTelegram: true,
          message: 'Please open the bot and share your phone number first, then come back here.'
        })
      };
    }

    // Send reset OTP via Telegram
    const result = await httpsPost(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: tgRecord.chatId,
        text: `🔑 *Your CVerve password reset code is:*\n\n\`${otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.\n\nIf you did not request a password reset, please ignore this message.`,
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

    console.log(`Reset OTP sent via Telegram to chat_id ${tgRecord.chatId} for phone ${phoneNumber}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Reset code sent to your Telegram!' })
    };

  } catch (err) {
    console.error('send-reset-otp error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error. Please try again.' }) };
  }
};