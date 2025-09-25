const { MongoClient } = require('mongodb');

// Connection pooling - shared client for all requests
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    maxIdleTimeMS: 30000
});

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId } = JSON.parse(event.body);
  
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'User ID is required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');
    
    const user = await collection.findOne({ userId });
    
    if (user) {
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          userId: user.userId, 
          balance: user.balance 
        })
      };
    } else {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }
  } catch (error) {
    console.error('Database error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};