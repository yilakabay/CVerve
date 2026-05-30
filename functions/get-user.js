const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    maxIdleTimeMS: 30000
});

function isValidAdminToken(token) {
  try {
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload = token.substring(0, lastDot);
    const sig     = token.substring(lastDot + 1);
    const secret  = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ── Admin lookup path (token + userId) ──────────────────────────────────
  if (body.token && body.userId) {
    const { token, userId } = body;

    if (!isValidAdminToken(token)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
      await client.connect();
      const db = client.db('cverve');

      const usersCol = db.collection('users');
      const user = await usersCol.findOne({ phoneNumber: userId });

      if (!user) {
        return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
      }

      const pendingCol = db.collection('pending_payments');
      const pendingPayment = await pendingCol.findOne({ userId, status: 'pending' });

      const tgCol = db.collection('telegram_chats');
      const tgRecord = await tgCol.findOne({ phoneNumber: userId });

      return {
        statusCode: 200,
        body: JSON.stringify({
          user: {
            phoneNumber: user.phoneNumber,
            balance: user.balance || 0,
            createdAt: user.createdAt || null,
            email: user.email || null,
            tgUsername: tgRecord?.username || null,
            hasTelegram: !!tgRecord,
            pendingPayment: pendingPayment ? {
              paymentId: pendingPayment.paymentId,
              amount: pendingPayment.amount,
              paymentMethod: pendingPayment.paymentMethod,
              submittedAt: pendingPayment.submittedAt
            } : null
          }
        })
      };
    } catch (error) {
      console.error('Database error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ── Regular user login path (phoneNumber + password) ────────────────────
  const { phoneNumber, password } = body;

  if (!phoneNumber || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number and password are required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');

    const user = await collection.findOne({ phoneNumber });

    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const tgCol = db.collection('telegram_chats');
    const tgRecord = await tgCol.findOne({ phoneNumber });

    // ── Return notifications (persisted — marked read by frontend separately) ──
    const notifications = (user.notifications || []).map(n => ({
      ...n,
      read: n.read === true,
    }));
    // Note: notifications are NOT cleared — persisted and marked read by frontend
    const unreadCount = notifications.filter(n => !n.read).length;

    return {
      statusCode: 200,
      body: JSON.stringify({
        phoneNumber: user.phoneNumber,
        balance: user.balance || 0,
        tgUsername: tgRecord?.username || null,
        hasTelegram: !!tgRecord,
        notifications,
        unreadCount
      })
    };

  } catch (error) {
    console.error('Database error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};