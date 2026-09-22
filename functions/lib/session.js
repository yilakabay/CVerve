// functions/lib/session.js
//
// Replaces password-based auth everywhere in the backend. A user's identity
// is now proven by a random sessionToken issued at login (web OTP flow or
// Telegram silent login), stored on the user document, and sent back by the
// client on every request in place of the old `password` field.
//
// Usage in any function that used to do:
//   const isValid = await bcrypt.compare(password, user.password);
// now do:
//   const { checkSession } = require('./lib/session');
//   const ok = checkSession(user, sessionToken);

const crypto = require('crypto');

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time compare so this isn't a timing side-channel.
function checkSession(user, sessionToken) {
  if (!user || !user.sessionToken || !sessionToken) return false;
  const a = Buffer.from(String(user.sessionToken));
  const b = Buffer.from(String(sessionToken));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateSessionToken, checkSession };