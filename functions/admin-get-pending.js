const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405 };
  const auth = event.headers.authorization;
  if (!auth) return { statusCode: 401, body: 'Unauthorized' };
  const token = auth.split(' ')[1];
  const phone = Buffer.from(token, 'base64').toString();
  await client.connect();
  const db = client.db('cverve');
  const admin = await db.collection('admins').findOne({ phone });
  if (!admin) return { statusCode: 403, body: 'Forbidden' };
  const pending = await db.collection('pendingPayments').find({ status: 'pending' }).toArray();
  return { statusCode: 200, body: JSON.stringify(pending) };
};