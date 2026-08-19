// functions/mark-notifications-read.js
// POST body: { userId, password, notificationIds: string[] }
//
// Marks ONLY the specified notifications as read, scoped precisely by their
// own id via MongoDB arrayFilters. This exists specifically to avoid the
// previous bug where opening one chat thread could mark every notification
// across every sender as read — an unread message must stay unread forever
// until the user actually opens that specific chat.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, password, notificationIds } = body;
  if (!userId || !Array.isArray(notificationIds) || notificationIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and a non-empty notificationIds array are required.' }) };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    await usersCol.updateOne(
      { phoneNumber: userId },
      { $set: { 'notifications.$[elem].read': true } },
      { arrayFilters: [{ 'elem.id': { $in: notificationIds } }] }
    );

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (error) {
    console.error('mark-notifications-read error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred.' }) };
  }
};