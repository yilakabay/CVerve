// functions/manage-jobs.js
// POST body: { token, action: 'create' | 'list' | 'get' | 'delete' | 'update', job?, jobId?, cursorCreatedAt?, cursorId?, limit? }
//
// 'create' → admin posts a structured job (company + positions[]) after AI refinement
//            in refine-job-posting.js and admin review/edits in admin.html
// 'list'   → returns job postings — no admin token required (the app's job feed
//            calls this directly). Two modes:
//              - PAGINATED: pass { limit } (and, for pages after the first,
//                { cursorCreatedAt, cursorId } taken from the last job in the
//                previous page) → returns the next page of job DOCUMENTS
//                (sorted newest first) plus { hasMore }. Used by app.html's
//                "All Jobs" feed so opening the app with a large number of
//                posted jobs doesn't download everything at once — only the
//                page actually needed to render loads over the network.
//                This is CURSOR-based (keyset) pagination, not skip/page —
//                skip/page silently duplicates or skips jobs whenever a new
//                job is posted between page loads, or when two jobs share an
//                identical createdAt timestamp, because the offset shifts
//                and/or the sort order between ties isn't stable across
//                separate queries. Cursor pagination avoids both problems:
//                it always resumes strictly after the last document the
//                client actually saw, using createdAt + _id (a guaranteed
//                distinct, monotonic secondary key) as a compound cursor.
//              - FULL (legacy, unchanged): omit cursorCreatedAt/cursorId and
//                just don't paginate → returns up to 200 jobs in one
//                response, exactly as before. Used by the admin dashboard's
//                job list, and by Smart Finder / Saved Jobs, both of which
//                genuinely need the complete dataset (Smart Finder scores
//                every open position against the CV; Saved Jobs must resolve
//                a star tapped on any job, not just a recently-loaded page of
//                them) — pagination would silently break those.
// 'get'    → single job by jobId (used for the "Detail" view)
// 'delete' → admin removes a posting
// 'update' → admin edits an existing posting
//
// Each position stores its own shortDescription (feed card teaser) and
// fullDescription (shown behind the "Detail" button) — kept separate so the
// feed stays lightweight and the detail view is fetched/opened on demand.

const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 20;
const LEGACY_FULL_LIST_CAP = 200;

// Company logo — one per job posting (shared across all its positions, since a
// posting is inherently one company). Stored as a data-URI string (already
// square-cropped client-side in admin.html before upload). Capped generously
// to keep the job feed's payload size reasonable even with many logos.
const MAX_LOGO_DATA_URI_LENGTH = 700000; // ~500KB decoded

function isValidLogoDataUri(logo) {
  if (typeof logo !== 'string') return false;
  if (logo.length === 0 || logo.length > MAX_LOGO_DATA_URI_LENGTH) return false;
  return /^data:image\/(png|jpe?g|webp);base64,/.test(logo);
}

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

// A schemeless URL like "www.ethiojobs.net" (common when a posting only
// gives a bare domain, or an admin types one in without "https://") is
// treated by the browser as a RELATIVE path, not an external site — so
// window.open()/location on it silently resolves to
// https://cverve.netlify.app/www.ethiojobs.net (our own site, 404) instead
// of https://www.ethiojobs.net. Always prefix with https:// when no scheme
// is present so "Open Link" actually leaves our app. Kept in sync with the
// same helper in refine-job-posting.js.
function normalizeApplicationUrl(url) {
  const trimmed = (url || '').toString().trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function sanitizePosition(p) {
  // A posting can offer more than one way to apply at once (in person,
  // by email, via a link) — each is stored independently; whichever are
  // non-empty are the methods shown to applicants. applicationType is no
  // longer a meaningful single choice, so it's no longer stored.
  const applicationUrl = normalizeApplicationUrl(p.applicationUrl);
  return {
    title:            (p.title || '').toString().trim(),
    qualification:    (p.qualification || '').toString().trim(),
    experience:       (p.experience || '').toString().trim(),
    salary:           (p.salary || 'Not specified').toString().trim(),
    expireDate:       (p.expireDate || 'Not specified').toString().trim(),
    shortDescription: (p.shortDescription || '').toString().trim(),
    fullDescription:  (p.fullDescription || '').toString().trim(),
    physicalAddress:  (p.physicalAddress  || '').toString().trim(),
    applicationEmail: (p.applicationEmail || '').toString().trim(),
    applicationUrl
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

  const { token, action, job, jobId, limit, cursorCreatedAt, cursorId, paginate } = body;

  try {
    await client.connect();
    const db      = client.db('cverve');
    const jobsCol = db.collection('jobs');

    // ── list ─────────────────────────────────────────────────────────────────
    // Public (no admin token) — the app's job feed calls this directly.
    if (action === 'list') {
      const filter = { status: { $ne: 'deleted' } };

      // PAGINATED path — only taken when the caller explicitly asks to
      // paginate (first page: paginate=true with no cursor; later pages:
      // cursorCreatedAt + cursorId from the last job of the previous page).
      if (paginate) {
        const pageLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_LIMIT));

        // Keyset (cursor) pagination: resume strictly after the last document
        // the client actually saw. createdAt alone can tie between two jobs
        // created in the same millisecond, so _id (always unique and, as an
        // ObjectId, monotonically increasing) breaks the tie deterministically.
        // This is what makes results immune to jobs being posted in between
        // "Load more" clicks — unlike skip/page, nothing shifts underneath it.
        if (cursorCreatedAt && cursorId) {
          let cId;
          try { cId = new ObjectId(cursorId); } catch { cId = null; }
          if (cId) {
            const cDate = new Date(cursorCreatedAt);
            filter.$or = [
              { createdAt: { $lt: cDate } },
              { createdAt: cDate, _id: { $lt: cId } }
            ];
          }
        }

        // Fetch one extra document beyond the page size so we can tell
        // whether there's a next page, without a separate count query.
        const docs = await jobsCol
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .limit(pageLimit + 1)
          .toArray();

        const hasMore = docs.length > pageLimit;
        const jobs    = hasMore ? docs.slice(0, pageLimit) : docs;
        const last    = jobs.length > 0 ? jobs[jobs.length - 1] : null;

        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            jobs,
            hasMore,
            // Echoed back so the client just stores these and passes them
            // straight back on the next "Load more" call — no need to derive
            // them itself.
            nextCursorCreatedAt: last ? last.createdAt : null,
            nextCursorId:        last ? last._id       : null
          })
        };
      }

      // FULL (legacy, unchanged) path — used by the admin dashboard, Smart
      // Finder, and Saved Jobs, all of which need the complete dataset.
      const jobs = await jobsCol
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(LEGACY_FULL_LIST_CAP)
        .toArray();
      return { statusCode: 200, body: JSON.stringify({ success: true, jobs }) };
    }

    // ── get (single job, for Detail view) ──────────────────────────────────────
    if (action === 'get') {
      if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }) };
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
      let logo = null;
      if (job.logoBase64) {
        if (!isValidLogoDataUri(job.logoBase64)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or oversized logo image.' }) };
        }
        logo = job.logoBase64;
      }
      const doc = {
        company:    job.company.toString().trim(),
        sourceUrl:  job.sourceUrl ? job.sourceUrl.toString().trim() : null,
        logo,
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
      let _id;
      try { _id = new ObjectId(jobId); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid jobId' }) }; }

      const update = { updatedAt: new Date() };
      const unset = {};
      if (job.company) update.company = job.company.toString().trim();
      if (Array.isArray(job.positions)) update.positions = job.positions.map(sanitizePosition);
      if (job.status) update.status = job.status;
      if (job.logoBase64 !== undefined) {
        if (job.logoBase64 === null) {
          update.logo = null;
        } else if (isValidLogoDataUri(job.logoBase64)) {
          update.logo = job.logoBase64;
        } else {
          return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or oversized logo image.' }) };
        }
      }
      // Admin sets this to a future date+time to have scheduled-telegram-posts.js
      // (a cron Scheduled Function) auto-post this job to the Telegram channel
      // at that moment instead of the admin clicking "Post to Telegram"
      // themselves — lets postings be spread evenly through the day. Passing
      // null clears a pending schedule (e.g. the admin changed their mind, or
      // post-job-telegram.js itself clears it once the admin posts manually).
      if (job.scheduledTelegramPostAt !== undefined) {
        if (job.scheduledTelegramPostAt === null) {
          unset.scheduledTelegramPostAt = '';
        } else {
          const when = new Date(job.scheduledTelegramPostAt);
          if (isNaN(when.getTime())) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid scheduledTelegramPostAt date/time.' }) };
          }
          update.scheduledTelegramPostAt = when;
        }
      }

      const mongoUpdate = { $set: update };
      if (Object.keys(unset).length > 0) mongoUpdate.$unset = unset;
      await jobsCol.updateOne({ _id }, mongoUpdate);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }) };
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