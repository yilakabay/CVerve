// functions/cv-sessions.js
//
// Real (server-side) storage for CV Builder chat history — replaces the old
// localStorage/IndexedDB approach in cv.html, which could silently lose data
// once the browser's storage filled up. Everything now lives in MongoDB, in
// the `cv_sessions` collection, one document per chat.
//
// POST body: { userId, sessionToken, action, ...action-specific fields }
//
// Actions:
//   'list'   → { sessions: [{ sessionId, title, titleManual, templateId,
//                templateName, createdAt, updatedAt }, ...] }
//              Lightweight — no messages/displayLog/PDF bytes. Used to draw
//              the sidebar. Sorted newest-first, at most MAX_SESSIONS.
//
//   'get'    → { sessionId } → { session: { ...full doc... } }
//              The full chat, used when the user opens one from the sidebar.
//
//   'save'   → { sessionId, templateId, templateName, title, titleManual,
//                messages, displayLog }
//              Upserts the whole session. Creating a session for the first
//              time (a brand-new sessionId) counts as "starting a new chat"
//              for the per-user cap below.
//
//   'rename' → { sessionId, title } → sets title + titleManual only, without
//              needing the full messages/displayLog payload.
//
// ── Two limits, so storage per user stays bounded no matter how long someone
//    chats or how many CVs they generate ──
//
//   1. MAX_SESSIONS_PER_USER = 10 — once an 11th chat is saved, the oldest
//      (by updatedAt) is deleted outright.
//
//   2. Per-session trimming, applied on every save — kept generous (this is
//      a CV-building conversation, not meant to run forever) without letting
//      a single chat grow unbounded:
//        - MAX_MESSAGES        = 120  (the AI conversation history resent to
//          DeepSeek each turn — also keeps per-turn CT cost from creeping up
//          as a chat gets very long)
//        - MAX_DISPLAY_LOG     = 300  (the bubbles shown on screen)
//        - MAX_STORED_PDFS     = 6    (PDFs are the only thing here reused
//          large enough to matter; once more than 6 exist in one chat, the
//          bytes of the oldest ones are dropped — text/filename stays as a
//          record, the file itself would need to be regenerated)

const { MongoClient } = require('mongodb');
const { checkSession } = require('./lib/session');

const MAX_SESSIONS_PER_USER = 10;
const MAX_MESSAGES          = 120;
const MAX_DISPLAY_LOG       = 300;
const MAX_STORED_PDFS       = 6;

const mongo = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });
async function getCol() {
  await mongo.connect();
  return mongo.db('cverve').collection('cv_sessions');
}

// sessionToken replaces password here too — see lib/session.js.
async function authenticate(userId, sessionToken) {
  await mongo.connect();
  const users = mongo.db('cverve').collection('users');
  const user = await users.findOne({ phoneNumber: userId });
  if (!user) return false;
  return checkSession(user, sessionToken);
}

// Bounds one session document before it's written. Priority when trimming:
// keep the most RECENT content, and prefer keeping conversational text over
// old PDF bytes (a stale CV can be regenerated; the conversation can't).
function trimSession(doc) {
  if (Array.isArray(doc.messages) && doc.messages.length > MAX_MESSAGES) {
    const head = (doc.messages[0] && doc.messages[0].role === 'system') ? [doc.messages[0]] : [];
    doc.messages = head.concat(doc.messages.slice(doc.messages.length - (MAX_MESSAGES - head.length)));
  }

  if (Array.isArray(doc.displayLog)) {
    if (doc.displayLog.length > MAX_DISPLAY_LOG) {
      doc.displayLog = doc.displayLog.slice(doc.displayLog.length - MAX_DISPLAY_LOG);
    }
    const pdfIndexes = [];
    doc.displayLog.forEach((entry, i) => {
      if (entry && entry.role === 'pdf' && entry.pdfMeta && entry.pdfMeta.base64) pdfIndexes.push(i);
    });
    if (pdfIndexes.length > MAX_STORED_PDFS) {
      const toStrip = pdfIndexes.slice(0, pdfIndexes.length - MAX_STORED_PDFS);
      toStrip.forEach(i => {
        doc.displayLog[i].pdfMeta.base64 = null;
        doc.displayLog[i].pdfMeta.expired = true; // client shows "ask me to render again" for these
      });
    }
  }
  return doc;
}

// Deletes the oldest session(s) for a user beyond the cap. Runs after every
// save, so a user is never over the limit for more than one request.
async function enforceSessionCap(col, userId) {
  const total = await col.countDocuments({ userId });
  if (total <= MAX_SESSIONS_PER_USER) return;
  const excess = total - MAX_SESSIONS_PER_USER;
  const oldest = await col.find({ userId }, { projection: { _id: 1 } }).sort({ updatedAt: 1 }).limit(excess).toArray();
  if (oldest.length) await col.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, sessionToken, action } = body;
  if (!userId || !sessionToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Your session needs a quick refresh. Please log in again.' }) };
  }

  try {
    const ok = await authenticate(userId, sessionToken);
    if (!ok) return { statusCode: 401, body: JSON.stringify({ error: 'Your session needs a quick refresh. Please log in again.' }) };

    const col = await getCol();

    if (action === 'list') {
      const rows = await col
        .find({ userId }, { projection: { messages: 0, displayLog: 0 } })
        .sort({ updatedAt: -1 })
        .limit(MAX_SESSIONS_PER_USER)
        .toArray();
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          sessions: rows.map(r => ({
            sessionId: r.sessionId, title: r.title, titleManual: !!r.titleManual,
            templateId: r.templateId, templateName: r.templateName,
            createdAt: r.createdAt, updatedAt: r.updatedAt
          }))
        })
      };
    }

    if (action === 'get') {
      const { sessionId } = body;
      if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: 'sessionId is required' }) };
      const doc = await col.findOne({ userId, sessionId });
      if (!doc) return { statusCode: 404, body: JSON.stringify({ error: 'Chat not found.' }) };
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          session: {
            sessionId: doc.sessionId, templateId: doc.templateId, templateName: doc.templateName,
            title: doc.title, titleManual: !!doc.titleManual,
            createdAt: doc.createdAt, updatedAt: doc.updatedAt,
            messages: doc.messages || [], displayLog: doc.displayLog || []
          }
        })
      };
    }

    if (action === 'save') {
      const { sessionId, templateId, templateName, title, titleManual, messages, displayLog } = body;
      if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: 'sessionId is required' }) };

      const now = new Date();
      const doc = trimSession({
        messages: Array.isArray(messages) ? messages : [],
        displayLog: Array.isArray(displayLog) ? displayLog : []
      });

      await col.updateOne(
        { userId, sessionId },
        {
          $set: {
            userId, sessionId, templateId, templateName,
            title: (title || '').toString().slice(0, 200),
            titleManual: !!titleManual,
            messages: doc.messages, displayLog: doc.displayLog,
            updatedAt: now
          },
          $setOnInsert: { createdAt: now }
        },
        { upsert: true }
      );

      await enforceSessionCap(col, userId);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'rename') {
      const { sessionId, title } = body;
      if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: 'sessionId is required' }) };
      const trimmedTitle = (title || '').toString().trim().slice(0, 200);
      if (!trimmedTitle) return { statusCode: 400, body: JSON.stringify({ error: 'Title cannot be empty.' }) };
      await col.updateOne({ userId, sessionId }, { $set: { title: trimmedTitle, titleManual: true, updatedAt: new Date() } });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (error) {
    console.error('cv-sessions error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }
};