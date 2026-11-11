// functions/post-job-telegram.js
// POST body: { token, jobId }
//
// Admin-only. Posts an ENTIRE job posting (company + every position on it)
// to the public "CVcase Jobs" Telegram channel — this is the MANUAL path
// (the admin's own "📣 Post to Telegram" button in admin.html), fired
// immediately on request. The automatic path — a job posted at a time the
// admin scheduled in advance — is scheduled-telegram-posts.js, a cron
// function that runs every few minutes and fires off any job whose
// scheduledTelegramPostAt has arrived. Both paths share the exact same
// message-building and send logic via functions/lib/telegram-job-post.js,
// so a scheduled post looks identical to a manually-triggered one.
//
// See functions/lib/telegram-job-post.js for the message format (one text
// block per position ending in a "View Details & Apply" deep link, chunked
// so a position is never split mid-message, logo sent as its own leading
// photo message, and a final "View All Positions at <Company>" button).
//
// Requires two env vars that don't exist yet elsewhere in this app:
//   TELEGRAM_CHANNEL_ID — the channel to post to, e.g. "@cvcase_jobs" (a
//     public channel's @username) or a numeric "-100..." chat id (works for
//     a private channel too). The bot must already be an admin of that
//     channel with "Post Messages" permission, or sendMessage/sendPhoto
//     will fail with a 403 from Telegram.
// (TELEGRAM_BOT_TOKEN already exists — reused from send-telegram-file.js /
// telegram-webhook.js / telegram-auth.js.)

const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const { postJobToTelegramChannel } = require('./lib/telegram-job-post');

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

  let _id;
  try { _id = new ObjectId(jobId); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }

  try {
    await client.connect();
    const db      = client.db('cverve');
    const jobsCol = db.collection('jobs');

    const job = await jobsCol.findOne({ _id });
    if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };

    const result = await postJobToTelegramChannel(jobsCol, job, jobId);
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: result.error }) };
    }

    // A manual post always wins over any pending schedule — clear it so
    // the cron job doesn't try to post this again later.
    await jobsCol.updateOne({ _id }, { $unset: { scheduledTelegramPostAt: '' } });

    return { statusCode: 200, body: JSON.stringify({ success: true, messageIds: result.messageIds, companyDeepLink: result.companyDeepLink }) };

  } catch (error) {
    console.error('post-job-telegram error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }
};
