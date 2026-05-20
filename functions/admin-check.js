const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

exports.handler = async () => {
  await client.connect();
  const db = client.db('cverve');
  const count = await db.collection('admins').countDocuments();
  await client.close();
  return {
    statusCode: 200,
    body: JSON.stringify({ exists: count > 0 })
  };
};