// functions/admin-reset.js
// ONE-TIME USE: Deletes the existing admin account so you can re-register.
// DELETE THIS FILE immediately after you have set your new password.

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // Hardcoded one-time secret — DELETE THIS FILE after use
  const secret = (event.queryStringParameters || {}).secret;
  if (secret !== 'cverve-reset-now') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const result = await db.collection('admin').deleteMany({});
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        deleted: result.deletedCount,
        message: 'Admin account cleared. Go to /admin.html to register a new password. Then DELETE this file!'
      })
    };
  } catch (err) {
    console.error('admin-reset error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};