const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

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

  const { phoneNumber, password, balance = 0 } = JSON.parse(event.body);
  
  if (!phoneNumber || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number and password are required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');
    
    // Check if user already exists
    const existingUser = await collection.findOne({ phoneNumber });
    if (existingUser) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'User already exists with this phone number' })
      };
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create new user
    const result = await collection.insertOne({
      phoneNumber,
      password: hashedPassword,
      balance,
      createdAt: new Date()
    });
    
    return {
      statusCode: 201,
      body: JSON.stringify({ 
        success: true, 
        phoneNumber,
        balance
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