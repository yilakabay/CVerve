// functions/create-user.js
// Called by verify-otp after OTP confirmed.
//
// ── Anti-abuse: permanent usage ledger ──────────────────────────────────────
// A scammer's simplest trick is: burn the free plan's limits, delete the
// account, register again (same or different phone number), and get a brand
// new free quota. To close that off, usage is NOT reset to zero just because
// a `users` document is new — it's inherited from a permanent ledger keyed
// by the registrant's Telegram user ID (tgUserId), stored in
// `usage_ledger`. delete-account.js NEVER touches that collection. Telegram
// identity is the anchor because getting a second one requires a genuinely
// different phone number that Telegram itself verifies at signup — far more
// friction than clearing a browser or tapping "delete account".
//
// If this is a Telegram identity we've never seen before, a fresh zeroed
// ledger entry is created and the new account starts at 0, same as before.
// If we HAVE seen this Telegram identity before (even under a different
// phone number, even if that earlier account was deleted), the new account
// inherits its prior lifetime usage instead of starting fresh — so deleting
// and recreating an account can't reset limits.
//
// increment-usage.js keeps `usage_ledger` in lockstep going forward: every
// time it increments a usage counter on `users`, it increments the matching
// field in `usage_ledger` by the same amount.
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 1,
  maxIdleTimeMS: 30000
});

const ZERO_USAGE = { lettersInternal: 0, lettersExternal: 0, pdfMerges: 0, cvBuilds: 0, fitTests: 0 };

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { phoneNumber, password } = parsed;
  if (!phoneNumber || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number and password are required' })
    };
  }
  try {
    await client.connect();
    const db        = client.db('cverve');
    const usersCol  = db.collection('users');
    const tgCol     = db.collection('telegram_chats');
    const ledgerCol = db.collection('usage_ledger');

    // Check if user already exists
    const existingUser = await usersCol.findOne({ phoneNumber });
    if (existingUser) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'User already exists with this phone number' })
      };
    }

    // ── Resolve Telegram identity for this phone ─────────────────────────────
    // Should exist — registration is always preceded by sharing a phone
    // number to the bot, which creates this link before the OTP is even sent.
    const tgLink   = await tgCol.findOne({ phoneNumber });
    const tgUserId = tgLink ? tgLink.tgUserId : null;

    // ── Permanent usage ledger: inherit prior usage instead of resetting ────
    let startingUsage       = { ...ZERO_USAGE };
    let startingSmartFinder = null;

    if (tgUserId) {
      const ledger = await ledgerCol.findOne({ tgUserId });
      if (ledger) {
        // Seen this Telegram identity before — carry its lifetime usage
        // forward instead of granting a fresh free quota.
        startingUsage       = { ...ZERO_USAGE, ...(ledger.usageCounts || {}) };
        startingSmartFinder = ledger.lastSmartFinderRunAt || null;
        await ledgerCol.updateOne(
          { tgUserId },
          { $inc: { accountsCreatedCount: 1 }, $set: { lastRecreatedAt: new Date(), lastPhoneNumber: phoneNumber } }
        );
        console.log(`create-user: tgUserId ${tgUserId} has registered before — restoring prior usage instead of resetting (phone: ${phoneNumber}).`);
      } else {
        // First time ever seeing this Telegram identity.
        await ledgerCol.insertOne({
          tgUserId,
          usageCounts:          ZERO_USAGE,
          lastSmartFinderRunAt: null,
          lastPhoneNumber:      phoneNumber,
          accountsCreatedCount: 1,
          firstSeenAt:          new Date(),
          lastRecreatedAt:      null
        });
      }
    } else {
      // No Telegram link found for this phone — shouldn't normally happen
      // given the registration flow, but fail safe rather than fail closed:
      // start at zero and log it for visibility rather than blocking signup.
      console.warn(`create-user: no telegram_chats record found for phoneNumber ${phoneNumber} — usage ledger cannot be linked for this account.`);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user — usage inherited from the ledger above, not hardcoded
    // to zero, so account deletion + recreation can't reset limits. tgUserId
    // is stored directly on the account now too (previously only set later,
    // during a Telegram re-link), which is what lets increment-usage.js keep
    // the ledger in sync going forward.
    await usersCol.insertOne({
      phoneNumber,
      password:            hashedPassword,
      tgUserId:             tgUserId || null,
      balance:             0,             // kept for legacy admin views
      plan:                'free',
      planExpiry:          null,
      planActivatedAt:     null,
      usageCounts:         startingUsage,
      lastSmartFinderRunAt: startingSmartFinder,
      notifications:       [],
      createdAt:            new Date()
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true,
        phoneNumber,
        plan:    'free'
      })
    };
  } catch (error) {
    console.error('create-user error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};