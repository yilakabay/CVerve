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
const { callAI, logOperationalUsage, MODEL_IDS } = require('./lib/ai-billing');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// The app's live Mini App URL — tapping this button opens it directly inside
// Telegram without leaving the chat.
const CVcase_APP_URL = 'https://cverve.netlify.app/app';

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
    menu_button: { type: 'web_app', text: '🚀 Open App', web_app: { url: CVcase_APP_URL } }
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

// NOTE: this used to be `appOnlyKeyboard`, an inline keyboard swapped in as
// the message's reply_markup once a user was fully linked — which meant
// sending it REPLACED whatever reply keyboard (the "Share my phone number"
// button) was currently showing, since a message only carries one
// reply_markup. That's exactly why the share button kept disappearing after
// the first share: every later message silently dropped it. Per explicit
// request, the share button must stay visible forever, even after the
// account is fully linked — so every message's reply_markup is always
// `shareOnlyKeyboard` now (see sendMessage's own default), never swapped
// out for anything else, and "Open CVcase App" lives ONLY on the chat menu
// button (set once below, next to the input bar) which is a separate
// Telegram feature entirely and was already proven not to fight with the
// reply keyboard.

async function ensureAppMenuButton(botToken, chatId, tgUserId, tgCol) {
  const rec = await tgCol.findOne({ tgUserId });
  if (rec && rec.appMenuButtonSet) return;
  // Previously also sent a "✅ Phone number confirmed." message with
  // remove_keyboard:true right here — removed, since that's precisely what
  // made the share button vanish the moment a phone was linked. The menu
  // button is independent of any chat message, so it can just be set
  // silently.
  await setAppMenuButton(botToken, chatId);
  await tgCol.updateOne({ tgUserId }, { $set: { appMenuButtonSet: true } }, { upsert: true });
}

async function sendAppMessage(botToken, chatId, tgUserId, tgCol, text) {
  await ensureAppMenuButton(botToken, chatId, tgUserId, tgCol);
  await sendMessage(botToken, chatId, text, shareOnlyKeyboard);
}

// ── Community group AI support ──────────────────────────────────────────────
// Answers plain-text questions posted in the public CVcase Community group
// using Gemini (via the B.AI gateway, the cheapest model in this app's
// lineup that still handles Amharic well — see MODEL_RATES above). Requires
// this bot's Privacy Mode to be OFF in @BotFather, otherwise Telegram never
// forwards ordinary group messages to the webhook at all, only commands and
// @mentions.
//
// Cost control is two-layered: (1) the group itself has Telegram's native
// Slow Mode enabled (5 minutes — a group-settings toggle, not bot code), so
// there's a hard ceiling on how often ANYONE can post at all; (2) every
// answer is cached by its normalized question text in community_qa_cache,
// so if the same (or near-identically phrased) question comes up again, it
// gets the stored answer back instantly with zero further B.AI cost. Every
// *new* AI call's real token cost is logged via logOperationalUsage() under
// feature 'COMMUNITY_BOT', which is how it shows up on the admin stats page
// (admin-stats.js aggregates ai_operational_usage by `feature` already —
// no changes needed there for this to appear).
const COMMUNITY_GROUP_USERNAME = 'cvcase_community';

function isCommunityGroup(chat) {
  return !!(chat && chat.username && chat.username.toLowerCase() === COMMUNITY_GROUP_USERNAME);
}

// Deliberately simple EXACT-match normalization (lowercase, strip
// punctuation, collapse whitespace) rather than any fuzzy/semantic
// matching — cheap, predictable, and catches the overwhelmingly common
// case of the exact same question being re-asked verbatim or with only
// punctuation/casing differences, without the cost or complexity of a
// vector-similarity lookup.
function normalizeQuestion(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Kept intentionally tight — this whole block is re-sent as input tokens on
// every un-cached question, so padding it out directly inflates the B.AI
// bill logged above.
const COMMUNITY_SYSTEM_PROMPT = `You are the CVcase Community support assistant, answering questions in the
public CVcase Community Telegram group (@${COMMUNITY_GROUP_USERNAME}).

ABOUT CVcase:
- CVcase is a Telegram-based app (Mini App) that generates CVs and application/cover letters, and
  helps users find and apply to jobs. It also offers "Fit Check" (how well a user matches a job)
  and "Smart Finder" (AI job search).
- Users interact through: (1) @cvcase_bot — the Telegram bot that links a user's phone number,
  delivers generated files, and sends job/payment notifications; (2) the Mini App itself, opened
  from the bot's menu button ("🚀 Open App") — this is where users build their CV, generate
  letters, browse jobs, and manage their account; (3) the "CVcase Jobs" channel, which posts new
  job listings; (4) this Community group, for help and discussion between users.
- Identity & accounts: a user is identified by their Telegram account — opening the Mini App logs
  them in automatically, no password ever needed. Until a user shares their real phone number
  with the bot (tap "📱 Share my phone number" in @cvcase_bot, always visible near the input bar),
  their account uses a temporary placeholder ID and files can't be delivered to them on Telegram —
  sharing the phone number fixes this permanently.
- CT (CVcase Tokens) is the in-app currency that pays for AI actions (generating a letter, CV
  polish, Fit Check, Smart Finder). New accounts start with 0 CT; a top-up flow inside the app
  lets users add CT. Running low only prompts a top-up when the user tries an action that needs
  it — it's never forced on a brand-new user right after signup.
- Common issue: "download failed" or "please share your phone number first" means the user's
  Telegram isn't linked yet — tell them to open @cvcase_bot and tap the share-phone button, or use
  the "Share phone" button on their Account page in the app. Account deletion is permanent.

HOW TO ANSWER:
- Be concise, friendly, and practical — a sentence or two for simple questions, more only if truly needed.
- Reply in the SAME language the user asked in (English or Amharic/አማርኛ) — match their language exactly.
- If a question needs an account-specific lookup or sounds like a bug you can't resolve generically,
  say so plainly and suggest they wait for a human admin, rather than guessing.
- Never invent prices, features, or policies you're not certain of from the context above.`;

// Telegram's special "send as the group" sender (shown in-app as the
// "Send anonymously" toggle) is represented as a fixed, well-known account
// called GroupAnonymousBot — and that account IS flagged is_bot:true, same
// as a real bot. The blanket `msg.from.is_bot` check below used to treat
// it exactly like any other bot and silently drop the message, which is
// why a message sent anonymously in the group got no reply at all. Only
// skip genuine other bots now; this one specific "bot" id is actually a
// human group member posting anonymously and must still get an answer.
const TELEGRAM_ANONYMOUS_ADMIN_ID = 1087968824;

async function handleCommunityMessage(botToken, msg, db) {
  if (msg.from && msg.from.is_bot && msg.from.id !== TELEGRAM_ANONYMOUS_ADMIN_ID) return;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return; // commands are handled elsewhere / ignored here

  const chatId      = msg.chat.id;
  const cacheCol     = db.collection('community_qa_cache');
  const normalized   = normalizeQuestion(text);
  if (!normalized) return;

  const cached = await cacheCol.findOne({ normalized });
  if (cached) {
    await cacheCol.updateOne({ normalized }, { $inc: { hitCount: 1 }, $set: { lastHitAt: new Date() } });
    await httpsPost(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: cached.answer,
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true
    });
    return;
  }

  let result;
  try {
    result = await callAI({
      model: MODEL_IDS.GEMINI_FLASH,
      messages: [
        { role: 'system', content: COMMUNITY_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: 18000
    });
  } catch (err) {
    console.error('community bot AI call failed:', err.message);
    return; // stay silent in the group rather than post an error message
  }

  // Log the real B.AI cost of this call as operational spend — never
  // charged to any individual user's CT balance (nobody in a group chat is
  // "the" user to bill), but visible on the admin stats page under the
  // COMMUNITY_BOT feature.
  await logOperationalUsage(db, { feature: 'COMMUNITY_BOT', model: MODEL_IDS.GEMINI_FLASH, usage: result.usage });

  const answer = (result.text || '').trim() ||
    "Sorry, I couldn't come up with a good answer for that — an admin will help soon.";

  await cacheCol.insertOne({ normalized, question: text, answer, hitCount: 0, createdAt: new Date() });

  await httpsPost(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text: answer,
    reply_to_message_id: msg.message_id,
    allow_sending_without_reply: true
  });
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

  // Group messages (the CVcase Community group) are a completely separate
  // flow from everything below, which is all private-chat (DM) logic built
  // around "this chat IS the user" — a group's chatId is the GROUP's id,
  // not any individual member's, so none of that logic applies here. Branch
  // off first and never fall through into the DM handling for a group chat.
  if (msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
    if (isCommunityGroup(msg.chat)) {
      try {
        await client.connect();
        const db = client.db('cverve');
        await handleCommunityMessage(botToken, msg, db);
      } catch (err) {
        console.error('community group handler error:', err);
      }
    }
    return { statusCode: 200, body: 'OK' };
  }

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
        // Having a CVcase account does NOT mean this chat has ever shared its
        // real phone number with the bot — an account can be created straight
        // from the Mini App (onboarding.html) without ever going through the
        // request_contact flow here, in which case `telegram_chats` has no
        // chatId for this tgUserId and the bot has no chat to deliver files
        // to. It's also not enough for SOME telegram_chats record to exist
        // under this tgUserId with a chatId — file delivery
        // (send-telegram-file.js) looks it up by the account's OWN
        // phoneNumber, so a stale record from a previous/different phone
        // number would pass a chatId-only check yet still fail at download
        // time. Require the linked phoneNumber to actually match this
        // account's current phoneNumber before calling it fully linked;
        // otherwise keep showing the share-phone keyboard instead of hiding
        // it behind the "already linked" message.
        const linkRecord = await tgCol.findOne({ tgUserId });
        if (linkRecord && linkRecord.chatId && linkRecord.phoneNumber === existingUser.phoneNumber) {
          await sendAppMessage(botToken, chatId, tgUserId, tgCol,
            `✅ You already have a CVcase account linked to this Telegram.\n\nTap *Open CVcase App* below to get started — you're logged in automatically, no password needed.`
          );
          return { statusCode: 200, body: 'OK' };
        }

        await sendMessage(botToken, chatId,
          `👋 *Welcome back!*\n\nYou already have a CVcase account, but we still need your phone number here so files (your downloaded CV and letters) can be delivered to this chat.\n\nTap the button below to share it — takes one tap.`,
          shareOnlyKeyboard
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

      // NOTE: there used to be a "Fraud Check 1" here that refused to update
      // telegram_chats at all whenever this tgUserId already had *any*
      // record under a different phone number and a `users` account existed
      // for this tgUserId — on the theory that one Telegram identity should
      // only ever be tied to one phone. In practice that account is always
      // the SAME account (looked up by the very same tgUserId), so it was
      // blocking the one legitimate case that needed exactly this update:
      // an account created via the Mini App gets a placeholder phone number
      // (`tg_<tgUserId>`, see telegram-auth.js) until its owner shares a
      // real one here — that check refused the share every time, which is
      // why the button looked like it "did nothing" even once it appeared.
      // The migration block below already guards the real fraud case (the
      // new phone number belonging to a DIFFERENT CVcase account) via
      // phoneUsedByOther, so this account-ownership case needs no separate
      // check of its own.

      // ── Does THIS Telegram account already have a CVcase account under a
      // placeholder phone number (created straight from the Mini App via
      // onboarding.html, which stamps `tg_<tgUserId>` as the phoneNumber
      // when the user has never shared real contact with the bot)? If so,
      // migrate that account onto its real phone number right now, instead
      // of falling into the "brand new user" path below — otherwise the
      // account keeps the placeholder identifier forever, and file delivery
      // (which looks up telegram_chats by the account's phoneNumber) never
      // starts working even after this contact share.
      const accountForThisTg = await usersCol.findOne({ tgUserId });
      if (accountForThisTg && accountForThisTg.phoneNumber !== phoneNumber) {
        const phoneUsedByOther = await usersCol.findOne({ phoneNumber, tgUserId: { $ne: tgUserId } });
        if (phoneUsedByOther) {
          await sendMessage(botToken, chatId,
            `⛔ This phone number is already used by a different CVcase account. If this is your number, please contact support.`,
            shareOnlyKeyboard
          );
          return { statusCode: 200, body: 'OK' };
        }

        const oldPhone = accountForThisTg.phoneNumber;
        await usersCol.updateOne({ tgUserId }, { $set: { phoneNumber } });
        // manage-profile.js stores the "Stored Information" (name, CV, etc.)
        // keyed by userId === the account's phoneNumber at save time. Moving
        // the account onto its real phone number without also moving its
        // profile document left that profile stranded under the old
        // placeholder key — reachable by nothing, since every lookup is now
        // by the new real number. Re-key it here so onboarding info filled
        // in before the phone was shared survives the migration intact.
        if (oldPhone && oldPhone !== phoneNumber) {
          await db.collection('user_profiles').updateOne(
            { userId: oldPhone },
            { $set: { userId: phoneNumber } }
          );
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
        // Clean up the stale placeholder-keyed telegram_chats record, if any,
        // so a future lookup by the old identifier can't resurrect it.
        if (oldPhone && oldPhone !== phoneNumber) {
          await tgCol.deleteOne({ phoneNumber: oldPhone, tgUserId });
        }

        await sendAppMessage(botToken, chatId, tgUserId, tgCol,
          `✅ *Phone number linked!*\n\nYour CVcase account is now fully set up — files can be delivered right here in this chat.\n\nTap *Open CVcase App* below to continue.`
        );
        return { statusCode: 200, body: 'OK' };
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
    const linkRecordForOther = existingUserForOther ? await tgCol.findOne({ tgUserId }) : null;
    if (existingUserForOther && linkRecordForOther && linkRecordForOther.chatId && linkRecordForOther.phoneNumber === existingUserForOther.phoneNumber) {
      await sendAppMessage(botToken, chatId, tgUserId, tgCol, `Tap *Open CVcase App* below to use the app.`);
    } else if (existingUserForOther) {
      // Account exists but this chat has never shared a real phone number —
      // same reasoning as the /start handler above.
      await sendMessage(botToken, chatId,
        `We still need your phone number here so files can be delivered to this chat. Tap the button below to share it.`,
        shareOnlyKeyboard
      );
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