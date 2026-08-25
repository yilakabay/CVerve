// functions/subscribe-plan.js
// Internal helper called by admin-verify.js when approving a plan payment.
// Also callable directly by future automated payment gateways, and by
// admin.html's "Manual Plan Override" action.
//
// POST body: { token, userId, plan, paymentId, amount }
//   token     — admin JWT (same as admin-verify)
//   userId    — user's phoneNumber
//   plan      — 'basic' | 'pro'
//   paymentId — the verified payment ID (for audit trail)
//   amount    — amount paid (for audit trail)
//
// On success:
//   - Sets user.plan, user.planExpiry (+1 month), user.planActivatedAt
//   - Resets user.usageCounts to { lettersInternal:0, lettersExternal:0, pdfMerges:0, cvBuilds:0, fitTests:0 }
//   - Writes a plan_activated notification to the user
//   - Returns { success, plan, planExpiry }
//
// usageCounts field names MUST match increment-usage.js / get-user.js exactly:
// lettersInternal, lettersExternal, pdfMerges, cvBuilds, fitTests. $set REPLACES
// the whole usageCounts object rather than merging, so leaving any of these
// keys out here doesn't just fail to reset them — it deletes them from the
// document, which previously caused plan limits to misbehave right after an
// admin override (e.g. Fit/Not fit reporting "limit reached" on the very
// first try on a freshly-overridden plan).

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const PLAN_PRICES = { basic: 49, pro: 79 };

function verifyToken(token) {
  if (!token) return false;
  try {
    const lastDot  = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload  = token.substring(0, lastDot);
    const sig      = token.substring(lastDot + 1);
    const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch {
    return false;
  }
}

async function writeNotification(usersCol, userId, notification) {
  try {
    await usersCol.updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { ...notification, createdAt: new Date() } } }
    );
  } catch (e) {
    console.error('writeNotification error:', e.message);
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

  const { token, userId, plan, paymentId, amount } = body;

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  // ── Validation ────────────────────────────────────────────────────────────
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required.' }) };
  }

  const validPlans = Object.keys(PLAN_PRICES);
  if (!plan || !validPlans.includes(plan)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `plan must be one of: ${validPlans.join(', ')}.` })
    };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');

    // Verify user exists
    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    }

    // Calculate expiry: 1 month from now
    const planExpiry = new Date();
    planExpiry.setMonth(planExpiry.getMonth() + 1);

    // ── Activate the plan ──────────────────────────────────────────────────
    await usersCol.updateOne(
      { phoneNumber: userId },
      {
        $set: {
          plan:            plan,
          planExpiry:      planExpiry,
          planActivatedAt: new Date(),
          // Reset usage counters fresh each subscription period — field names
          // MUST match increment-usage.js / get-user.js exactly.
          usageCounts: {
            lettersInternal: 0,
            lettersExternal: 0,
            pdfMerges:       0,
            cvBuilds:        0,
            fitTests:        0
          }
        }
      }
    );

    // ── Log to a subscriptions collection for audit ────────────────────────
    await db.collection('subscriptions').insertOne({
      userId,
      plan,
      planExpiry,
      paymentId:    paymentId  || null,
      amount:       amount     || PLAN_PRICES[plan],
      activatedAt:  new Date(),
      activatedBy:  'admin'
    });

    // ── Notify the user ────────────────────────────────────────────────────
    const planLabels = { basic: 'Basic', pro: 'Pro' };
    await writeNotification(usersCol, userId, {
      id:        crypto.randomUUID(),
      read:      false,
      type:      'plan_activated',
      plan:      plan,
      planLabel: planLabels[plan] || plan,
      amount:    amount || PLAN_PRICES[plan],
      paymentId: paymentId || null,
      title:     `${planLabels[plan]} plan activated!`,
      body:      `Your ${planLabels[plan]} plan is now active until ${planExpiry.toLocaleDateString('en-ET')}.`
    });

    console.log(`Plan activated: user=${userId}, plan=${plan}, expiry=${planExpiry.toISOString()}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:    true,
        userId,
        plan,
        planExpiry: planExpiry.toISOString(),
        message:    `${plan} plan activated for ${userId} until ${planExpiry.toLocaleDateString('en-ET')}.`
      })
    };

  } catch (error) {
    console.error('subscribe-plan error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};