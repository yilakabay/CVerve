// functions/post-job-telegram.js
// POST body: { token, jobId, positionIndex }
//
// Admin-only. Posts one position from a job already saved via manage-jobs.js
// to the public "CVcase Jobs" Telegram channel — a short teaser (company,
// title, a few highlights) with a button that deep-links straight back into
// the CVcase Mini App to that exact job's Detail screen, where the full
// description, Apply options, and "Build your CV/Letter" live. This is a
// DELIBERATELY SEPARATE, MANUAL step from manage-jobs.js's 'create' — a
// posting can have several positions and the admin may want to stagger them
// across the day, hold one back, or fix a typo before it goes out, so
// nothing is ever auto-posted to the channel just because it was saved.
//
// Requires two env vars that don't exist yet elsewhere in this app:
//   TELEGRAM_CHANNEL_ID — the channel to post to, e.g. "@cvcase_jobs" (a
//     public channel's @username) or a numeric "-100..." chat id (works for
//     a private channel too). The bot must already be an admin of that
//     channel with "Post Messages" permission, or sendMessage/sendPhoto
//     below will fail with a 403 from Telegram.
// (TELEGRAM_BOT_TOKEN already exists — reused from send-telegram-file.js /
// telegram-webhook.js / telegram-auth.js.)
//
// The deep link uses Telegram's "direct link" Mini App start parameter
// (https://t.me/<bot_username>?startapp=job_<jobId>_<positionIndex>) rather
// than a plain https://cverve.netlify.app URL, so tapping it from the
// channel — which is 100% Telegram members — opens straight inside the Mini
// App (no browser hop) at the right job. app.html reads that start_param on
// load (see handleTelegramJobDeepLink()) and opens the Job Detail modal for
// it automatically. <bot_username> isn't hardcoded anywhere in this app, so
// it's looked up once via Telegram's getMe API and cached for the life of
// this function instance.

const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const https  = require('https');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const secret = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (sig !== expected) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

// ── Low-level Telegram Bot API calls ────────────────────────────────────────
function httpsPostJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ statusCode: res.statusCode, body: {} }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGetJson(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.telegram.org', path, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    }).on('error', reject);
  });
}

// Photo upload needs real multipart/form-data (Telegram doesn't accept a
// base64/url field for an inline data-URI logo) — same construction as
// send-telegram-file.js's sendDocument helper, adapted for sendPhoto.
function buildMultipartBody(fields, fileField) {
  const boundary = '----CVcaseBoundary' + Date.now() + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
    `Content-Type: ${fileField.contentType}\r\n\r\n`
  ));
  parts.push(fileField.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

function sendPhotoToChannel(botToken, chatId, photoBuffer, caption, replyMarkup) {
  return new Promise((resolve, reject) => {
    const fields = {
      chat_id: String(chatId),
      caption,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify(replyMarkup)
    };
    const { body, boundary } = buildMultipartBody(fields, {
      name: 'photo', filename: 'logo.jpg', contentType: 'image/jpeg', buffer: photoBuffer
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { let parsed; try { parsed = JSON.parse(data); } catch { parsed = {}; } resolve({ statusCode: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Telegram's startapp payload only allows [A-Za-z0-9_-], up to 64 chars.
// A Mongo ObjectId is 24 hex chars, so "job_<id>_<idx>" fits comfortably.
function buildStartParam(jobId, positionIndex) {
  return `job_${jobId}_${positionIndex}`;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, jobId, positionIndex } = body;

  if (!verifyAdminToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!jobId || !Number.isInteger(positionIndex) || positionIndex < 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'jobId and positionIndex are required.' }) };
  }

  const botToken   = process.env.TELEGRAM_BOT_TOKEN;
  const channelId  = process.env.TELEGRAM_CHANNEL_ID;
  if (!botToken) {
    console.error('post-job-telegram: Missing TELEGRAM_BOT_TOKEN');
    return { statusCode: 500, body: JSON.stringify({ error: 'Telegram bot is not configured.' }) };
  }
  if (!channelId) {
    console.error('post-job-telegram: Missing TELEGRAM_CHANNEL_ID');
    return { statusCode: 500, body: JSON.stringify({ error: 'No Telegram channel is configured yet. Set TELEGRAM_CHANNEL_ID (e.g. @cvcase_jobs) in Netlify env vars, with the bot added there as an admin who can post messages.' }) };
  }

  let _id;
  try { _id = new ObjectId(jobId); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }

  try {
    await client.connect();
    const db      = client.db('cverve');
    const jobsCol = db.collection('jobs');

    const job = await jobsCol.findOne({ _id });
    if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
    const pos = job.positions && job.positions[positionIndex];
    if (!pos) return { statusCode: 404, body: JSON.stringify({ error: 'Position not found on this job' }) };

    // Bot username isn't hardcoded anywhere in this app — resolve it once
    // per cold start via getMe (cheap, cached on the function's module
    // scope for warm invocations).
    if (!exports.__cachedBotUsername) {
      const me = await httpsGetJson(`/bot${botToken}/getMe`);
      if (!me || !me.ok || !me.result || !me.result.username) {
        console.error('post-job-telegram: getMe failed', me);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not resolve the bot\'s Telegram username. Check TELEGRAM_BOT_TOKEN.' }) };
      }
      exports.__cachedBotUsername = me.result.username;
    }
    const deepLink = `https://t.me/${exports.__cachedBotUsername}?startapp=${buildStartParam(jobId, positionIndex)}`;

    // ── Compose the teaser (short — full detail lives in the app) ───────────
    const lines = [];
    lines.push(`<b>${escapeHtml(pos.title)}</b>`);
    lines.push(`🏢 ${escapeHtml(job.company)}`);
    const bits = [];
    if (pos.qualification && pos.qualification !== 'Not specified') bits.push(`🎓 ${escapeHtml(pos.qualification)}`);
    if (pos.experience)                                             bits.push(`💼 ${escapeHtml(pos.experience)}`);
    if (pos.salary && pos.salary !== 'Not specified')                bits.push(`💰 ${escapeHtml(pos.salary)}`);
    if (bits.length) lines.push(bits.join('  ·  '));
    if (pos.expireDate && pos.expireDate !== 'Not specified') lines.push(`⏰ Apply by ${escapeHtml(pos.expireDate)}`);
    if (pos.shortDescription) { lines.push(''); lines.push(escapeHtml(pos.shortDescription)); }
    lines.push('');
    lines.push('👇 Full details, how to apply, and build your CV & cover letter for this job in CVcase.');

    const caption = lines.join('\n').slice(0, pos.shortDescription && job.logo ? 1024 : 4096); // sendPhoto caption cap is 1024

    const replyMarkup = { inline_keyboard: [[{ text: '📄 View Details & Apply', url: deepLink }]] };

    let tgResult;
    if (job.logo && /^data:image\/(png|jpe?g|webp);base64,/.test(job.logo)) {
      const logoBuffer = Buffer.from(job.logo.split(',')[1], 'base64');
      tgResult = await sendPhotoToChannel(botToken, channelId, logoBuffer, caption, replyMarkup);
    } else {
      tgResult = await httpsPostJson(`/bot${botToken}/sendMessage`, {
        chat_id: channelId, text: caption, parse_mode: 'HTML', reply_markup: replyMarkup
      });
    }

    if (!tgResult.body || !tgResult.body.ok) {
      console.error('post-job-telegram: Telegram API error', tgResult.statusCode, tgResult.body);
      const desc = tgResult.body && tgResult.body.description;
      return { statusCode: 502, body: JSON.stringify({ error: desc ? `Telegram rejected the post: ${desc}` : 'Telegram rejected the post. Check the bot is an admin of the channel with post permission.' }) };
    }

    // Record the post on the job doc so admin.html can show "Posted ✓" and
    // the admin can tell at a glance which positions have already gone out.
    const messageId = tgResult.body.result.message_id;
    await jobsCol.updateOne(
      { _id },
      { $push: { telegramPosts: { positionIndex, messageId, chatId: channelId, postedAt: new Date() } } }
    );

    return { statusCode: 200, body: JSON.stringify({ success: true, messageId, deepLink }) };

  } catch (error) {
    console.error('post-job-telegram error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }
};
