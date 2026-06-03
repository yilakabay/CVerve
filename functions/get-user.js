// functions/get-user.js
// POST body (normal login):  { phoneNumber, password }
// POST body (admin lookup):  { token, userId }
//
// Login response now includes:
//   balance, plan, usageCounts, planExpiry, notifications, hasTelegram, tgUsername
//
// SESSION 3 CHANGES:
//   - plan, usageCounts, planExpiry are returned alongside balance
//   - Defaults are applied for legacy users who have no plan fields yet
//   - No other logic changed

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

// ── Plan defaults (applied when a user has no plan yet) ──────────────────────
const PLAN_DEFAULTS = {
  free: {
    plan:        'free',
    planExpiry:  null,
    usageCounts: { letters: 0, pdfMerges: 0, cvBuilds: 0 }
  }
};

function buildPlanData(user) {
  const plan       = user.plan       || 'free';
  const planExpiry = user.planExpiry || null;

  // Default usage counters — missing keys default to 0
  const usageCounts = {
    letters:   (user.usageCounts && user.usageCounts.letters   != null) ? user.usageCounts.letters   : 0,
    pdfMerges: (user.usageCounts && user.usageCounts.pdfMerges != null) ? user.usageCounts.pdfMerges : 0,
    cvBuilds:  (user.usageCounts && user.usageCounts.cvBuilds  != null) ? user.usageCounts.cvBuilds  : 0
  };

  // If planExpiry is in the past, fall back to free
  if (planExpiry && new Date(planExpiry) < new Date()) {
    return {
      plan:        'free',
      planExpiry:  null,
      usageCounts: { letters: 0, pdfMerges: 0, cvBuilds: 0 }
    };
  }

  return { plan, planExpiry, usageCounts };
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

      const pendingCol    = db.collection('pending_payments');
      const pendingPayment = await pendingCol.findOne({ userId, status: 'pending' });

      const tgCol    = db.collection('telegram_chats');
      const tgRecord = await tgCol.findOne({ phoneNumber: userId });

      const planData = buildPlanData(user);

      return {
        statusCode: 200,
        body: JSON.stringify({
          user: {
            phoneNumber:    user.phoneNumber,
            balance:        user.balance    || 0,
            plan:           planData.plan,
            planExpiry:     planData.planExpiry,
            usageCounts:    planData.usageCounts,
            createdAt:      user.createdAt  || null,
            email:          user.email      || null,
            tgUsername:     tgRecord?.username || null,
            hasTelegram:    !!tgRecord,
            pendingPayment: pendingPayment ? {
              paymentId:     pendingPayment.paymentId,
              amount:        pendingPayment.amount,
              planRequested: pendingPayment.planRequested || null,
              paymentMethod: pendingPayment.paymentMethod,
              submittedAt:   pendingPayment.submittedAt
            } : null
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
    const rawNotifs     = user.notifications || [];
    const notifications = rawNotifs.map(n => ({
      type:      n.type      || '',
      sender:    n.sender    || '',
      title:     n.title     || '',
      body:      n.body      || '',
      amount:    n.amount    || 0,
      paymentId: n.paymentId || '',
      reason:    n.reason    || '',
      createdAt: n.createdAt || null,
      read:      n.read === true
    }));
    const unreadCount = notifications.filter(n => !n.read).length;

    // ── Plan data (with expiry check & defaults for legacy users) ─────────────
    const planData = buildPlanData(user);

    // ── Also check if there's a pending payment (useful for app.html) ─────────
    const pendingCol     = db.collection('pending_payments');
    const pendingPayment = await pendingCol.findOne({ userId: phoneNumber, status: 'pending' });

    return {
      statusCode: 200,
      body: JSON.stringify({
        phoneNumber:    user.phoneNumber,
        balance:        user.balance    || 0,
        plan:           planData.plan,
        planExpiry:     planData.planExpiry,
        usageCounts:    planData.usageCounts,
        tgUsername:     tgRecord?.username || null,
        hasTelegram:    !!tgRecord,
        notifications,
        unreadCount,
        pendingPayment: pendingPayment ? {
          paymentId:     pendingPayment.paymentId,
          amount:        pendingPayment.amount,
          planRequested: pendingPayment.planRequested || null,
          paymentMethod: pendingPayment.paymentMethod,
          submittedAt:   pendingPayment.submittedAt
        } : null
      })
    };

  } catch (error) {
    console.error('get-user error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};