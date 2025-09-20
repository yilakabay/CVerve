const { MongoClient } = require('mongodb');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId } = JSON.parse(event.body);
  
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'User ID is required' }) };
  }

  const uri = process.env.MONGODB_URI;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');
    
    // Check if user already exists
    const existingUser = await collection.findOne({ userId });
    if (existingUser) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'User already exists' })
      };
    }
    
    // Create new user with 5.00 ETB initial balance
    const result = await collection.insertOne({
      userId,
      balance: 5.00, // Set initial balance to 5.00 ETB
      createdAt: new Date()
    });
    
    return {
      statusCode: 201,
      body: JSON.stringify({ 
        success: true, 
        userId,
        balance: 5.00
      })
    };
  } catch (error) {
    console.error('Database error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  } finally {
    await client.close();
  }
};