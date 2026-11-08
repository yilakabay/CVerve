// functions/prompt-telegram-share.js
// POST body: { initData }
//
// Why this exists: tapping "Open CVcase Bot" from inside the app only opens
// the Telegram chat — it does NOT make the bot send anything. Telegram's
// reply keyboard (the "Share my phone number" button, set up in
// telegram-webhook.js) only becomes visible once the bot has actually SENT a
// message carrying that keyboard. For a user who already has an existing
// chat with the bot, simply opening the chat does not resend /start, so if
// their keyboard isn't currently showing (new chat, or a client-side reset)
// they see no button at all and have no way to share their number.
//
// This function proactively sends that same "share your phone number"
// message + keyboard directly to the user's chat, server-side, the instant
// they tap "Open CVcase Bot" — so the button is guaranteed to be there when
// the chat opens. `initData` is the signed Mini App payload (same
// verification as telegram-auth.js), so we trust the tgUserId it yields.
//
// For a private bot chat, Telegram's chat_id is identical to the user's
// numeric id, which is how we can message them without already knowing a
// stored chatId. The one case this can't work is a user who has NEVER
// started the bot at all — Telegram forbids a bot from messaging someone
// who hasn't opened a conversation with it first ("Forbidden: bot can't
// initiate conversation with a user"). We detect that and tell the client,
// which falls back to a plain t.me link so Telegram shows its own "Start"
// button for a brand-new chat.

const crypto = require('crypto');
const https = require('https');

function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) dataCheckArr.push(`${key}=${value}`);
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  try { return JSON.parse(userJson); } catch { return null; }
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

const shareOnlyKeyboard = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  is_persistent: true
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { initData } = body;
  if (!initData) {
    return { statusCode: 400, body: JSON.stringify({ error: 'initData is required' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Telegram bot not configured' }) };
  }

  const tgUser = verifyInitData(initData, botToken);
  if (!tgUser || !tgUser.id) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid Telegram session' }) };
  }

  try {
    const res = await httpsPost(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: tgUser.id,
      text: `👋 Tap the button below to share your phone number. We'll use it to keep your account in sync with the web app — no password ever needed here.`,
      parse_mode: 'Markdown',
      reply_markup: shareOnlyKeyboard
    });

    if (res && res.ok === true) {
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // Most common failure: the user has never opened a chat with the bot at
    // all, so Telegram refuses to let the bot message them first.
    const description = (res && res.description) || '';
    const needsStart = /can't initiate conversation|bot was blocked|chat not found/i.test(description);
    return { statusCode: 200, body: JSON.stringify({ success: false, needsStart }) };
  } catch (err) {
    console.error('prompt-telegram-share error:', err);
    return { statusCode: 200, body: JSON.stringify({ success: false, needsStart: true }) };
  }
};
