// functions/reset-telegram-webhook.js
//
// ONE-TIME, TEMPORARY helper — created solely to re-point the bot's
// Telegram webhook from the old cverve.netlify.app domain to the renamed
// cvcase.netlify.app one, without ever exposing TELEGRAM_BOT_TOKEN itself
// (Netlify's API redacts secret env var values, so the token can only be
// used from inside a running function, never read back out). Gated by a
// one-off WEBHOOK_RESET_TOKEN env var (not the bot token, not ADMIN_SECRET)
// created just for this. DELETE THIS FILE and the WEBHOOK_RESET_TOKEN env
// var once the webhook has been confirmed re-pointed — it has no reason to
// exist afterward.

const https = require('https');

function httpsGetJson(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.telegram.org', path, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).token;
  if (!token || token !== process.env.WEBHOOK_RESET_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN not set' }) };
  }

  const newUrl = 'https://cvcase.netlify.app/.netlify/functions/telegram-webhook';
  const encoded = encodeURIComponent(newUrl);
  const result = await httpsGetJson(`/bot${botToken}/setWebhook?url=${encoded}`);
  const info = await httpsGetJson(`/bot${botToken}/getWebhookInfo`);

  return { statusCode: 200, body: JSON.stringify({ setWebhookResult: result, webhookInfo: info }) };
};
