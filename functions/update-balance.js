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

  const { userId, amount } = JSON.parse(event.body);
  
  if (!userId || amount === undefined) {
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: 'User ID and amount are required' }) 
    };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');
    
    // Update user balance
    const result = await collection.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount } },
      { returnDocument: 'after', upsert: true }
    );
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        balance: result.value.balance 
      })
    };
  } catch (error) {
    console.error('Database error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};