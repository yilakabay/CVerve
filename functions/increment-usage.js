// functions/increment-usage.js
// Called by app.html before each plan-gated action.
// Atomically checks the user's plan limit and increments the counter if within limit.
//
// POST body: { userId, password, action, consume? }
//   action — 'letterInternal' | 'letterExternal' | 'pdfMerge' | 'cvBuild' | 'fitTest' | 'smartFinder'
//   consume — only meaningful for action:'smartFinder'. See below.
//
// Response:
//   200 { allowed: true,  remaining, plan, usageCounts }  — proceed with the action
//   200 { allowed: false, reason, plan, limit, used }     — block the action, show upgrade prompt
//   400 { error }
//   401 { error }
//   500 { error }
//
// Plan limits:
//   free:  letters=8,   pdfMerges=∞, cvBuilds=0, fitTests=0   (0 ETB)
//   basic: letters=35,  pdfMerges=∞, cvBuilds=0, fitTests=20  (49 ETB/mo)
//   pro:   letters=100, pdfMerges=∞, cvBuilds=0, fitTests=100 (79 ETB/mo)
//
// "∞" is represented as -1 (unlimited).
//
// ── Anti-abuse: permanent usage ledger ──────────────────────────────────────
// `usage_ledger` (keyed by tgUserId) is a lifetime, never-reset, never-deleted
// mirror of usage counts — see create-user.js for the full explanation. Every
// time this file increments a real usage counter on `users`, it applies the
// exact same increment to `usage_ledger`, so create-user.js can restore the
// correct starting point if this Telegram identity ever registers again
// (e.g. after deleting the account) instead of handing out a fresh free
// quota. The ledger is purely additive — it is NOT touched by the
// plan-expiry-driven monthly reset below, since that's a legitimate
// paid-plan cycle event, unrelated to the free-tier abuse this ledger exists
// to prevent.
//
// ── Smart Finder cooldown ────────────────────────────────────────────────
// Smart Finder runs a real AI call across every open job posting scored
// against the user's CV — far more expensive than a single letter/fit-check
// call. To stop it being triggered on every page reload / tab switch (which
// drains the AI quota for no real benefit — the CV rarely changes minute to
// minute), a successful run starts a cooldown before the NEXT run is allowed:
//   basic: 6 hours
//   pro:   3 hours
// The cooldown is keyed off the CURRENT plan at check time (not the plan at
// the time of the last run), so upgrading from Basic to Pro immediately
// shortens any cooldown already in progress — a real incentive to upgrade.
//
// This action supports two modes:
//   consume not set / false → CHECK ONLY. Used to decide whether to show the
//     unlocked panel or a locked/cooldown message. Never mutates anything.
//   consume: true            → CHECK + CLAIM. Used at the moment a real Smart
//     Finder run is about to happen. Atomically verifies not in cooldown and
//     records the run timestamp in the same operation, so two near-
//     simultaneous requests can't both slip through.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Plan limits ───────────────────────────────────────────────────────────────
// -1 = unlimited
// All plans track letters as a single combined monthly total (lettersTotal),
// counted against usageCounts.lettersInternal + usageCounts.lettersExternal —
// it doesn't matter whether the job was posted on CVcase or externally.
const PLAN_LIMITS = {
  free:  { lettersInternal: null, lettersExternal: null, lettersTotal: 8,   pdfMerges: -1, cvBuilds: 0, smartFinder: false, fitTests: 0   },
  basic: { lettersInternal: null, lettersExternal: null, lettersTotal: 35,  pdfMerges: -1, cvBuilds: 0, smartFinder: true,  fitTests: 20  },
  pro:   { lettersInternal: null, lettersExternal: null, lettersTotal: 100, pdfMerges: -1, cvBuilds: 0, smartFinder: true,  fitTests: 100 }
};

// Smart Finder cooldown duration per plan, in milliseconds.
const SMART_FINDER_COOLDOWN_MS = {
  basic: 6 * 60 * 60 * 1000, // 6 hours
  pro:   3 * 60 * 60 * 1000  // 3 hours
};

// Map incoming action name → usageCounts field name
const ACTION_MAP = {
  letterInternal: 'lettersInternal', // application letter for a job posted on CVcase
  letterExternal: 'lettersExternal', // application letter for a job posted outside CVcase
  pdfMerge:       'pdfMerges',
  cvBuild:        'cvBuilds',
  fitTest:        'fitTests'
};

// Human-readable feature names
const FEATURE_NAMES = {
  lettersInternal: 'application letters (CVcase jobs)',
  lettersExternal: 'application letters (external jobs)',
  pdfMerges:       'PDF merges',
  cvBuilds:        'CV builds',
  fitTests:        'Fit/Not fit tests'
};

function formatCooldownRemaining(endsAt) {
  const ms = endsAt.getTime() - Date.now();
  if (ms <= 0) return 'shortly';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

// Mirrors a +1 usage increment into the permanent ledger. Fire-and-forget
// isn't safe here (we want the ledger to reliably reflect reality), but it's
// also not worth failing the user's actual request if this write hiccups —
// so errors are logged, not thrown.
async function mirrorIncrementToLedger(db, tgUserId, field) {
  if (!tgUserId) return; // legacy user with no linked Telegram identity — nothing to mirror to
  try {
    await db.collection('usage_ledger').updateOne(
      { tgUserId },
      { $inc: { [`usageCounts.${field}`]: 1 }, $setOnInsert: { firstSeenAt: new Date(), accountsCreatedCount: 1 } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`Failed to mirror usage increment to ledger (tgUserId ${tgUserId}, field ${field}):`, err);
  }
}

// Mirrors the Smart Finder cooldown timestamp into the ledger, same
// best-effort reasoning as above.
async function mirrorSmartFinderRunToLedger(db, tgUserId, runAt) {
  if (!tgUserId) return;
  try {
    await db.collection('usage_ledger').updateOne(
      { tgUserId },
      { $set: { lastSmartFinderRunAt: runAt }, $setOnInsert: { firstSeenAt: new Date(), accountsCreatedCount: 1 } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`Failed to mirror Smart Finder run to ledger (tgUserId ${tgUserId}):`, err);
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

  const { userId, password, action, consume } = body;

  if (!userId || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and password are required.' }) };
  }

  // ── Smart Finder: plan gate + cooldown (no usage counter) ─────────────────
  if (action === 'smartFinder') {
    try {
      await client.connect();
      const db       = client.db('cverve');
      const usersCol = db.collection('users');
      const user     = await usersCol.findOne({ phoneNumber: userId });
      if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

      let plan = user.plan || 'free';
      if (user.planExpiry && new Date(user.planExpiry) < new Date()) plan = 'free';

      const featureAllowed = !!PLAN_LIMITS[plan]?.smartFinder;
      if (!featureAllowed) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            allowed: false,
            locked:  'plan',
            reason:  'Smart Finder is available on Basic and Pro plans. Upgrade to unlock it.',
            plan
          })
        };
      }

      const cooldownMs = SMART_FINDER_COOLDOWN_MS[plan] || SMART_FINDER_COOLDOWN_MS.basic;
      const lastRun = user.lastSmartFinderRunAt ? new Date(user.lastSmartFinderRunAt) : null;
      const now = new Date();
      const cooldownEndsAt = lastRun ? new Date(lastRun.getTime() + cooldownMs) : null;
      const inCooldown = !!(cooldownEndsAt && now < cooldownEndsAt);

      if (inCooldown) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            allowed: false,
            locked:  'cooldown',
            reason:  `Smart Finder can be used again in ${formatCooldownRemaining(cooldownEndsAt)} to conserve AI resources.`,
            plan,
            cooldownEndsAt: cooldownEndsAt.toISOString()
          })
        };
      }

      // CHECK ONLY — eligible, but don't record anything yet.
      if (!consume) {
        return { statusCode: 200, body: JSON.stringify({ allowed: true, plan }) };
      }

      // CHECK + CLAIM — atomically verify still not in cooldown and record
      // the run timestamp in one operation, guarding against a race between
      // two near-simultaneous requests both passing the check above.
      const cutoff = new Date(now.getTime() - cooldownMs);
      const claim = await usersCol.findOneAndUpdate(
        {
          phoneNumber: userId,
          $or: [
            { lastSmartFinderRunAt: { $exists: false } },
            { lastSmartFinderRunAt: null },
            { lastSmartFinderRunAt: { $lte: cutoff } }
          ]
        },
        { $set: { lastSmartFinderRunAt: now } },
        { returnDocument: 'after' }
      );

      if (!claim || !claim.value) {
        // Lost the race — another request just claimed the run first.
        const fresh = await usersCol.findOne({ phoneNumber: userId });
        const freshEndsAt = fresh && fresh.lastSmartFinderRunAt
          ? new Date(new Date(fresh.lastSmartFinderRunAt).getTime() + cooldownMs)
          : new Date(now.getTime() + cooldownMs);
        return {
          statusCode: 200,
          body: JSON.stringify({
            allowed: false,
            locked:  'cooldown',
            reason:  `Smart Finder can be used again in ${formatCooldownRemaining(freshEndsAt)} to conserve AI resources.`,
            plan
          })
        };
      }

      // Successful claim — mirror the cooldown timestamp into the permanent
      // ledger so deleting + recreating the account can't dodge it.
      await mirrorSmartFinderRunToLedger(db, user.tgUserId, now);

      return { statusCode: 200, body: JSON.stringify({ allowed: true, plan }) };

    } catch (error) {
      console.error('increment-usage smartFinder error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
    }
  }

  const field = ACTION_MAP[action];
  if (!field) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unknown action "${action}". Valid: letterInternal, letterExternal, pdfMerge, cvBuild, fitTest, smartFinder.` })
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
      // Plan expired — downgrade to free automatically. This resets the
      // LIVE usageCounts on `users` (a legitimate paid-cycle reset), but
      // deliberately does NOT touch usage_ledger — the permanent ledger
      // keeps growing regardless, since it exists purely to stop free-tier
      // abuse via account deletion, not to track billing cycles.
      plan = 'free';
      await usersCol.updateOne(
        { phoneNumber: userId },
        {
          $set: {
            plan:       'free',
            planExpiry: null,
            usageCounts: { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 }
          }
        }
      );
    }

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Current usage (default 0 for legacy users)
    const usageCounts = user.usageCounts || { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 };

    // Is this a letters action on a plan with a combined total (basic/pro)?
    const isLetterField   = (field === 'lettersInternal' || field === 'lettersExternal');
    const isCombinedPlan  = isLetterField && limits.lettersTotal !== null && limits.lettersTotal !== undefined;

    const limit      = isCombinedPlan ? limits.lettersTotal : limits[field]; // -1 = unlimited
    const currentUse = isCombinedPlan
      ? (usageCounts.lettersInternal || 0) + (usageCounts.lettersExternal || 0)
      : (usageCounts[field] || 0);

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
      await mirrorIncrementToLedger(db, user.tgUserId, field);
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
    // For combined-total plans (basic/pro letters) we can't rely on a single-field
    // Mongo query filter for the combined cap, so re-check just before incrementing
    // and accept the small race window (mirrors prior single-field behavior otherwise).
    let updateResult;
    if (isCombinedPlan) {
      updateResult = await usersCol.findOneAndUpdate(
        { phoneNumber: userId },
        { $inc: { [`usageCounts.${field}`]: 1 } },
        { returnDocument: 'after' }
      );
    } else {
      updateResult = await usersCol.findOneAndUpdate(
        {
          phoneNumber:                userId,
          [`usageCounts.${field}`]: { $lt: limit }
        },
        { $inc: { [`usageCounts.${field}`]: 1 } },
        { returnDocument: 'after' }
      );
    }

    if (!updateResult || !updateResult.value) {
      // Race condition: another request incremented to the limit first
      const freshUser  = await usersCol.findOne({ phoneNumber: userId });
      const freshCounts = (freshUser && freshUser.usageCounts) || {};
      const freshCount  = isCombinedPlan
        ? (freshCounts.lettersInternal || 0) + (freshCounts.lettersExternal || 0)
        : (freshCounts[field] || 0);
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

    await mirrorIncrementToLedger(db, user.tgUserId, field);

    const newCounts   = updateResult.value.usageCounts || {};
    const newCount    = isCombinedPlan
      ? (newCounts.lettersInternal || 0) + (newCounts.lettersExternal || 0)
      : (newCounts[field] || 0);
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