// functions/payment-report.js
// POST body: { userId, password, pendingId }
//
// Called when the user taps "Report" on the account page — shown only once a
// payment has been pending 30+ minutes with no automatic resolution from SMS
// detection. Flags the pending_payments doc so it surfaces at the top of the
// admin's manual review queue (admin-verify.js action:'list' sorts reported
// entries first).
//
// Uses pendingId (the pending record's Mongo _id) rather than a transaction
// ID, since a payment screenshot may not show one — matching throughout this
// system is by sender name + amount only.
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const uri    = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { userId, password, pendingId } = body;
  if (!userId || !pendingId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId and pendingId are required.' }) };
  }
  try {
    await client.connect();
    const db       = client.db('cverve');
    const usersCol = db.collection('users');
    const pendingCol = db.collection('pending_payments');
    const user = await usersCol.findOne({ phoneNumber: userId });
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'User not found.' }) };
    if (password) {
      const pwOk = await bcrypt.compare(password, user.password);
      if (!pwOk) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }
    let pending;
    try { pending = await pendingCol.findOne({ _id: new ObjectId(pendingId), userId, status: 'pending' }); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid pendingId.' }) }; }
    if (!pending) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No pending payment found for your account. It may already have been resolved.' }) };
    }
    const ageMs = Date.now() - new Date(pending.submittedAt).getTime();
    if (ageMs < 30 * 60 * 1000) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please wait until 30 minutes have passed since your payment before reporting.' }) };
    }
    await pendingCol.updateOne(
      { _id: pending._id },
      { $set: { reported: true, reportedAt: new Date() } }
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Your payment has been flagged for manual review by our Payment Review Team.' })
    };
  } catch (error) {
    console.error('payment-report error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }) };
  }
};