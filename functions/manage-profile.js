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

  const { userId, action, profile } = body;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const profiles = db.collection('user_profiles');

    // GET profile
    if (action === 'get') {
      const existing = await profiles.findOne({ userId });
      if (!existing) {
        return { statusCode: 200, body: JSON.stringify({ profile: null }) };
      }
      // Remove _id for cleaner response
      const { _id, ...profileData } = existing;
      return { statusCode: 200, body: JSON.stringify({ profile: profileData }) };
    }

    // SAVE / UPDATE profile
    if (action === 'save') {
      if (!profile || typeof profile !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'profile object required' }) };
      }
      const { fullName, phone, email, address, cvText } = profile;
      if (!fullName || !phone || !email || !address) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields (fullName, phone, email, address)' }) };
      }

      const updateDoc = {
        userId,
        fullName,
        phone,
        email,
        address,
        cvText: cvText || null,
        updatedAt: new Date()
      };

      await profiles.findOneAndUpdate(
        { userId },
        { $set: updateDoc },
        { upsert: true, returnDocument: 'after' }
      );

      return { statusCode: 200, body: JSON.stringify({ success: true, profile: updateDoc }) };
    }

    // DELETE profile
    if (action === 'delete') {
      await profiles.deleteOne({ userId });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use get, save, or delete.' }) };
  } catch (err) {
    console.error('manage-profile error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};