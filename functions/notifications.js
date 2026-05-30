// functions/notifications.js
// POST { action: 'mark_read', phoneNumber, password }
// Marks all notifications as read for a user after they open the notification panel.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, phoneNumber, password } = body;

  if (!phoneNumber || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'phoneNumber and password required.' }) };
  }

  try {
    await mongo.connect();
    const db  = mongo.db('cverve');
    const col = db.collection('users');
    const user = await col.findOne({ phoneNumber });
    if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    if (action === 'mark_read') {
      // Mark all notifications as read
      await col.updateOne(
        { phoneNumber },
        { $set: { 'notifications.$[].read': true } }
      );
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    console.error('notifications error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};