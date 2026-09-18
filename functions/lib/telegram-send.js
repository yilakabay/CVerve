// functions/lib/telegram-send.js
//
// Shared "deliver a file into the user's Telegram chat" logic. Extracted
// out of send-telegram-file.js so it can be reused by cv-chat.js: inside a
// Telegram Mini App, the in-app browser has no filesystem access at all —
// blob: URLs and <a download> silently do nothing — so a generated PDF can
// ONLY reach the user by having the BOT push it as a real chat message via
// Telegram's sendDocument API. This is that push, in one place, so
// send-telegram-file.js (client-triggered, password-checked) and cv-chat.js
// (server-triggered automatically once a CV PDF is rendered) hit identical
// multipart/sendDocument code and an identical chatId lookup — no drift.

const { MongoClient } = require('mongodb');
const https = require('https');

const uri = process.env.MONGODB_URI;
let client; // module-scope, reused across warm invocations — same pattern as the rest of this app
function getClient() {
  if (!client) client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });
  return client;
}

function buildMultipartBody(fields, fileField) {
  const boundary = '----CVcaseBoundary' + Date.now() + Math.random().toString(16).slice(2);
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }

  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
    `Content-Type: ${fileField.contentType}\r\n\r\n`
  ));
  parts.push(fileField.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

function sendDocumentToTelegram(botToken, chatId, fileBuffer, filename, caption) {
  return new Promise((resolve, reject) => {
    const fields = { chat_id: String(chatId) };
    if (caption) fields.caption = caption;

    const { body, boundary } = buildMultipartBody(fields, {
      name: 'document',
      filename,
      contentType: 'application/pdf',
      buffer: fileBuffer
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = {}; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Looks up the user's linked Telegram chat by phone number (userId) and
// delivers the given PDF buffer there as a real document message.
// NEVER throws — callers should treat a failure as non-fatal (log it and
// keep going), since the rest of the conversation/flow shouldn't break
// just because Telegram delivery failed (e.g. the user hasn't linked
// Telegram yet).
async function sendPdfDocument({ userId, fileBuffer, filename, caption }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { ok: false, error: 'Missing Telegram bot token' };
  if (!userId || !fileBuffer || !fileBuffer.length) return { ok: false, error: 'Missing userId or file buffer' };

  try {
    const c = getClient();
    await c.connect();
    const tgCol = c.db('cverve').collection('telegram_chats');
    const tgRecord = await tgCol.findOne({ phoneNumber: userId });
    if (!tgRecord || !tgRecord.chatId) {
      return { ok: false, error: "Telegram isn't linked for this user yet." };
    }

    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100) || 'document.pdf';
    const result = await sendDocumentToTelegram(botToken, tgRecord.chatId, fileBuffer, safeFilename, caption || null);

    if (!result.body || !result.body.ok) {
      console.error('sendPdfDocument: Telegram API error', result.statusCode, result.body);
      return { ok: false, error: 'Telegram API error' };
    }
    return { ok: true };
  } catch (e) {
    console.error('sendPdfDocument error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { buildMultipartBody, sendDocumentToTelegram, sendPdfDocument };