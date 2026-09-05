// functions/telegram-webhook.js
//
// Set webhook once by visiting:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-site>/.netlify/functions/telegram-webhook
//
// Anti-fraud: each Telegram user ID (tgUserId) can only ever be linked to ONE
// CVcase account. A person with 10 phone numbers still only has one Telegram
// identity, so they can only register once.
//
// Keyboard behavior:
//   - NOT linked yet  → a reply keyboard below the input bar with ONE button:
//     "Share my phone number" (request_contact). Telegram only supports
//     request_contact inside a reply keyboard, not an inline one, so this
//     button cannot be moved into the chat itself — that's a Telegram
//     platform limitation, not a choice made here.
//   - Already linked  → the reply keyboard below the input bar switches to a
//     single "Open CVcase App" button (a web_app button, supported inside a
//     reply keyboard since Bot API 6.1) — the share button is gone for good.
//     On top of that, every message the bot sends also carries its OWN
//     inline "Open CVcase App" button attached directly to that message
//     bubble (web_app buttons support this too). So once linked, the user
//     sees an Open App button in BOTH places: on every chat bubble, and
//     pinned below the typing bar.
//
// IMPORTANT Telegram platform limitation: a single sendMessage call can only
// carry ONE reply_markup — either an inline keyboard (attached to that
// message's bubble) or a reply keyboard (the persistent bar below the input),
// never both at once. So the reply keyboard can't be swapped from
// "Share phone" to "Open App" in the same call that also attaches the inline
// button. Instead, the very first time we detect a Telegram user is linked,
// we send one short extra message whose only job is to flip the reply
// keyboard to the Open App button; we record that in `telegram_chats.
// appKeyboardSet` so it only ever happens once per Telegram user — every
// message after that just uses the inline button, and the reply keyboard
// stays on Open App indefinitely without needing to be resent.

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// The app's live Mini App URL — tapping this button opens it directly inside
// Telegram without leaving the chat.
const CVCASE_APP_URL = 'https://cverve.netlify.app/app';

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
  // Every call site below passes the correct keyboard explicitly (share-only
  // reply keyboard vs inline app button) based on that user's actual linked
  // status at that point in the flow — falls back to the share-only keyboard
  // only if a call site somehow omits it, since that's the safer default for
  // an unknown state.
  payload.reply_markup = replyMarkup || shareOnlyKeyboard;
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

// ── Keyboards ────────────────────────────────────────────────────────────────
//   - resize_keyboard: true   → keyboard sizes itself neatly instead of full-height
//   - is_persistent: true     → keyboard stays pinned below the text input at
//     all times, never disappearing after one tap
// NOTE: Telegram does not support colored strokes/borders on keyboard buttons —
//   that is a limitation of the Telegram platform itself and cannot be changed
//   from the bot/webhook side. Likewise, request_contact buttons are only
//   valid in a reply keyboard (below the input bar) — Telegram does not allow
//   that button type inside an inline (in-message) keyboard.
const shareOnlyKeyboard = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  is_persistent: true
};

// Reply keyboard (below the input bar) shown once a user is linked. Replaces
// shareOnlyKeyboard permanently — see ensureAppReplyKeyboard() below for how
// the switch actually happens.
const appOnlyReplyKeyboard = {
  keyboard: [[{ text: '🚀 Open CVcase App', web_app: { url: CVCASE_APP_URL } }]],
  resize_keyboard: true,
  is_persistent: true
};

// Inline keyboard attached directly to a message bubble (used for every
// message once a user is linked, alongside the reply keyboard above).
const appOnlyKeyboard = {
  inline_keyboard: [[{ text: '🚀 Open CVcase App', web_app: { url: CVCASE_APP_URL } }]]
};

// Flips the persistent reply keyboard (below the input bar) from
// "Share my phone number" to "Open CVcase App", exactly once per Telegram
// user. Safe to call on every message from a linked user — it's a no-op
// (no extra message sent) once appKeyboardSet is already true.
async function ensureAppReplyKeyboard(botToken, chatId, tgUserId, tgCol) {
  const rec = await tgCol.findOne({ tgUserId });
  if (rec && rec.appKeyboardSet) return;
  await sendMessage(botToken, chatId,
    '🔓 You\'re all set — use the button below anytime to open the app.',
    appOnlyReplyKeyboard
  );
  await tgCol.updateOne({ tgUserId }, { $set: { appKeyboardSet: true } }, { upsert: true });
}

// Every "user is linked" message in this file should go through this instead
// of calling sendMessage(..., appOnlyKeyboard) directly — it guarantees the
// reply keyboard has actually been switched (see above) before attaching the
// inline button to this particular message.
async function sendAppMessage(botToken, chatId, tgUserId, tgCol, text) {
  await ensureAppReplyKeyboard(botToken, chatId, tgUserId, tgCol);
  await sendMessage(botToken, chatId, text, appOnlyKeyboard);
}

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
      // Check if this Telegram account is already linked to a CVcase account
      const existing = await tgCol.findOne({ tgUserId });
      if (existing && existing.phoneNumber) {
        const user = await usersCol.findOne({ phoneNumber: existing.phoneNumber });
        if (user) {
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `✅ You already have a CVcase account linked to this Telegram.\n\nPhone: \`${existing.phoneNumber}\`\n\nTap *Open CVcase App* below to get started.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      await sendMessage(botToken, chatId,
        `👋 *Welcome to CVcase!*\n\nTap the button below to share your phone number and verify your account.`,
        shareOnlyKeyboard
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── User shares phone contact ──────────────────────────────────────────────
    if (msg.contact) {
      // Security: make sure the contact is the user's own number, not someone else's
      if (String(msg.contact.user_id) !== String(msg.from.id)) {
        await sendMessage(botToken, chatId,
          `⚠️ Please share *your own* phone number using the button below.`,
          shareOnlyKeyboard
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
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `⛔ This Telegram account is already linked to a CVcase account (phone: \`${existingTgRecord.phoneNumber}\`).\n\nOne Telegram account = one CVcase account. Tap *Open CVcase App* below to use your existing account.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      // ── CHECK: Does this phone already have a CVcase account? ────────────
      // If yes, this is an EXISTING USER linking Telegram (e.g. for password reset).
      // We allow it — link their Telegram and deliver any pending OTP.
      const existingUser = await usersCol.findOne({ phoneNumber });
      if (existingUser) {
        // ── FRAUD CHECK 2b: Is this phone already linked to a DIFFERENT Telegram? ─
        const existingPhoneRecord = await tgCol.findOne({ phoneNumber });
        if (existingPhoneRecord && existingPhoneRecord.tgUserId !== tgUserId) {
          await sendMessage(botToken, chatId,
            `⛔ This phone number is already linked to a different Telegram account. If this is your number, please contact support.`,
            shareOnlyKeyboard
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
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `🔑 *Your CVcase password reset code is:*\n\n\`${pendingReset.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.\n\nIf you did not request a password reset, please ignore this message.`
          );
          return { statusCode: 200, body: 'OK' };
        }

        // Deliver any pending registration OTP (edge case)
        const pendingOtp = await otpCol.findOne({ phoneNumber, verified: false });
        if (pendingOtp && new Date() < new Date(pendingOtp.expiresAt)) {
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `🔐 *Your CVcase verification code is:*\n\n\`${pendingOtp.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`
          );
          return { statusCode: 200, body: 'OK' };
        }

        // No pending OTP — just confirm the link
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ *Telegram linked!*\n\nYour number \`${phoneNumber}\` is now connected to this Telegram account.\n\nTap *Open CVcase App* below to get started.`
        );
        return { statusCode: 200, body: 'OK' };
      }

      // ── NEW USER registration path ────────────────────────────────────────
      // (No existing account for this phone — proceed with registration flow)

      // FRAUD CHECK 3: Is this phone linked to a DIFFERENT Telegram?
      const existingPhoneRecord = await tgCol.findOne({ phoneNumber });
      if (existingPhoneRecord && existingPhoneRecord.tgUserId !== tgUserId) {
        await sendMessage(botToken, chatId,
          `⛔ This phone number is already linked to a different Telegram account. If this is your number, please contact support.`,
          shareOnlyKeyboard
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

      // Check for a pending registration OTP and send it immediately.
      // Phone sharing is done at this point either way, so the keyboard
      // switches to the Open App button (both inline and below the input
      // bar) from here on regardless of which branch runs.
      const pending = await otpCol.findOne({ phoneNumber, verified: false });
      if (pending && new Date() < new Date(pending.expiresAt)) {
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `🔐 *Your CVcase verification code is:*\n\n\`${pending.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`
        );
      } else {
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ *Phone number linked!*\n\nYour number \`${phoneNumber}\` is now connected to this Telegram account.\n\nWhen you register on CVcase, your verification code will be sent here.`
        );
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Any other message ─────────────────────────────────────────────────────
    // Look up whether this Telegram account is already linked to decide which
    // single button to show.
    const existingForOther = await tgCol.findOne({ tgUserId });
    const isLinked = !!(existingForOther && existingForOther.phoneNumber);
    if (isLinked) {
      await sendAppMessage(botToken, chatId, tgUserId, tgCol, `Tap *Open CVcase App* below to use the app.`);
    } else {
      await sendMessage(botToken, chatId,
        `Tap the button below to share your phone number and verify your account.`,
        shareOnlyKeyboard
      );
    }

  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'OK' };
};