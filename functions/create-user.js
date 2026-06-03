// functions/create-user.js
// Called by verify-otp after OTP confirmed.
// SESSION 3 CHANGES:
//   - New user documents now include plan, planExpiry, planActivatedAt, usageCounts
//   - Legacy field `balance` is kept at 0 for backwards compatibility with admin views
//   - No other logic changed

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { phoneNumber, password } = parsed;

  if (!phoneNumber || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number and password are required' })
    };
  }

  try {
    await client.connect();
    const db         = client.db('cverve');
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

    // Create new user — with plan fields from the start
    await collection.insertOne({
      phoneNumber,
      password:         hashedPassword,
      balance:          0,             // kept for legacy admin views
      plan:             'free',
      planExpiry:       null,
      planActivatedAt:  null,
      usageCounts: {
        letters:   0,
        pdfMerges: 0,
        cvBuilds:  0
      },
      notifications: [],
      createdAt:     new Date()
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true,
        phoneNumber,
        plan:    'free'
      })
    };
  } catch (error) {
    console.error('create-user error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};