// functions/admin-verify.js
// POST body: { token, action: 'list' | 'verify' | 'reject', entries?, paymentId? }

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

// Writes a notification to the user's document
// User will see it as a popup the next time they log in (or immediately if logged in)
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { token, action } = body;

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const pendingCol  = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');
    const usersCol    = db.collection('users');

    // ── list ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const pending = await pendingCol
        .find({ status: 'pending' })
        .sort({ submittedAt: -1 })
        .limit(100)
        .toArray();
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, pending })
      };
    }

    // ── verify ─────────────────────────────────────────────────────────────
    if (action === 'verify') {
      const { entries } = body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'entries array is required' }) };
      }

      const results = [];

      for (const entry of entries) {
        const entryId  = String(entry.paymentId || '').trim().toLowerCase();
        const entryAmt = parseFloat(String(entry.amount || '').replace(/[^\d.]/g, ''));

        if (!entryId) {
          results.push({ paymentId: entryId, status: 'skipped', reason: 'Empty payment ID' });
          continue;
        }
        if (isNaN(entryAmt)) {
          results.push({ paymentId: entryId, status: 'skipped', reason: 'Invalid amount' });
          continue;
        }

        const pending = await pendingCol.findOne({ paymentId: entryId, status: 'pending' }, { collation: { locale: 'en', strength: 2 } });

        if (!pending) {
          results.push({ paymentId: entryId, status: 'not_found', reason: 'No pending payment found with this ID' });
          continue;
        }

        if (Math.abs(pending.amount - entryAmt) > 1) {
          results.push({
            paymentId: entryId,
            status: 'amount_mismatch',
            reason: `Submitted amount ${entryAmt} does not match recorded amount ${pending.amount}`
          });
          continue;
        }

        await verifiedCol.insertOne({
          paymentId:     pending.paymentId,
          userId:        pending.userId,
          amount:        pending.amount,
          receiverName:  pending.receiverName,
          paymentMethod: pending.paymentMethod,
          verifiedAt:    new Date(),
          submittedAt:   pending.submittedAt
        });

        await pendingCol.deleteOne({ _id: pending._id });

        await usersCol.findOneAndUpdate(
          { phoneNumber: pending.userId },
          { $inc: { balance: pending.amount } },
          { upsert: false }
        );

        // ── Write verified notification to user ──────────────────────────
        await writeNotification(usersCol, pending.userId, {
          type:      'payment_verified',
          amount:    pending.amount,
          paymentId: pending.paymentId
        });

        results.push({
          paymentId: entryId,
          status:    'verified',
          userId:    pending.userId,
          amount:    pending.amount
        });
      }

      const verifiedCount = results.filter(r => r.status === 'verified').length;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, results, verifiedCount })
      };
    }

    // ── reject ─────────────────────────────────────────────────────────────
    if (action === 'reject') {
      const { paymentId } = body;
      if (!paymentId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'paymentId is required' }) };
      }

      const pid = String(paymentId).trim().toLowerCase();
      const pending = await pendingCol.findOne({ paymentId: pid, status: 'pending' }, { collation: { locale: 'en', strength: 2 } });

      if (!pending) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found with that ID' }) };
      }

      await pendingCol.deleteOne({ _id: pending._id });

      // ── Write rejected notification to user ──────────────────────────────
      await writeNotification(usersCol, pending.userId, {
        type:      'payment_rejected',
        amount:    pending.amount,
        paymentId: pending.paymentId
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `Payment ${paymentId} has been rejected and removed.`
        })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('admin-verify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};