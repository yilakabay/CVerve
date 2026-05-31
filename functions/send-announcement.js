// functions/send-announcement.js
// Admin sends an official announcement to ALL users.
// POST { token, title, body }
// Writes a notification of type 'announcement' to every user document.

const { MongoClient } = require('mongodb');
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

  const { token, title, body: msgBody } = body;

  if (!verifyAdminToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!title || !title.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Title is required.' }) };
  }
  if (!msgBody || !msgBody.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Message body is required.' }) };
  }

  try {
    await mongo.connect();
    const db       = mongo.db('cverve');
    const usersCol = db.collection('users');

    const notification = {
      type:      'announcement',
      sender:    'CVerve Official',
      title:     title.trim(),
      body:      msgBody.trim(),
      createdAt: new Date(),
      read:      false,
    };

    // Push to every user
    const result = await usersCol.updateMany(
      {},
      { $push: { notifications: notification } }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        sentTo: result.modifiedCount,
        message: `Announcement sent to ${result.modifiedCount} user(s).`
      })
    };
  } catch (err) {
    console.error('send-announcement error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};