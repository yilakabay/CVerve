// functions/manage-refunds.js
// POST body: { token, action: 'list' | 'complete', refundId? }
//
// 'list'     → returns all refund requests, pending first, for the admin's
//              Refunds tab (userId, amount, bank details, status, dates).
// 'complete' → admin has manually sent the money back via the user's chosen
//              bank/wallet; marks the request refunded and notifies the user
//              from "Payment Review Team".

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

async function writeNotification(usersCol, userId, notification) {
  try {
    await usersCol.updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { id: crypto.randomUUID(), read: false, ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, action } = body;

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  try {
    await client.connect();
    const db         = client.db('cverve');
    const refundsCol = db.collection('refund_requests');
    const usersCol   = db.collection('users');

    if (action === 'list') {
      const refunds = await refundsCol
        .find({})
        .sort({ status: 1, createdAt: 1 }) // 'pending' sorts before 'refunded' alphabetically
        .limit(200)
        .toArray();
      return { statusCode: 200, body: JSON.stringify({ success: true, refunds }) };
    }

    if (action === 'complete') {
      const { refundId } = body;
      if (!refundId) return { statusCode: 400, body: JSON.stringify({ error: 'refundId is required' }) };

      const refund = await refundsCol.findOne({ id: refundId });
      if (!refund) return { statusCode: 404, body: JSON.stringify({ error: 'Refund request not found.' }) };
      if (refund.status === 'refunded') return { statusCode: 400, body: JSON.stringify({ error: 'This refund has already been marked as completed.' }) };

      await refundsCol.updateOne(
        { id: refundId },
        { $set: { status: 'refunded', resolvedAt: new Date() } }
      );

      await writeNotification(usersCol, refund.userId, {
        type:     'refund_completed',
        amount:   refund.amount,
        bankName: refund.bankName,
        paymentId: refund.paymentId
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Refund marked as completed and user notified.' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use list or complete.' }) };

  } catch (error) {
    console.error('manage-refunds error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};