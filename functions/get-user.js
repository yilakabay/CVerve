// functions/get-user.js
// POST body (session refresh):  { phoneNumber, sessionToken }
// POST body (admin lookup):     { token, userId }
//
// The regular path used to be phoneNumber+password. It's now
// phoneNumber+sessionToken — sessionToken is issued by verify-otp.js (web)
// or telegram-auth.js (Telegram) at login and is what every other function
// in the backend should now check in place of password (see lib/session.js).
//
// Response fields unchanged from before: tokens (CT balance), balance (same
// number, kept for old app.html code paths), notifications, hasTelegram,
// tgUsername.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { checkSession } = require('./lib/session');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

function shapePendingPayment(p) {
  if (!p) return null;
  return {
    pendingId:     p._id.toString(),
    amount:        p.claimedAmount,
    senderName:    p.claimedSenderName,
    chosenPlan:    p.chosenPlan,
    paymentMethod: p.paymentMethod,
    submittedAt:   p.submittedAt
  };
}

// ── Admin token verification (unchanged — admin still uses a password to log
// in via admin-auth.js; this just verifies the signed token that login issued) ──
function isValidAdminToken(token) {
  try {
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload  = token.substring(0, lastDot);
    const sig      = token.substring(lastDot + 1);
    const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
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

  // ── Admin lookup path (token + userId) — unchanged ─────────────────────────
  if (body.token && body.userId) {
    const { token, userId } = body;

    if (!isValidAdminToken(token)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
      await client.connect();
      const db = client.db('cverve');

      const usersCol = db.collection('users');
      const user     = await usersCol.findOne({ phoneNumber: userId });

      if (!user) {
        return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
      }

      const pendingCol     = db.collection('pending_payments');
      const pendingPayment = await pendingCol.findOne({ userId, status: 'pending' });

      const tgCol    = db.collection('telegram_chats');
      const tgRecord = await tgCol.findOne({ phoneNumber: userId });

      return {
        statusCode: 200,
        body: JSON.stringify({
          user: {
            phoneNumber:    user.phoneNumber,
            tokens:         user.tokens     || 0,
            balance:        user.tokens     || 0,
            createdAt:      user.createdAt  || null,
            email:          user.email      || null,
            tgUsername:     tgRecord?.username || null,
            hasTelegram:    !!tgRecord,
            pendingPayment: shapePendingPayment(pendingPayment)
          }
        })
      };
    } catch (error) {
      console.error('Admin get-user error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ── Regular session-refresh path (phoneNumber + sessionToken) ───────────────
  const { phoneNumber, sessionToken } = body;

  if (!phoneNumber || !sessionToken) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number and session token are required' })
    };
  }

  try {
    await client.connect();
    const db         = client.db('cverve');
    const collection = db.collection('users');

    const user = await collection.findOne({ phoneNumber });

    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }

    if (!checkSession(user, sessionToken)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session expired. Please log in again.' }) };
    }

    const tgCol    = db.collection('telegram_chats');
    const tgRecord = await tgCol.findOne({ phoneNumber });

    const rawNotifs     = user.notifications || [];
    const notifications = rawNotifs.map(n => ({
      ...n,
      id:        n.id        || null,
      type:      n.type      || '',
      amount:    n.amount    || 0,
      createdAt: n.createdAt || null,
      read:      n.read === true
    }));
    const unreadCount = notifications.filter(n => !n.read).length;

    const pendingCol     = db.collection('pending_payments');
    const pendingPayment = await pendingCol.findOne({ userId: phoneNumber, status: 'pending' });

    return {
      statusCode: 200,
      body: JSON.stringify({
        phoneNumber:    user.phoneNumber,
        tokens:         user.tokens     || 0,
        balance:        user.tokens     || 0,
        tgUsername:     tgRecord?.username || null,
        hasTelegram:    !!tgRecord,
        notifications,
        unreadCount,
        pendingPayment: shapePendingPayment(pendingPayment)
      })
    };

  } catch (error) {
    console.error('get-user error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};