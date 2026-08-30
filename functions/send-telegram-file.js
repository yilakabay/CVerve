// functions/send-telegram-file.js
// POST body: { userId, password, fileBase64, filename, caption? }
//
// Delivers a file (PDF) generated client-side straight into the user's
// Telegram chat with the CVcase bot, via Telegram's sendDocument API.
//
// Why this exists: when CVcase is opened as a Telegram Mini App, Telegram's
// in-app browser cannot save/download files to the device at all — there is
// no filesystem access. The only way to get a generated PDF (merged jobs
// PDF, application letter, or letter+CV merge) into the user's hands in that
// context is to have the BOT deliver it as a normal chat message, which the
// user can then save from Telegram like any other received file.
//
// The PDF bytes are generated entirely client-side (pdf-lib/jsPDF) and never
// touch our database — they're sent here as base64, forwarded directly to
// Telegram, and never stored server-side.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const https = require('https');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const MAX_FILE_BYTES = 20 * 1024 * 1024; // Telegram's own bot upload limit is 50MB; keep well under it

// Builds a multipart/form-data request body manually (no external
// dependency needed) for Telegram's sendDocument endpoint, which requires a
// real file upload rather than a URL or base64 field.
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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, fileBase64, filename, caption } = body;

  if (!userId || !fileBase64 || !filename) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId, fileBase64, and filename are required.' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('send-telegram-file: Missing Telegram bot token');
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }

  let fileBuffer;
  try {
    fileBuffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid file data.' }) };
  }
  if (fileBuffer.length === 0 || fileBuffer.length > MAX_FILE_BYTES) {
    return { statusCode: 400, body: JSON.stringify({ error: 'File is invalid or too large to send.' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const tgCol    = db.collection('telegram_chats');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    const tgRecord = await tgCol.findOne({ phoneNumber: userId });
    if (!tgRecord || !tgRecord.chatId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Your Telegram isn\'t linked yet. Please link your phone number with the CVcase bot first.' })
      };
    }

    const safeFilename = filename.toString().replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100) || 'document.pdf';

    const result = await sendDocumentToTelegram(botToken, tgRecord.chatId, fileBuffer, safeFilename, caption || null);

    if (!result.body || !result.body.ok) {
      console.error('send-telegram-file: Telegram API error', result.statusCode, result.body);
      return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (error) {
    console.error('send-telegram-file error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }
};