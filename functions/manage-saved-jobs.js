// functions/manage-saved-jobs.js
// POST body: { userId, action: 'list' }
//   -> { success: true, savedJobs: [{ jobId, positionIndex }, ...] }
//
// POST body: { userId, action: 'toggle', jobId, positionIndex }
//   -> { success: true, saved: true|false, savedJobs: [{ jobId, positionIndex }, ...] }
//
// New, standalone collection ("saved_jobs") — does not touch user_profiles or
// users, so it can't affect CV/profile/login logic. One document per
// (userId, jobId, positionIndex) triple.

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { userId, action, jobId } = body;
  const positionIndex = Number.isInteger(body.positionIndex) ? body.positionIndex : parseInt(body.positionIndex, 10);

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const savedJobsCol = db.collection('saved_jobs');

    // ── LIST saved jobs ──────────────────────────────────────────────────────
    if (action === 'list') {
      const docs = await savedJobsCol.find({ userId }).sort({ savedAt: -1 }).toArray();
      const savedJobs = docs.map(d => ({ jobId: d.jobId, positionIndex: d.positionIndex }));
      return { statusCode: 200, body: JSON.stringify({ success: true, savedJobs }) };
    }

    // ── TOGGLE save/unsave a single job position ─────────────────────────────
    if (action === 'toggle') {
      if (!jobId || !Number.isInteger(positionIndex)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'jobId and positionIndex are required' }) };
      }

      const existing = await savedJobsCol.findOne({ userId, jobId, positionIndex });

      let saved;
      if (existing) {
        await savedJobsCol.deleteOne({ userId, jobId, positionIndex });
        saved = false;
      } else {
        await savedJobsCol.insertOne({ userId, jobId, positionIndex, savedAt: new Date() });
        saved = true;
      }

      const docs = await savedJobsCol.find({ userId }).sort({ savedAt: -1 }).toArray();
      const savedJobs = docs.map(d => ({ jobId: d.jobId, positionIndex: d.positionIndex }));

      return { statusCode: 200, body: JSON.stringify({ success: true, saved, savedJobs }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use list or toggle.' }) };
  } catch (err) {
    console.error('manage-saved-jobs error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};