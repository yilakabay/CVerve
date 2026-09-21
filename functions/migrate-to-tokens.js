// functions/migrate-to-tokens.js   (replaces migrate-add-plan-fields.js)
// ONE-TIME migration to the CT system. POST body: { token, dryRun? }
//
// Every existing user who hasn't been migrated yet gets:
//   - 0 CT (there is no free access any more), plus
//   - ONLY if they currently have a paid plan that hasn't expired: a one-time
//     CT amount (MIGRATION_PLAN_TOKENS in lib/packs.js), so nobody who already
//     paid is left with nothing. Free-plan users just start at 0 CT.
// It is safe to run twice: users already marked `tokensMigrated` are skipped.
// Send { dryRun: true } first to see the numbers without changing anything.
// After running it, old plan fields are removed from those users.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { STARTER_TOKENS, MIGRATION_PLAN_TOKENS } = require('./lib/packs');

const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  try {
    const i = token.lastIndexOf('.');
    if (i === -1) return false;
    const payload = token.substring(0, i), sig = token.substring(i + 1);
    const secret = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  if (!verifyToken(body.token)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  const dryRun = body.dryRun === true;

  try {
    await client.connect();
    const db = client.db('cverve');
    const usersCol = db.collection('users');

    const users = await usersCol.find({ tokensMigrated: { $ne: true } }).toArray();
    let migrated = 0, totalGranted = 0, paidConverted = 0;
    const now = new Date();

    for (const u of users) {
      let grant = STARTER_TOKENS;
      const active = u.plan && u.plan !== 'free' && u.planExpiry && new Date(u.planExpiry) > now;
      if (active && MIGRATION_PLAN_TOKENS[u.plan]) { grant += MIGRATION_PLAN_TOKENS[u.plan]; paidConverted++; }

      if (!dryRun) {
        await usersCol.updateOne(
          { _id: u._id },
          {
            $set:   { tokens: (u.tokens || 0) + grant, tokensMigrated: true },
            $unset: { plan: '', planExpiry: '', usageCounts: '', lastSmartFinderRunAt: '' }
          }
        );
              }
      migrated++; totalGranted += grant;
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, dryRun, usersMigrated: migrated, paidPlansConverted: paidConverted, totalCTGranted: totalGranted }) };
  } catch (e) {
    console.error('migrate-to-tokens error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Migration failed.' }) };
  }
};