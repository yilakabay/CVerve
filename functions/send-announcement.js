// functions/send-announcement.js
// Actions:
//   send   — push announcement to all users, store in announcements collection
//   list   — return all sent announcements (admin)
//   recall — remove a specific announcement from all user notifications by announceId
//
// Every notification pushed to a user MUST include a unique `id` field —
// mark-notifications-read.js matches and updates notifications by `id` via a
// MongoDB arrayFilter. A notification without one can never be marked read:
// the update runs, matches zero array elements, and silently does nothing (no
// error), so it always reappears unread on the next reload. This previously
// happened here — announcements had no `id` at all.

const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

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

  const { token, action } = body;

  if (!verifyAdminToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    await mongo.connect();
    const db            = mongo.db('cverve');
    const usersCol      = db.collection('users');
    const announceCol   = db.collection('announcements');

    // ── send ───────────────────────────────────────────────────────────────
    if (!action || action === 'send') {
      const { title, body: msgBody } = body;
      if (!title || !title.trim())   return { statusCode: 400, body: JSON.stringify({ error: 'Title is required.' }) };
      if (!msgBody || !msgBody.trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Message body is required.' }) };

      // Store announcement record
      const insertResult = await announceCol.insertOne({
        title:     title.trim(),
        body:      msgBody.trim(),
        sentAt:    new Date(),
        recalled:  false,
      });
      const announceId = insertResult.insertedId.toString();

      // NOTE: each user gets their OWN copy of this notification object via
      // $push below, but every copy shares the same `id` here since it's
      // generated once before the updateMany call. That's fine for read
      // tracking (each user's own array entry is matched independently by
      // their own phoneNumber + this id), but do NOT rely on this id being
      // globally unique across users the way pendingId/paymentId are.
      const notification = {
        id:          crypto.randomUUID(),
        type:        'announcement',
        sender:      'CVcase Official',
        title:       title.trim(),
        body:        msgBody.trim(),
        announceId,
        createdAt:   new Date(),
        read:        false,
      };

      const result = await usersCol.updateMany(
        {},
        { $push: { notifications: notification } }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          announceId,
          sentTo: result.modifiedCount,
          message: `Announcement sent to ${result.modifiedCount} user(s).`
        })
      };
    }

    // ── list ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const announcements = await announceCol
        .find({})
        .sort({ sentAt: -1 })
        .limit(50)
        .toArray();
      return { statusCode: 200, body: JSON.stringify({ success: true, announcements }) };
    }

    // ── recall ─────────────────────────────────────────────────────────────
    if (action === 'recall') {
      const { announceId } = body;
      if (!announceId) return { statusCode: 400, body: JSON.stringify({ error: 'announceId is required.' }) };

      // Remove from all user notification arrays
      const result = await usersCol.updateMany(
        { 'notifications.announceId': announceId },
        { $pull: { notifications: { announceId } } }
      );

      // Mark as recalled in announcements collection
      await announceCol.updateOne(
        { _id: new ObjectId(announceId) },
        { $set: { recalled: true, recalledAt: new Date() } }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          removedFrom: result.modifiedCount,
          message: `Announcement recalled from ${result.modifiedCount} user(s).`
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };

  } catch (err) {
    console.error('send-announcement error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};