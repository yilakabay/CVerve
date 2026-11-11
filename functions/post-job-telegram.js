// functions/post-job-telegram.js
// POST body: { token, jobId }
//
// Admin-only. Posts an ENTIRE job posting (company + every position on it)
// from manage-jobs.js to the public "CVcase Jobs" Telegram channel as ONE
// post (or, if the combined text is too long for a single Telegram message,
// a short sequential run of messages) rather than one separate message per
// position. Each position gets its own block of text ending in an inline
// "View Details & Apply" hyperlink that deep-links straight to THAT
// position's Detail screen in the CVcase Mini App. After every position has
// been listed, one inline keyboard button at the very end — "View All
// Positions at <Company>" — deep-links to the company's whole job card in
// the Mini App's Find Job feed (every position, not just one), via a
// startapp payload with no position index (see buildCompanyStartParam()).
// This is a DELIBERATELY SEPARATE, MANUAL step from manage-jobs.js's
// 'create' — the admin may want to fix a typo or hold a posting back before
// it goes out, so nothing is ever auto-posted to the channel just because
// it was saved.
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
// Deep links use Telegram's "direct link" Mini App start parameter rather
// than a plain https://cverve.netlify.app URL, so tapping one from the
// channel — which is 100% Telegram members — opens straight inside the Mini
// App (no browser hop):
//   https://t.me/<bot_username>?startapp=job_<jobId>_<positionIndex>  — one
//     position's in-text link, opens that position's Detail modal.
//   https://t.me/<bot_username>?startapp=job_<jobId>                 — the
//     bottom button, opens the Find Job feed scrolled to that company's card
//     (every position at once).
// app.html's handleTelegramJobDeepLink() reads that start_param on load and
// branches on whether a position index is present. <bot_username> isn't
// hardcoded anywhere in this app, so it's looked up once via Telegram's
// getMe API and cached for the life of this function instance.

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
// A Mongo ObjectId is 24 hex chars, so both shapes fit comfortably.
function buildPositionStartParam(jobId, positionIndex) {
  return `job_${jobId}_${positionIndex}`;
}
function buildCompanyStartParam(jobId) {
  return `job_${jobId}`;
}

// Telegram text messages cap at 4096 chars; a sendPhoto caption caps at
// 1024. Positions are kept whole (never split mid-position) and packed
// greedily into chunks under this budget, leaving headroom for the trailing
// "— continued —" note and, on the LAST chunk, the still-to-come company
// button doesn't affect text length (buttons aren't part of the text), so
// only the running caption/text length itself needs watching here.
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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, jobId } = body;

  if (!verifyAdminToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required.' }) };
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
    if (!Array.isArray(job.positions) || job.positions.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'This job has no positions to post.' }) };
    }

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
    const botUsername = exports.__cachedBotUsername;
    const companyDeepLink = `https://t.me/${botUsername}?startapp=${buildCompanyStartParam(jobId)}`;

    // ── Compose one text block per position ─────────────────────────────────
    // Layout matches the admin's own hand-edited template (each field its own
    // bold-labeled line, blank-line spacing), ending in an in-text hyperlink
    // straight to that position's own Detail screen — this is "the link" at
    // the end of each position, distinct from the one button at the very end
    // of the whole post, which goes to the company's full job card instead.
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

    // A logo photo carries a 1024-char caption cap; plain text messages cap
    // at 4096. Rather than trying to cram the logo into the same message as
    // the position text (and silently dropping it whenever that combined
    // text didn't fit under 1024 — the original bug here, e.g. GTF's two
    // positions alone already ran past that cap), the logo — when present —
    // always goes out as its OWN leading photo message with just the
    // company name as its caption, so it never depends on how much position
    // text follows. The position text then follows as one or more separate
    // text messages, each well under the much higher 4096 cap, chunked by
    // chunkPositionBlocks() so a position's block is never split across two
    // messages — a position either fits whole in a chunk, or starts the next
    // one.
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
      // The "view whole company card" button only makes sense once, on the
      // final message of the run, so it doesn't repeat across chunks.
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
        console.error('post-job-telegram: Telegram API error', tgResult.statusCode, tgResult.body);
        const desc = tgResult.body && tgResult.body.description;
        // Record whatever already went out before the failure, so a retry
        // doesn't have to re-send messages that already landed in the channel.
        if (sentMessageIds.length > 0) {
          await jobsCol.updateOne(
            { _id },
            { $push: { telegramPosts: { all: true, partial: true, messageIds: sentMessageIds, chatId: channelId, postedAt: new Date() } } }
          );
        }
        return { statusCode: 502, body: JSON.stringify({ error: desc ? `Telegram rejected the post: ${desc}` : 'Telegram rejected the post. Check the bot is an admin of the channel with post permission.' }) };
      }
      sentMessageIds.push(tgResult.body.result.message_id);
    }

    // Record the post on the job doc so admin.html can show "Posted ✓" for
    // the whole job (it's no longer tracked per position).
    await jobsCol.updateOne(
      { _id },
      { $push: { telegramPosts: { all: true, messageIds: sentMessageIds, chatId: channelId, postedAt: new Date() } } }
    );

    return { statusCode: 200, body: JSON.stringify({ success: true, messageIds: sentMessageIds, companyDeepLink }) };

  } catch (error) {
    console.error('post-job-telegram error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }
};
