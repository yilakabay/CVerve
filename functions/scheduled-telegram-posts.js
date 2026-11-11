// functions/scheduled-telegram-posts.js
//
// Netlify Scheduled Function (see the [[functions]] schedule entry for this
// function in netlify.toml) — runs on a cron schedule, not on demand. Its
// one job: find every job posting whose admin-set scheduledTelegramPostAt
// has arrived and hasn't been posted to Telegram yet, post it (via the same
// functions/lib/telegram-job-post.js logic post-job-telegram.js's manual
// button uses, so a scheduled post is byte-for-byte identical to a manual
// one), and clear the schedule.
//
// This is the automatic half of "schedule a job to post evenly through the
// day instead of clicking Post for each one" — admin.html lets the admin
// set a date+time per job (stored via manage-jobs.js 'update' action); this
// function is what actually fires it off when that time comes. The admin
// can still post any job manually at any time regardless of whether it has
// a pending schedule (post-job-telegram.js's manual path clears the
// schedule itself when that happens, so this function never double-posts
// something the admin already posted by hand).
//
// Why a $lte query is safe against double-posting even with concurrent/
// overlapping invocations: each matched job is immediately re-fetched with
// a findOneAndUpdate that atomically unsets scheduledTelegramPostAt — the
// unset happens BEFORE the (slower) Telegram send, as a claim/lock, so a
// second invocation that starts while the first is still mid-send for the
// same job will no longer find it (its scheduledTelegramPostAt is already
// gone). If the Telegram send itself then fails, the job is simply left
// unposted with no schedule — same place a manual post that failed would
// leave it — rather than silently retried forever on a 5-minute loop.

const { MongoClient } = require('mongodb');
const { postJobToTelegramChannel } = require('./lib/telegram-job-post');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await client.connect();
    const db      = client.db('cverve');
    const jobsCol = db.collection('jobs');

    const due = await jobsCol
      .find({ scheduledTelegramPostAt: { $lte: new Date() }, status: { $ne: 'deleted' } })
      .limit(20) // generous headroom over "a day's worth of postings"; next run picks up any overflow
      .toArray();

    if (due.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: true, posted: 0 }) };
    }

    const results = [];
    for (const job of due) {
      // Claim it first (atomic unset) so a second concurrent run, or a
      // manual post that races this one, can't also pick it up.
      const res = await jobsCol.findOneAndUpdate(
        { _id: job._id, scheduledTelegramPostAt: job.scheduledTelegramPostAt },
        { $unset: { scheduledTelegramPostAt: '' } },
        { returnDocument: 'before' }
      );
      // mongodb driver versions differ on whether the matched doc comes back
      // wrapped as { value } or as the doc itself — handle both, same as
      // admin-grant-tokens.js's findOneAndUpdate call elsewhere in this app.
      const claimedDoc = (res && Object.prototype.hasOwnProperty.call(res, 'value')) ? res.value : res;
      if (!claimedDoc) continue; // someone else already claimed it (or it no longer matches)

      try {
        const result = await postJobToTelegramChannel(jobsCol, job, String(job._id));
        results.push({ jobId: String(job._id), company: job.company, ok: result.ok, error: result.error });
        if (!result.ok) {
          console.error('scheduled-telegram-posts: failed to post', job._id, result.error);
        }
      } catch (err) {
        console.error('scheduled-telegram-posts: error posting job', job._id, err);
        results.push({ jobId: String(job._id), company: job.company, ok: false, error: 'Unexpected error' });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, posted: results.filter(r => r.ok).length, results }) };

  } catch (error) {
    console.error('scheduled-telegram-posts error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
