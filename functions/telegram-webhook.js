// functions/telegram-webhook.js
//
// Set webhook once by visiting:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-site>/.netlify/functions/telegram-webhook
//
// Anti-fraud: each Telegram user ID (tgUserId) can only ever be linked to ONE
// CVerve account. A person with 10 phone numbers still only has one Telegram
// identity, so they can only register once.

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

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

async function sendMessage(botToken, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return httpsPost(`https://api.telegram.org/bot${botToken}/sendMessage`, payload);
}

function normalizePhone(phone) {
  let p = phone.replace(/[\s\-]/g, '');
  if (p.startsWith('+2519')) return '09' + p.slice(5);
  if (p.startsWith('+2517')) return '07' + p.slice(5);
  if (p.startsWith('2519'))  return '09' + p.slice(4);
  if (p.startsWith('2517'))  return '07' + p.slice(4);
  return p;
}

const shareButton = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true
};

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'OK' };

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { statusCode: 200, body: 'OK' };

  let update;
  try { update = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'OK' }; }

  const msg = update.message;
  if (!msg) return { statusCode: 200, body: 'OK' };

  const chatId    = msg.chat.id;
  const tgUserId  = String(msg.from.id);   // Telegram's permanent unique user ID
  const text      = (msg.text || '').trim();

  try {
    await client.connect();
    const db       = client.db('cverve');
    const tgCol    = db.collection('telegram_chats');   // tgUserId/phone → chatId map
    const otpCol   = db.collection('otp_codes');
    const usersCol = db.collection('users');

    // ── /start ────────────────────────────────────────────────────────────────
    if (text === '/start' || text.startsWith('/start ')) {
      // Check if this Telegram account already has a CVerve account
      const existing = await tgCol.findOne({ tgUserId });
      if (existing && existing.phoneNumber) {
        const user = await usersCol.findOne({ phoneNumber: existing.phoneNumber });
        if (user) {
          await sendMessage(botToken, chatId,
            `✅ You already have a CVerve account linked to this Telegram.\n\nPhone: \`${existing.phoneNumber}\`\n\nPlease log in on the website.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      await sendMessage(botToken, chatId,
        `👋 *Welcome to CVerve!*\n\nTo verify your account, tap the button below to share your phone number.`,
        shareButton
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── User shares phone contact ──────────────────────────────────────────────
    if (msg.contact) {
      // Security: make sure the contact is the user's own number, not someone else's
      if (String(msg.contact.user_id) !== String(msg.from.id)) {
        await sendMessage(botToken, chatId,
          `⚠️ Please share *your own* phone number using the button below.`,
          shareButton
        );
        return { statusCode: 200, body: 'OK' };
      }

      const rawPhone    = msg.contact.phone_number;
      const phoneNumber = normalizePhone(rawPhone);
      const tgFirstName = msg.from.first_name || '';

      // ── FRAUD CHECK 1: Has this Telegram user ID already registered? ──────
      const existingTgRecord = await tgCol.findOne({ tgUserId });
      if (existingTgRecord && existingTgRecord.phoneNumber !== phoneNumber) {
        // This Telegram account previously linked a DIFFERENT phone number
        // Check if that previous phone has a real account
        const prevUser = await usersCol.findOne({ phoneNumber: existingTgRecord.phoneNumber });
        if (prevUser) {
          await sendMessage(botToken, chatId,
            `⛔ This Telegram account is already linked to a CVerve account (phone: \`${existingTgRecord.phoneNumber}\`).\n\nOne Telegram account = one CVerve account.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      // ── FRAUD CHECK 2: Has this phone number already been used? ───────────
      const existingUser = await usersCol.findOne({ phoneNumber });
      if (existingUser) {
        await sendMessage(botToken, chatId,
          `⚠️ This phone number already has a CVerve account. Please log in on the website instead.`
        );
        return { statusCode: 200, body: 'OK' };
      }

      // ── FRAUD CHECK 3: Is this phone number linked to a DIFFERENT Telegram? ─
      const existingPhoneRecord = await tgCol.findOne({ phoneNumber });
      if (existingPhoneRecord && existingPhoneRecord.tgUserId !== tgUserId) {
        await sendMessage(botToken, chatId,
          `⛔ This phone number is already linked to a different Telegram account. If this is your number, please contact support.`
        );
        return { statusCode: 200, body: 'OK' };
      }

      // All checks passed — store / update the mapping
      await tgCol.findOneAndUpdate(
        { tgUserId },
        { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, updatedAt: new Date() } },
        { upsert: true }
      );

      // Also index by phoneNumber for fast lookup in send-otp
      await tgCol.findOneAndUpdate(
        { phoneNumber },
        { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, updatedAt: new Date() } },
        { upsert: true }
      );

      // Check for a pending OTP for this phone and send it immediately
      const pending = await otpCol.findOne({ phoneNumber, verified: false });

      if (pending && new Date() < new Date(pending.expiresAt)) {
        await sendMessage(botToken, chatId,
          `🔐 *Your CVerve verification code is:*\n\n\`${pending.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`,
          { remove_keyboard: true }
        );
      } else {
        await sendMessage(botToken, chatId,
          `✅ *Phone number linked!*\n\nYour number \`${phoneNumber}\` is now connected to this Telegram account.\n\nWhen you register on CVerve, your verification code will be sent here.`,
          { remove_keyboard: true }
        );
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Any other message ─────────────────────────────────────────────────────
    await sendMessage(botToken, chatId,
      `To verify your CVerve account, please share your phone number using the button below.`,
      shareButton
    );

  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'OK' };
};