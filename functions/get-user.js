// functions/get-user.js
// POST body (normal login):  { phoneNumber, password }
// POST body (admin lookup):  { token, userId }
//
// Login response includes:
//   tokens (CT balance), balance (same number — kept under the old name so
//   login.html / app.html keep working), notifications, hasTelegram, tgUsername
//
// CT balance lives in the `tokens` field of the user document (added to by
// top-ups, subtracted from by AI use — see lib/packs.js and lib/ai-billing.js).
// The old `balance` field on the document was the legacy ETB balance and is
// no longer used for anything.
//
// Pending payment shape (both paths): pendingId, amount, senderName,
// chosenPlan (a CT pack id), paymentMethod, submittedAt. Matching throughout
// the payment system is by sender name + amount only.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

// Shapes a pending_payments doc into the fields callers actually need
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

// ── Admin token verification ──────────────────────────────────────────────────
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

  // ── Admin lookup path (token + userId) ─────────────────────────────────────
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

  // ── Regular user login path (phoneNumber + password) ────────────────────────
  const { phoneNumber, password } = body;

  if (!phoneNumber || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number and password are required' })
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

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const tgCol    = db.collection('telegram_chats');
    const tgRecord = await tgCol.findOne({ phoneNumber });

    // ── Notifications ────────────────────────────────────────────────────────
    // Pass every field through — notifications now carry many payment-specific
    // fields (plan, resolvedBy, refundEligible, refundAmount, canUpgradeToPro,
    // verifiedPaymentId, expiry, upgradeFromBasic, etc.) that the app's
    // notification rendering and action buttons depend on. A narrow whitelist
    // here would silently strip them.
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

    // ── Also check if there's a pending payment (useful for app.html) ─────────
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