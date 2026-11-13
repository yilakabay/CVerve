// functions/fix-menu-buttons.js
//
// ONE-TIME, TEMPORARY helper — repairs a real bug uncovered by the
// cvcase.netlify.app domain rename: telegram-webhook.js's setAppMenuButton
// is only ever called ONCE per Telegram user (gated by an
// `appMenuButtonSet` flag stored on each functions/telegram-webhook.js
// `telegram_chats` document, set in ensureAppMenuButton). Every user who
// linked their Telegram before the rename got Telegram's per-chat "Open
// App" menu button permanently set to the OLD cverve.netlify.app URL —
// and since the flag is already `true` for them, the bot code's updated
// CVcase_APP_URL never gets re-applied for that chat, no matter how many
// times they clear cache or restart Telegram. This isn't a cache issue;
// it's the actual stored per-chat value on Telegram's own servers.
//
// This endpoint re-calls Telegram's setChatMenuButton for every already
// linked chat with the CURRENT CVcase_APP_URL, fixing it immediately for
// everyone in one pass (not just one user), without waiting for each of
// them to trigger a fresh /start flow. Gated by a one-off FIX_MENU_TOKEN
// env var created just for this. DELETE THIS FILE and the FIX_MENU_TOKEN
// env var once this has been run successfully once — it has no reason to
// exist afterward (new links already get the correct URL going forward).

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
const CVcase_APP_URL = 'https://cvcase.netlify.app/app';

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

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).token;
  if (!token || token !== process.env.FIX_MENU_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN not set' }) };
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db('cverve');
    const tgCol = db.collection('telegram_chats');

    const docs = await tgCol.find({ tgUserId: { $exists: true } }).toArray();
    const results = [];

    for (const doc of docs) {
      const chatId = doc.tgUserId; // private-chat DM: chat.id === user.id
      const res = await httpsPost(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
        chat_id: chatId,
        menu_button: { type: 'web_app', text: '🚀 Open App', web_app: { url: CVcase_APP_URL } }
      });
      results.push({ tgUserId: chatId, ok: !!(res && res.ok) });
    }

    return { statusCode: 200, body: JSON.stringify({ updatedCount: results.length, results }) };
  } finally {
    await client.close();
  }
};
