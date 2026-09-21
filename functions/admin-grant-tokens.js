// functions/admin-grant-tokens.js   (replaces subscribe-plan.js)
// POST body: { token, userId, tokens, reason }
//   token   — admin token (same as admin-verify)
//   userId  — the user's phoneNumber
//   tokens  — whole number of CT. Positive = add, negative = remove.
//   reason  — required short note (gift, correction, compensation...).
//
// Adds/removes CT by hand (never below zero), records it in `token_grants`
// for the audit trail, and tells the user with a notification. No money is
// involved, so nothing is recorded as revenue.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { formatCT } = require('./lib/packs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  try {
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload  = token.substring(0, lastDot);
    const sig      = token.substring(lastDot + 1);
    const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, userId, reason } = body;
  const tokens = Math.trunc(Number(body.tokens));

  if (!verifyToken(token)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'userId is required.' }) };
  if (!Number.isFinite(tokens) || tokens === 0) return { statusCode: 400, body: JSON.stringify({ error: 'Enter a CT amount (positive to add, negative to remove).' }) };
  const trimmedReason = (reason || '').toString().trim();
  if (!trimmedReason) return { statusCode: 400, body: JSON.stringify({ error: 'A reason is required.' }) };

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');

    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

    const res = await usersCol.findOneAndUpdate(
      { phoneNumber: userId },
      [{ $set: { tokens: { $max: [0, { $add: [{ $ifNull: ['$tokens', 0] }, tokens] }] } } }],
      { returnDocument: 'after' }
    );
    const doc = (res && Object.prototype.hasOwnProperty.call(res, 'value')) ? res.value : res;
    const newBalance = (doc && doc.tokens) || 0;

    await db.collection('token_grants').insertOne({ userId, tokens, reason: trimmedReason, balanceAfter: newBalance, createdAt: new Date() });

    if (tokens > 0) {
      await usersCol.updateOne({ phoneNumber: userId }, { $push: { notifications: {
        id: crypto.randomUUID(), read: false, type: 'plan_activated',   // name kept for the app; it means "CT added"
        plan: 'grant', tokens, packLabel: formatCT(tokens), amount: null,
        isAdminOverride: true, overrideReason: trimmedReason, createdAt: new Date()
      } } });
    }

    return { statusCode: 200, body: JSON.stringify({
      success: true, userId, tokens, newBalance,
      message: `${tokens > 0 ? 'Added' : 'Removed'} ${formatCT(Math.abs(tokens))} ${tokens > 0 ? 'to' : 'from'} ${userId}. New balance: ${formatCT(newBalance)}.`
    }) };
  } catch (error) {
    console.error('admin-grant-tokens error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};