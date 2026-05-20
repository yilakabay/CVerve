const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { action, phone, password } = JSON.parse(event.body);
  await client.connect();
  const db = client.db('cverve');
  const admins = db.collection('admins');

  if (action === 'register') {
    const count = await admins.countDocuments();
    if (count > 0) return { statusCode: 403, body: JSON.stringify({ error: 'Admin already exists' }) };
    const hashed = await bcrypt.hash(password, 10);
    await admins.insertOne({ phone, password: hashed, createdAt: new Date() });
    return { statusCode: 201, body: JSON.stringify({ success: true }) };
  }

  if (action === 'login') {
    const admin = await admins.findOne({ phone });
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Admin not found' }) };
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid password' }) };
    // Simple token (just store phone, no JWT)
    const token = Buffer.from(phone).toString('base64');
    return { statusCode: 200, body: JSON.stringify({ token }) };
  }
};