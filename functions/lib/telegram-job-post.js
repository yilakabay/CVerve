// functions/lib/telegram-job-post.js
//
// Shared core of "post an entire job posting to the public CVcase Jobs
// Telegram channel" — originally lived only in post-job-telegram.js (the
// admin's manual "📣 Post to Telegram" button), factored out here so
// scheduled-telegram-posts.js (the cron job that fires off a job at its
// scheduledTelegramPostAt time) can post through the exact same path
// instead of re-implementing (and risking drifting from) the message
// format, chunking, and logo handling.
//
// Callers are responsible for: resolving `job` from Mongo, having
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID already validated as present, and
// writing whatever they want into the job doc afterward (this module does
// write the `telegramPosts` history entry itself, since both callers need
// that exact same bookkeeping either way).

const https = require('https');

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
// A Mongo ObjectId is 24 hex chars, so both shapes fit comfortably.
function buildPositionStartParam(jobId, positionIndex) {
  return `job_${jobId}_${positionIndex}`;
}
function buildCompanyStartParam(jobId) {
  return `job_${jobId}`;
}

// Telegram text messages cap at 4096 chars; a sendPhoto caption caps at
// 1024. Positions are kept whole (never split mid-position) and packed
// greedily into chunks under this budget.
function chunkPositionBlocks(blocks, limit) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const block of blocks) {
    const addedLen = block.length + 2; // + the blank line joining it to the next block
    if (current.length > 0 && currentLen + addedLen > limit) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(block);
    currentLen += addedLen;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

let cachedBotUsername = null;

// Posts the whole `job` (every position) to the configured Telegram channel
// and records the attempt on the job doc via `jobsCol`. Returns
// { ok: true, messageIds, companyDeepLink } or
// { ok: false, statusCode, error } — never throws for an ordinary Telegram
// API rejection (network/unexpected errors still propagate so the caller's
// own try/catch logs them).
async function postJobToTelegramChannel(jobsCol, job, jobId) {
  const botToken  = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!botToken)  return { ok: false, statusCode: 500, error: 'Telegram bot is not configured.' };
  if (!channelId) return { ok: false, statusCode: 500, error: 'No Telegram channel is configured yet. Set TELEGRAM_CHANNEL_ID.' };
  if (!Array.isArray(job.positions) || job.positions.length === 0) {
    return { ok: false, statusCode: 404, error: 'This job has no positions to post.' };
  }

  if (!cachedBotUsername) {
    const me = await httpsGetJson(`/bot${botToken}/getMe`);
    if (!me || !me.ok || !me.result || !me.result.username) {
      console.error('telegram-job-post: getMe failed', me);
      return { ok: false, statusCode: 500, error: "Could not resolve the bot's Telegram username. Check TELEGRAM_BOT_TOKEN." };
    }
    cachedBotUsername = me.result.username;
  }
  const botUsername = cachedBotUsername;
  const companyDeepLink = `https://t.me/${botUsername}?startapp=${buildCompanyStartParam(jobId)}`;

  const positionBlocks = job.positions.map((pos, idx) => {
    const lines = [];
    lines.push(`🔹 <b>Position ${idx + 1}: ${escapeHtml(pos.title)}</b>`);
    if (pos.qualification && pos.qualification !== 'Not specified') {
      lines.push('');
      lines.push(`🎓 <b>Education:</b> ${escapeHtml(pos.qualification)}`);
    }
    if (pos.experience) {
      lines.push('');
      lines.push(`💼 <b>Experience:</b> ${escapeHtml(pos.experience)}`);
    }
    if (pos.salary && pos.salary !== 'Not specified') {
      lines.push('');
      lines.push(`💰 <b>Salary:</b> ${escapeHtml(pos.salary)}`);
    }
    if (pos.expireDate && pos.expireDate !== 'Not specified') {
      lines.push('');
      lines.push(`⏰ <b>Deadline:</b> ${escapeHtml(pos.expireDate)}`);
    }
    if (pos.shortDescription) { lines.push(''); lines.push(escapeHtml(pos.shortDescription)); }
    lines.push('');
    const posDeepLink = `https://t.me/${botUsername}?startapp=${buildPositionStartParam(jobId, idx)}`;
    lines.push(`<a href="${posDeepLink}">📄 View Details & Apply</a>`);
    return lines.join('\n');
  });

  const header = `<u><b>${escapeHtml(job.company)}</b></u>`;
  const hasLogo = job.logo && /^data:image\/(png|jpe?g|webp);base64,/.test(job.logo);
  const TEXT_LIMIT = 4096;

  const chunks = chunkPositionBlocks(positionBlocks, TEXT_LIMIT - header.length - 40);
  const textMessages = chunks.map((blocks, i) => {
    const parts = [header];
    if (chunks.length > 1) parts[0] += ` (${i + 1}/${chunks.length})`;
    parts.push('');
    parts.push(blocks.join('\n\n'));
    return { text: parts.join('\n\n'), asPhoto: false };
  });
  const messages = hasLogo
    ? [{ text: header, asPhoto: true }, ...textMessages]
    : textMessages;

  const sentMessageIds = [];
  for (let i = 0; i < messages.length; i++) {
    const { text, asPhoto } = messages[i];
    const isLast = i === messages.length - 1;
    const replyMarkup = isLast
      ? { inline_keyboard: [[{ text: `🏢 View All Positions at ${job.company}`, url: companyDeepLink }]] }
      : undefined;

    let tgResult;
    if (asPhoto) {
      const logoBuffer = Buffer.from(job.logo.split(',')[1], 'base64');
      tgResult = await sendPhotoToChannel(botToken, channelId, logoBuffer, text, replyMarkup);
    } else {
      tgResult = await httpsPostJson(`/bot${botToken}/sendMessage`, {
        chat_id: channelId, text, parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    }

    if (!tgResult.body || !tgResult.body.ok) {
      console.error('telegram-job-post: Telegram API error', tgResult.statusCode, tgResult.body);
      const desc = tgResult.body && tgResult.body.description;
      if (sentMessageIds.length > 0) {
        await jobsCol.updateOne(
          { _id: job._id },
          { $push: { telegramPosts: { all: true, partial: true, messageIds: sentMessageIds, chatId: channelId, postedAt: new Date() } } }
        );
      }
      return { ok: false, statusCode: 502, error: desc ? `Telegram rejected the post: ${desc}` : 'Telegram rejected the post. Check the bot is an admin of the channel with post permission.' };
    }
    sentMessageIds.push(tgResult.body.result.message_id);
  }

  await jobsCol.updateOne(
    { _id: job._id },
    { $push: { telegramPosts: { all: true, messageIds: sentMessageIds, chatId: channelId, postedAt: new Date() } } }
  );

  return { ok: true, messageIds: sentMessageIds, companyDeepLink };
}

module.exports = { postJobToTelegramChannel };
