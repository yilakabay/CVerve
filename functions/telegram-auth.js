// functions/telegram-auth.js
// POST body: { initData, createIfMissing? }
//
// Silent login for the Telegram Mini App. `initData` is the raw string
// Telegram gives the Mini App (window.Telegram.WebApp.initData) — it is
// SIGNED by Telegram with your bot token, so we verify that signature here
// rather than trusting any tgUserId the client claims. Never accept a bare
// tgUserId from the client for auth — only a verified initData string.
//
// createIfMissing: true is how onboarding.html finishes signup — a brand-new
// Telegram user has no `users` document yet (this function only reported
// status:'onboard' up to that point), so without this flag the app would
// call telegram-auth again after onboarding, still find nothing, and bounce
// the user right back to onboarding in a loop. Passing createIfMissing:true
// on that final "Go to CVcase" tap creates the account right then — the
// verified Telegram identity itself is the proof of who they are, exactly
// like verify-otp.js creates a web account once its OTP is verified.
//
// Response:
//   { status: 'login',    sessionToken, phoneNumber, tokens, ... }   — existing (or just-created) user, logged in
//   { status: 'onboard',  tgUserId, phoneNumber }                     — brand new, no account yet, createIfMissing was not set
//   { error: '...' }                                                 — invalid/expired initData

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { generateSessionToken } = require('./lib/session');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// Verifies Telegram Mini App initData per Telegram's documented HMAC scheme:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) dataCheckArr.push(`${key}=${value}`);
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  // Reject stale sessions (older than 24h) as a freshness check.
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { initData, createIfMissing } = body;
  if (!initData) {
    return { statusCode: 400, body: JSON.stringify({ error: 'initData is required' }) };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Telegram bot not configured' }) };
  }

  const tgUser = verifyInitData(initData, botToken);
  if (!tgUser || !tgUser.id) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired Telegram session' }) };
  }

  const tgUserId = String(tgUser.id);

  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const tgCol    = db.collection('telegram_chats');

    // Already registered → log them straight in, no OTP, no password.
    const user = await usersCol.findOne({ tgUserId });
    if (user) {
      const sessionToken = generateSessionToken();
      await usersCol.updateOne({ tgUserId }, { $set: { sessionToken, lastLoginAt: new Date() } });

      const rawNotifs     = user.notifications || [];
      const notifications = rawNotifs.map(n => ({
        ...n,
        id: n.id || null, type: n.type || '', amount: n.amount || 0,
        createdAt: n.createdAt || null, read: n.read === true
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          status:       'login',
          sessionToken,
          phoneNumber:  user.phoneNumber || null,
          tokens:       user.tokens || 0,
          balance:      user.tokens || 0,
          notifications,
          unreadCount:  notifications.filter(n => !n.read).length
        })
      };
    }

    // Not registered yet — first /start on the bot may already have linked a
    // phone number for this tgUserId; carry it along so onboarding can use it.
    const tgLink = await tgCol.findOne({ tgUserId });

    if (!createIfMissing) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status:      'onboard',
          tgUserId,
          phoneNumber: tgLink ? tgLink.phoneNumber : null
        })
      };
    }

    // ── Create the account now — onboarding just finished ──────────────────
    // Fraud check: this Telegram ID must not already be attached to some
    // other account (shouldn't happen since we just checked above, but a
    // concurrent request could race here — cheap to double check).
    const raceCheck = await usersCol.findOne({ tgUserId });
    if (raceCheck) {
      const sessionToken = generateSessionToken();
      await usersCol.updateOne({ tgUserId }, { $set: { sessionToken, lastLoginAt: new Date() } });
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'login', sessionToken,
          phoneNumber: raceCheck.phoneNumber || null,
          tokens: raceCheck.tokens || 0, balance: raceCheck.tokens || 0,
          notifications: [], unreadCount: 0
        })
      };
    }

    const sessionToken = generateSessionToken();
    await usersCol.insertOne({
      phoneNumber:    tgLink ? tgLink.phoneNumber : null,
      tgUserId,
      sessionToken,
      balance:        0,      // legacy ETB field — unused
      tokens:         0,      // CT balance — starts at 0, no free access
      tokensMigrated: true,
      notifications:  [],
      createdAt:      new Date(),
      lastLoginAt:    new Date()
    });

    console.log(`Telegram user created: tgUserId=${tgUserId} phone=${tgLink ? tgLink.phoneNumber : 'none'}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        status:      'login',
        sessionToken,
        phoneNumber: tgLink ? tgLink.phoneNumber : null,
        tokens:      0,
        balance:     0,
        notifications: [],
        unreadCount: 0
      })
    };

  } catch (err) {
    console.error('telegram-auth error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};