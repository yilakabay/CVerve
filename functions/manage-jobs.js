// functions/manage-jobs.js
// POST body: { token, action: 'create' | 'list' | 'get' | 'delete' | 'update', job?, jobId? }
//
// 'create' → admin posts a structured job (company + positions[]) after AI refinement
//            in refine-job-posting.js and admin review/edits in admin.html
// 'list'   → returns active job postings (used by admin dashboard and, later, the
//            Find Job "All Jobs" feed — no admin token required for 'list' so the
//            app can call it directly)
// 'get'    → single job by jobId (used for the "Detail" view)
// 'delete' → admin removes a posting
// 'update' → admin edits an existing posting
//
// Each position stores its own shortDescription (feed card teaser) and
// fullDescription (shown behind the "Detail" button) — kept separate so the
// feed stays lightweight and the detail view is fetched/opened on demand.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

function sanitizePosition(p) {
  return {
    title:            (p.title || '').toString().trim(),
    qualification:    (p.qualification || '').toString().trim(),
    experience:       (p.experience || '').toString().trim(),
    salary:           (p.salary || 'Not specified').toString().trim(),
    expireDate:       (p.expireDate || 'Not specified').toString().trim(),
    shortDescription: (p.shortDescription || '').toString().trim(),
    fullDescription:  (p.fullDescription || '').toString().trim()
  };
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, action, job, jobId } = body;

  try {
    await client.connect();
    const db      = client.db('cverve');
    const jobsCol = db.collection('jobs');

    // ── list ─────────────────────────────────────────────────────────────────
    // Public (no admin token) — the app's job feed will call this directly.
    if (action === 'list') {
      const jobs = await jobsCol
        .find({ status: { $ne: 'deleted' } })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      return { statusCode: 200, body: JSON.stringify({ success: true, jobs }) };
    }

    // ── get (single job, for Detail view) ──────────────────────────────────────
    if (action === 'get') {
      if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }) };
      const { ObjectId } = require('mongodb');
      let _id;
      try { _id = new ObjectId(jobId); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }
      const found = await jobsCol.findOne({ _id });
      if (!found) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
      return { statusCode: 200, body: JSON.stringify({ success: true, job: found }) };
    }

    // Everything below requires a valid admin token
    if (!verifyToken(token)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // ── create ───────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!job || !job.company || !Array.isArray(job.positions) || job.positions.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'company and at least one position are required' }) };
      }
      const doc = {
        company:    job.company.toString().trim(),
        sourceUrl:  job.sourceUrl ? job.sourceUrl.toString().trim() : null,
        positions:  job.positions.map(sanitizePosition),
        status:     'active',
        createdAt:  new Date(),
        updatedAt:  new Date()
      };
      const result = await jobsCol.insertOne(doc);
      return { statusCode: 201, body: JSON.stringify({ success: true, jobId: result.insertedId, job: doc }) };
    }

    // ── update ───────────────────────────────────────────────────────────────
    if (action === 'update') {
      if (!jobId || !job) return { statusCode: 400, body: JSON.stringify({ error: 'jobId and job are required' }) };
      const { ObjectId } = require('mongodb');
      let _id;
      try { _id = new ObjectId(jobId); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }

      const update = { updatedAt: new Date() };
      if (job.company) update.company = job.company.toString().trim();
      if (Array.isArray(job.positions)) update.positions = job.positions.map(sanitizePosition);
      if (job.status) update.status = job.status;

      await jobsCol.updateOne({ _id }, { $set: update });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }) };
      const { ObjectId } = require('mongodb');
      let _id;
      try { _id = new ObjectId(jobId); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }
      // Soft-delete so historical application letters that referenced this
      // posting still resolve; 'list' already filters these out.
      await jobsCol.updateOne({ _id }, { $set: { status: 'deleted', deletedAt: new Date() } });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use create, list, get, update, or delete.' }) };

  } catch (error) {
    console.error('manage-jobs error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};