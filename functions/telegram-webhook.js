// functions/telegram-webhook.js
//
// Set webhook once by visiting:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-site>/.netlify/functions/telegram-webhook
//
// Anti-fraud: each Telegram user ID (tgUserId) can only ever be linked to ONE
// CVcase account. A person with 10 phone numbers still only has one Telegram
// identity, so they can only register once.
//
// ── Identity model (no passwords) ────────────────────────────────────────
// A Telegram user is logged in just by being in their own Telegram — opening
// the Mini App calls telegram-auth.js with their signed initData, which logs
// them straight in if they already have an account, or sends them to
// onboarding.html if they don't. This webhook's job is only to: link
// tgUserId <-> phoneNumber when they share their contact, and hand out
// reset/delivery OTPs for the (separate, still-password-free) web login flow
// when a web user is verifying a phone that happens to be linked here.
//
// Keyboard behavior:
//   - NOT linked yet  → a reply keyboard below the input bar with ONE button:
//     "Share my phone number" (request_contact). Telegram only supports
//     request_contact inside a reply keyboard, not an inline one, so this
//     button cannot be moved into the chat itself — that's a Telegram
//     platform limitation, not a choice made here.
//   - Already linked  → the reply keyboard is removed, and instead the chat's
//     MENU BUTTON (the button next to the input bar, set via the separate
//     setChatMenuButton API — not a reply keyboard at all) becomes
//     "🚀 Open App", opening the Mini App directly. On top of that, every
//     message the bot sends also carries its OWN inline "Open CVcase App"
//     button attached directly to that message bubble. So once linked, the
//     user sees an Open App button in BOTH places: on every chat bubble, and
//     next to the input bar.
//
// Why the menu button instead of a second reply keyboard: reply keyboards
// are message-driven state — swapping "Share phone" for "Open App" means
// sending a different `keyboard` array on a later message, and several
// Telegram clients don't reliably refresh a VISIBLE reply keyboard once a
// request_contact button has been tapped (a client-side quirk, not something
// fixable from the bot side, even when explicitly sending remove_keyboard
// first). The chat menu button is a completely separate per-chat setting —
// once set, it can't be confused with, or get stuck showing, a reply
// keyboard, so it's the reliable way to guarantee an always-visible,
// never-hidden Open App button next to the input bar.

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

// Sets the chat menu button (next to the input bar) to open the Mini App
// directly. Independent of reply_markup entirely — see the note at the top
// of this file for why that independence is exactly what makes it reliable.
async function setAppMenuButton(botToken, chatId) {
  const res = await httpsPost(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
    chat_id: chatId,
    menu_button: { type: 'web_app', text: '🚀 Open App', web_app: { url: CVCASE_APP_URL } }
  });
  if (!res || res.ok !== true) {
    console.error('setChatMenuButton failed:', JSON.stringify(res));
  }
  return res;
}

async function sendMessage(botToken, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
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
const shareOnlyKeyboard = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  is_persistent: true
};

const appOnlyKeyboard = {
  inline_keyboard: [[{ text: '🚀 Open CVcase App', web_app: { url: CVCASE_APP_URL } }]]
};

async function ensureAppMenuButton(botToken, chatId, tgUserId, tgCol) {
  const rec = await tgCol.findOne({ tgUserId });
  if (rec && rec.appMenuButtonSet) return;
  await sendMessage(botToken, chatId, '✅ Phone number confirmed.', { remove_keyboard: true });
  await setAppMenuButton(botToken, chatId);
  await tgCol.updateOne({ tgUserId }, { $set: { appMenuButtonSet: true } }, { upsert: true });
}

async function sendAppMessage(botToken, chatId, tgUserId, tgCol, text) {
  await ensureAppMenuButton(botToken, chatId, tgUserId, tgCol);
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
      // Check if this Telegram account already has a CVcase account (found by
      // tgUserId directly now — no password/phone-account round trip needed).
      const existingUser = await usersCol.findOne({ tgUserId });
      if (existingUser) {
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ You already have a CVcase account linked to this Telegram.\n\nTap *Open CVcase App* below to get started — you're logged in automatically, no password needed.`
        );
        return { statusCode: 200, body: 'OK' };
      }

      await sendMessage(botToken, chatId,
        `👋 *Welcome to CVcase!*\n\nTap the button below to share your phone number. We'll use it to keep your account in sync with the web app — no password ever needed here.`,
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
      const existingTgRecord = await tgCol.findOne({ tgUserId });
      if (existingTgRecord && existingTgRecord.phoneNumber !== phoneNumber) {
        const prevUser = await usersCol.findOne({ tgUserId });
        if (prevUser) {
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `⛔ This Telegram account is already linked to a CVcase account (phone: \`${existingTgRecord.phoneNumber}\`).\n\nOne Telegram account = one CVcase account. Tap *Open CVcase App* below to use your existing account.`
          );
          return { statusCode: 200, body: 'OK' };
        }
      }

      // ── CHECK: Does this phone already have a CVcase account? ────────────
      // If yes, this is an EXISTING USER linking Telegram from the web (they
      // still verify web logins by OTP even though there's no password).
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
        await usersCol.updateOne({ phoneNumber }, { $set: { tgUserId } });

        // Deliver any pending web-login OTP immediately
        const pendingOtp = await otpCol.findOne({ phoneNumber, verified: false });
        if (pendingOtp && new Date() < new Date(pendingOtp.expiresAt)) {
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `🔐 *Your CVcase verification code is:*\n\n\`${pendingOtp.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`
          );
          return { statusCode: 200, body: 'OK' };
        }

        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ *Telegram linked!*\n\nYour number \`${phoneNumber}\` is now connected to this Telegram account.\n\nTap *Open CVcase App* below to get started.`
        );
        return { statusCode: 200, body: 'OK' };
      }

      // ── NEW USER — no account for this phone or this Telegram ID yet ────────
      // FRAUD CHECK 3: Is this phone linked to a DIFFERENT Telegram?
      const existingPhoneRecord = await tgCol.findOne({ phoneNumber });
      if (existingPhoneRecord && existingPhoneRecord.tgUserId !== tgUserId) {
        await sendMessage(botToken, chatId,
          `⛔ This phone number is already linked to a different Telegram account. If this is your number, please contact support.`,
          shareOnlyKeyboard
        );
        return { statusCode: 200, body: 'OK' };
      }

      // Store / update the tgUserId <-> phoneNumber mapping. No account or
      // OTP is created here — opening the Mini App is what creates the
      // account now (telegram-auth.js -> onboarding.html), and a web user
      // verifying this same phone would trigger their own OTP separately.
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

      const pending = await otpCol.findOne({ phoneNumber, verified: false });
      if (pending && new Date() < new Date(pending.expiresAt)) {
        // A web login OTP for this phone was already waiting — deliver it.
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `🔐 *Your CVcase verification code is:*\n\n\`${pending.otp}\`\n\nThis code expires in *10 minutes*. Do not share it with anyone.`
        );
      } else {
        // Ordinary case: brand-new Telegram user with no pending web login.
        // Point them at the app itself to finish setting up their account.
        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ *Phone number linked!*\n\nTap *Open CVcase App* below to finish setting up your account — it only takes a minute, and you're already signed in.`
        );
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Any other message ─────────────────────────────────────────────────────
    const existingUserForOther = await usersCol.findOne({ tgUserId });
    if (existingUserForOther) {
      await sendAppMessage(botToken, chatId, tgUserId, tgCol, `Tap *Open CVcase App* below to use the app.`);
    } else {
      const existingForOther = await tgCol.findOne({ tgUserId });
      const isLinked = !!(existingForOther && existingForOther.phoneNumber);
      if (isLinked) {
        await sendAppMessage(botToken, chatId, tgUserId, tgCol, `Tap *Open CVcase App* below to finish setting up your account.`);
      } else {
        await sendMessage(botToken, chatId,
          `Tap the button below to share your phone number and get started.`,
          shareOnlyKeyboard
        );
      }
    }

  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'OK' };
};