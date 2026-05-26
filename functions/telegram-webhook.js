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

// ── CHANGE: Button is now always visible in the chat bar.
//   - removed one_time_keyboard: true  → button no longer disappears after one tap
//   - added persistent: true           → button stays pinned below the text input
//     at all times so users never have to type manually
// NOTE: Telegram does not support colored strokes/borders on keyboard buttons —
//   that is a limitation of the Telegram platform itself and cannot be changed
//   from the bot/webhook side.
const shareButton = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  persistent: true
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

  const chatId     = msg.chat.id;
  const tgUserId   = String(msg.from.id);
  const text       = (msg.text || '').trim();
  const tgUsername = msg.from.username || null;

  try {
    await client.connect();
    const db       = client.db('cverve');
    const tgCol    = db.collection('telegram_chats');
    const otpCol   = db.collection('otp_codes');
    const resetCol = db.collection('reset_otp_codes');
    const usersCol = db.collection('users');

    // ── /start ────────────────────────────────────────────────────────────────
    if (text === '/start' || text.startsWith('/start ')) {
      // Check if this Telegram account is already linked to a CVerve account
      const existing = await tgCol.findOne({ tgUserId });
      if (existing && existing.phoneNumber) {
        const user = await usersCol.findOne({ phoneNumber: existing.phoneNumber });
        if (user) {
          await sendMessage(botToken, chatId,
            `✅ You already have a CVerve account linked to this Telegram.\n\nPhone: \`${existing.phoneNumber}\`\n\nIf you need to reset your password, tap the button below to share your phone number again.`,
            shareButton
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
      // (Only blocks if the tgUserId is linked to a DIFFERENT phone number)
      const existingTgRecord = await tgCol.findOne({ tgUserId });
      if (existingTgRecord && existingTgRecord.phoneNumber !== phoneNumber) {
        const prevUser = await usersCol.findOne({ phoneNumber: existingTgRecord.phoneNumber });
        if (prevUser) {
          await sendMessage(botToken, chatId,
            `⛔ This Telegram account is already linked to a CVerve account (phone: \`${existingTgRecord.phoneNumber}\`).\n\nOne Telegram account = one CVerve account.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      // ── CHECK: Does this phone already have a CVerve account? ────────────
      // If yes, this is an EXISTING USER linking Telegram (e.g. for password reset).
      // We allow it — link their Telegram and deliver any pending OTP.
      const existingUser = await usersCol.findOne({ phoneNumber });
      if (existingUser) {
        // ── FRAUD CHECK 2b: Is this phone already linked to a DIFFERENT Telegram? ─
        const existingPhoneRecord = await tgCol.findOne({ phoneNumber });
        if (existingPhoneRecord && existingPhoneRecord.tgUserId !== tgUserId) {
          await sendMessage(botToken, chatId,
            `⛔ This phone number is already linked to a different Telegram account. If this is your number, please contact support.`
          );
          return { statusCode: 200, body: 'OK' };
        }

        // Link (or update) this existing user's Telegram
        await tgCol.findOneAndUpdate(
          { tgUserId },
          { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, username: tgUsername, updatedAt: new Date() } },
          { upsert: true }
        );
        await tgCol.findOneAndUpdate(
          { phoneNumber },
          { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, username: tgUsername, updatedAt: new Date() } },
          { upsert: true }
        );

        // Also update tgUserId on the user doc itself
        await usersCol.updateOne({ phoneNumber }, { $set: { tgUserId } });

        // Deliver any pending reset OTP immediately
        const pendingReset = await resetCol.findOne({ phoneNumber, verified: false });
        if (pendingReset && new Date() < new Date(pendingReset.expiresAt)) {
          await sendMessage(botToken, chatId,
            `🔑 *Your CVerve password reset code is:*\n\n\`${pendingReset.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.\n\nIf you did not request a password reset, please ignore this message.`,
            { remove_keyboard: true }
          );
          return { statusCode: 200, body: 'OK' };
        }

        // Deliver any pending registration OTP (edge case)
        const pendingOtp = await otpCol.findOne({ phoneNumber, verified: false });
        if (pendingOtp && new Date() < new Date(pendingOtp.expiresAt)) {
          await sendMessage(botToken, chatId,
            `🔐 *Your CVerve verification code is:*\n\n\`${pendingOtp.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`,
            { remove_keyboard: true }
          );
          return { statusCode: 200, body: 'OK' };
        }

        // No pending OTP — just confirm the link
        await sendMessage(botToken, chatId,
          `✅ *Telegram linked!*\n\nYour number \`${phoneNumber}\` is now connected to this Telegram account.\n\nYou can now use password reset and will receive verification codes here.`,
          { remove_keyboard: true }
        );
        return { statusCode: 200, body: 'OK' };
      }

      // ── NEW USER registration path ────────────────────────────────────────
      // (No existing account for this phone — proceed with registration flow)

      // FRAUD CHECK 3: Is this phone linked to a DIFFERENT Telegram?
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
        { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, username: tgUsername, updatedAt: new Date() } },
        { upsert: true }
      );
      await tgCol.findOneAndUpdate(
        { phoneNumber },
        { $set: { tgUserId, phoneNumber, chatId, firstName: tgFirstName, username: tgUsername, updatedAt: new Date() } },
        { upsert: true }
      );

      // Check for a pending registration OTP and send it immediately
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