// functions/payment-report.js
// Handles user payment dispute reports with escalation tiers:
//   30 min  → first report allowed
//   1 hr    → re-report if no admin response
//   72 hr   → re-report again
//   1 week  → final re-report; after that, no more reports allowed
//
// Actions: 'submit' | 'list' (admin) | 'respond' (admin verify/reject)

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const TIERS = [
  { label: '30min', waitMs: 30 * 60 * 1000 },          // first report: after 30 min
  { label: '1hr',   waitMs:  1 * 60 * 60 * 1000 },     // re-report: after 1 hr
  { label: '72hr',  waitMs: 72 * 60 * 60 * 1000 },     // re-report: after 72 hr
  { label: '1week', waitMs:  7 * 24 * 60 * 60 * 1000 },// final re-report: after 1 week
];
const MAX_TIERS = TIERS.length; // after tier 4 (1week), no more reports

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const secret = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (sig !== expected) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

async function writeNotification(usersCol, userId, notification) {
  try {
    await usersCol.updateOne(
      { phoneNumber: userId },
      { $push: { notifications: { ...notification, createdAt: new Date(), read: false } } }
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

  const { action } = body;

  try {
    await mongo.connect();
    const db         = mongo.db('cverve');
    const reportsCol = db.collection('payment_reports');
    const pendingCol = db.collection('pending_payments');
    const usersCol   = db.collection('users');

    // ── USER: submit a report ───────────────────────────────────────────────
    if (action === 'submit') {
      const { userId, paymentId } = body;
      if (!userId || !paymentId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'userId and paymentId are required.' }) };
      }

      // Confirm pending payment exists for this user
      const pending = await pendingCol.findOne({
        paymentId: { $regex: new RegExp('^' + paymentId.trim() + '$', 'i') },
        userId,
        status: 'pending'
      });
      if (!pending) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found with that ID for your account.' }) };
      }

      const submittedAt = new Date(pending.submittedAt);
      const now         = Date.now();
      const ageMs       = now - submittedAt.getTime();

      // Must wait at least 30 min from payment submission
      if (ageMs < TIERS[0].waitMs) {
        const minsLeft = Math.ceil((TIERS[0].waitMs - ageMs) / 60000);
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `You can only report after 30 minutes. Please wait ${minsLeft} more minute(s).` })
        };
      }

      // Find existing report for this paymentId
      const existing = await reportsCol.findOne({ paymentId: pending.paymentId, userId });

      if (existing) {
        // Can't report again if admin hasn't responded yet
        if (existing.status === 'open') {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Your report is already submitted and awaiting review. You cannot report again until the admin responds.' })
          };
        }

        // Admin responded — check if user can escalate
        const tierIndex = existing.tierIndex ?? 0;
        const nextTier  = tierIndex + 1;

        if (nextTier >= MAX_TIERS) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'You have reached the maximum number of reports for this payment. No further reports are allowed.' })
          };
        }

        // Check escalation wait time from last report date
        const lastReportedAt = new Date(existing.reportedAt).getTime();
        const waitMs         = TIERS[nextTier].waitMs;
        if (now - lastReportedAt < waitMs) {
          const hoursLeft = Math.ceil((waitMs - (now - lastReportedAt)) / 3600000);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: `You can re-report in ${hoursLeft} more hour(s).` })
          };
        }

        // Replace old report with new escalated one (only new one visible to admin)
        await reportsCol.replaceOne(
          { _id: existing._id },
          {
            paymentId:   pending.paymentId,
            userId,
            amount:      pending.amount,
            paymentMethod: pending.paymentMethod,
            submittedAt: pending.submittedAt,
            reportedAt:  new Date(),
            status:      'open',
            tierIndex:   nextTier,
            tierLabel:   TIERS[nextTier].label,
          }
        );

        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, tier: TIERS[nextTier].label, message: 'Your escalated report has been submitted.' })
        };
      }

      // First report ever
      await reportsCol.insertOne({
        paymentId:    pending.paymentId,
        userId,
        amount:       pending.amount,
        paymentMethod: pending.paymentMethod,
        submittedAt:  pending.submittedAt,
        reportedAt:   new Date(),
        status:       'open',
        tierIndex:    0,
        tierLabel:    TIERS[0].label,
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, tier: TIERS[0].label, message: 'Your report has been submitted. The Payment Review Team will respond shortly.' })
      };
    }

    // ── ADMIN: list open reports ────────────────────────────────────────────
    if (action === 'list') {
      const { token } = body;
      if (!verifyAdminToken(token)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

      // Sort by reportedAt ascending — oldest first so admin resolves oldest reports first
      const reports = await reportsCol
        .find({ status: 'open' })
        .sort({ reportedAt: 1 })
        .toArray();

      return { statusCode: 200, body: JSON.stringify({ success: true, reports }) };
    }

    // ── ADMIN: respond to a report (verify or reject) ───────────────────────
    if (action === 'respond') {
      const { token, reportId, decision, reason } = body;
      if (!verifyAdminToken(token)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
      if (!reportId || !decision)   return { statusCode: 400, body: JSON.stringify({ error: 'reportId and decision are required.' }) };
      if (!['verify', 'reject'].includes(decision)) return { statusCode: 400, body: JSON.stringify({ error: 'decision must be verify or reject.' }) };

      const { ObjectId } = require('mongodb');
      const report = await reportsCol.findOne({ _id: new ObjectId(reportId) });
      if (!report) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found.' }) };
      if (report.status !== 'open') return { statusCode: 400, body: JSON.stringify({ error: 'This report has already been resolved.' }) };

      const verifiedCol = db.collection('payments');

      if (decision === 'verify') {
        // Move to verified payments
        await verifiedCol.insertOne({
          paymentId:    report.paymentId,
          userId:       report.userId,
          amount:       report.amount,
          paymentMethod: report.paymentMethod,
          verifiedAt:   new Date(),
          submittedAt:  report.submittedAt,
          reviewedViaReport: true,
        });
        // Update user balance
        await usersCol.findOneAndUpdate(
          { phoneNumber: report.userId },
          { $inc: { balance: report.amount } },
          { upsert: false }
        );
        // Delete pending payment
        await pendingCol.deleteOne({
          paymentId: report.paymentId,
          userId: report.userId
        });
        // Close report
        await reportsCol.updateOne(
          { _id: report._id },
          { $set: { status: 'resolved', decision: 'verify', resolvedAt: new Date() } }
        );
        // Notify user — Payment Review Team
        await writeNotification(usersCol, report.userId, {
          type:      'report_verified',
          sender:    'Payment Review Team',
          amount:    report.amount,
          paymentId: report.paymentId,
        });
      } else {
        // Reject
        await pendingCol.deleteOne({ paymentId: report.paymentId, userId: report.userId });
        await reportsCol.updateOne(
          { _id: report._id },
          { $set: { status: 'resolved', decision: 'reject', reason: reason || '', resolvedAt: new Date() } }
        );
        // Notify user
        await writeNotification(usersCol, report.userId, {
          type:      'report_rejected',
          sender:    'Payment Review Team',
          amount:    report.amount,
          paymentId: report.paymentId,
          reason:    reason || '',
        });
      }

      return { statusCode: 200, body: JSON.stringify({ success: true, decision }) };
    }

    // ── USER: check report status ───────────────────────────────────────────
    if (action === 'status') {
      const { userId, paymentId } = body;
      if (!userId || !paymentId) return { statusCode: 400, body: JSON.stringify({ error: 'userId and paymentId required.' }) };
      const report = await reportsCol.findOne({ paymentId, userId });
      return { statusCode: 200, body: JSON.stringify({ success: true, report: report || null }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };

  } catch (err) {
    console.error('payment-report error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};