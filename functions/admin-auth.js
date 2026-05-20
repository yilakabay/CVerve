// functions/admin-auth.js
// POST body: { action: 'check' | 'register' | 'login', password?, confirmPassword? }
//
// 'check'    → returns { hasAdmin: boolean }
// 'register' → creates the one admin account (only if none exists)
// 'login'    → verifies password, returns { success, token }

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// Simple signed token: base64(payload).hmac
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ admin: true, ts: Date.now() })).toString('base64');
  const secret  = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, password, confirmPassword } = body;

  try {
    await client.connect();
    const db = client.db('cverve');
    const adminCol = db.collection('admin');

    // ── check ──────────────────────────────────────────────────────────────
    if (action === 'check') {
      const exists = await adminCol.findOne({});
      return {
        statusCode: 200,
        body: JSON.stringify({ hasAdmin: !!exists })
      };
    }

    // ── register ───────────────────────────────────────────────────────────
    if (action === 'register') {
      const existing = await adminCol.findOne({});
      if (existing) {
        return { statusCode: 409, body: JSON.stringify({ error: 'Admin account already exists. Please log in.' }) };
      }
      if (!password || password.length < 6) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };
      }
      if (password !== confirmPassword) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Passwords do not match' }) };
      }
      const hashed = await bcrypt.hash(password, 12);
      await adminCol.insertOne({ password: hashed, createdAt: new Date() });
      const token = makeToken();
      return { statusCode: 201, body: JSON.stringify({ success: true, token }) };
    }

    // ── login ──────────────────────────────────────────────────────────────
    if (action === 'login') {
      const admin = await adminCol.findOne({});
      if (!admin) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No admin account found. Please register first.' }) };
      }
      const valid = await bcrypt.compare(password, admin.password);
      if (!valid) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Incorrect password' }) };
      }
      const token = makeToken();
      return { statusCode: 200, body: JSON.stringify({ success: true, token }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-auth error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};