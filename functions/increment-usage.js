// functions/increment-usage.js
// Called by app.html before each plan-gated action.
// Atomically checks the user's plan limit and increments the counter if within limit.
//
// POST body: { userId, password, action }
//   action — 'letter' | 'pdfMerge' | 'cvBuild'
//
// Response:
//   200 { allowed: true,  remaining, plan, usageCounts }  — proceed with the action
//   200 { allowed: false, reason, plan, limit, used }     — block the action, show upgrade prompt
//   400 { error }
//   401 { error }
//   500 { error }
//
// Plan limits:
//   free:  letters=5,  pdfMerges=15, cvBuilds=0  (no CV on free)
//   basic: letters=30, pdfMerges=∞,  cvBuilds=3
//   pro:   letters=∞,  pdfMerges=∞,  cvBuilds=15
//
// "∞" is represented as -1 (unlimited).

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan limits ───────────────────────────────────────────────────────────────
// -1 = unlimited
const PLAN_LIMITS = {
  free:  { letters: 5,   pdfMerges: 15, cvBuilds: 0  },
  basic: { letters: 30,  pdfMerges: -1, cvBuilds: 3  },
  pro:   { letters: -1,  pdfMerges: -1, cvBuilds: 15 }
};

// Map incoming action name → usageCounts field name
const ACTION_MAP = {
  letter:   'letters',
  pdfMerge: 'pdfMerges',
  cvBuild:  'cvBuilds'
};

// Human-readable feature names
const FEATURE_NAMES = {
  letters:   'application letters',
  pdfMerges: 'PDF merges',
  cvBuilds:  'CV builds'
};

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

  const { userId, password, action } = body;

  if (!userId || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and password are required.' }) };
  }

  const field = ACTION_MAP[action];
  if (!field) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unknown action "${action}". Valid: letter, pdfMerge, cvBuild.` })
    };
  }

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');

    // ── Authenticate ─────────────────────────────────────────────────────────
    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    }
    const pwOk = await bcrypt.compare(password, user.password);
    if (!pwOk) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    // ── Resolve plan (check expiry) ───────────────────────────────────────────
    let plan = user.plan || 'free';
    if (user.planExpiry && new Date(user.planExpiry) < new Date()) {
      // Plan expired — downgrade to free automatically
      plan = 'free';
      await usersCol.updateOne(
        { phoneNumber: userId },
        {
          $set: {
            plan:       'free',
            planExpiry: null,
            usageCounts: { letters: 0, pdfMerges: 0, cvBuilds: 0 }
          }
        }
      );
    }

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const limit  = limits[field]; // -1 = unlimited

    // Current usage (default 0 for legacy users)
    const usageCounts = user.usageCounts || { letters: 0, pdfMerges: 0, cvBuilds: 0 };
    const currentUse  = usageCounts[field] || 0;

    // ── Feature access check (cvBuilds on free = 0 limit = blocked) ──────────
    if (limit === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          allowed: false,
          reason:  `${FEATURE_NAMES[field]} is not available on the ${plan} plan.`,
          plan,
          limit:   0,
          used:    currentUse,
          feature: field
        })
      };
    }

    // ── Unlimited check ───────────────────────────────────────────────────────
    if (limit === -1) {
      // Always allowed — increment counter for analytics
      await usersCol.updateOne(
        { phoneNumber: userId },
        { $inc: { [`usageCounts.${field}`]: 1 } }
      );
      const updatedCounts = { ...usageCounts, [field]: currentUse + 1 };
      return {
        statusCode: 200,
        body: JSON.stringify({
          allowed:     true,
          remaining:   -1,
          plan,
          usageCounts: updatedCounts,
          feature:     field
        })
      };
    }

    // ── Limit check ───────────────────────────────────────────────────────────
    if (currentUse >= limit) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          allowed: false,
          reason:  `You've used all ${limit} ${FEATURE_NAMES[field]} for this month on the ${plan} plan.`,
          plan,
          limit,
          used:    currentUse,
          feature: field
        })
      };
    }

    // ── Within limit — atomically increment ───────────────────────────────────
    const updateResult = await usersCol.findOneAndUpdate(
      {
        phoneNumber:                userId,
        [`usageCounts.${field}`]: { $lt: limit }
      },
      { $inc: { [`usageCounts.${field}`]: 1 } },
      { returnDocument: 'after' }
    );

    if (!updateResult || !updateResult.value) {
      // Race condition: another request incremented to the limit first
      const freshUser  = await usersCol.findOne({ phoneNumber: userId });
      const freshCount = (freshUser?.usageCounts || {})[field] || 0;
      return {
        statusCode: 200,
        body: JSON.stringify({
          allowed: false,
          reason:  `You've used all ${limit} ${FEATURE_NAMES[field]} for this month on the ${plan} plan.`,
          plan,
          limit,
          used:    freshCount,
          feature: field
        })
      };
    }

    const newCounts   = updateResult.value.usageCounts || {};
    const newCount    = newCounts[field] || 0;
    const remaining   = limit - newCount;

    return {
      statusCode: 200,
      body: JSON.stringify({
        allowed:     true,
        remaining,
        plan,
        usageCounts: newCounts,
        feature:     field
      })
    };

  } catch (error) {
    console.error('increment-usage error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};