const { MongoClient } = require('mongodb');

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

    // Fetch current balance before applying change
    const user = await collection.findOne({ phoneNumber: userId });

    if (!user) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    const currentBalance = user.balance || 0;

    // If subtracting, make sure it won't go below zero
    if (amount < 0 && Math.abs(amount) > currentBalance) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Insufficient balance. The maximum you can subtract is ${currentBalance} ETB.`
        })
      };
    }

    const result = await collection.findOneAndUpdate(
      { phoneNumber: userId },
      { $inc: { balance: amount } },
      { returnDocument: 'after' }
    );

    const newBalance = result.value ? result.value.balance : result.balance;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        balance: newBalance,
        newBalance: newBalance
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