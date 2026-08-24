// functions/get-user.js
// POST body (normal login):  { phoneNumber, password }
// POST body (admin lookup):  { token, userId }
//
// Login response includes:
//   balance, plan, usageCounts, planExpiry, notifications, hasTelegram, tgUsername
//
// Pending payment shape (both paths) now reflects the screenshot-based flow:
//   pendingId, amount, senderName, paymentMethod, submittedAt
// There is no transaction ID field here — matching throughout the payment
// system is by sender name + amount only. A transaction ID, when a screenshot
// happened to show one, is stored purely as an anti-resubmission guard and
// isn't surfaced in this lookup.
//
// usageCounts field names MUST match increment-usage.js and admin-verify.js
// exactly: lettersInternal, lettersExternal, pdfMerges, cvBuilds, fitTests.
// A previous version of this file read a field called "letters" that nothing
// ever wrote, which made usage always display as 0 after every sync and
// silently reset the client's local counter — letting users exceed their
// plan limit. Do not reintroduce a mismatched field name here.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

function buildPlanData(user) {
  const plan       = user.plan       || 'free';
  const planExpiry = user.planExpiry || null;

  const raw = user.usageCounts || {};
  const usageCounts = {
    lettersInternal: raw.lettersInternal != null ? raw.lettersInternal : 0,
    lettersExternal: raw.lettersExternal != null ? raw.lettersExternal : 0,
    pdfMerges:       raw.pdfMerges       != null ? raw.pdfMerges       : 0,
    cvBuilds:        raw.cvBuilds        != null ? raw.cvBuilds        : 0,
    fitTests:        raw.fitTests        != null ? raw.fitTests        : 0
  };

  // If planExpiry is in the past, fall back to free
  if (planExpiry && new Date(planExpiry) < new Date()) {
    return {
      plan:        'free',
      planExpiry:  null,
      usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
    };
  }

  return { plan, planExpiry, usageCounts };
}

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
        pendingPayment: shapePendingPayment(pendingPayment)
      })
    };

  } catch (error) {
    console.error('get-user error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};