const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const auth = event.headers.authorization;
  if (!auth) return { statusCode: 401 };
  const token = auth.split(' ')[1];
  const phone = Buffer.from(token, 'base64').toString();
  await client.connect();
  const db = client.db('cverve');
  const admin = await db.collection('admins').findOne({ phone });
  if (!admin) return { statusCode: 403, body: 'Forbidden' };

  const { payments } = JSON.parse(event.body);
  if (!payments || !Array.isArray(payments)) return { statusCode: 400, body: 'Invalid input' };

  const pendingCollection = db.collection('pendingPayments');
  const paymentsCollection = db.collection('payments');
  const usersCollection = db.collection('users');

  let verifiedCount = 0;
  for (const { id, amount } of payments) {
    const pending = await pendingCollection.findOne({ paymentId: id, amount: amount, status: 'pending' });
    if (!pending) continue;
    // Mark as verified and add to user balance
    await paymentsCollection.insertOne({
      paymentId: pending.paymentId,
      userId: pending.userId,
      amount: pending.amount,
      verifiedAt: new Date()
    });
    await usersCollection.updateOne(
      { phoneNumber: pending.userId },
      { $inc: { balance: pending.amount } },
      { upsert: true }
    );
    await pendingCollection.updateOne({ _id: pending._id }, { $set: { status: 'verified' } });
    verifiedCount++;
  }
  return { statusCode: 200, body: JSON.stringify({ message: `Verified ${verifiedCount} payments.` }) };
};