const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    maxIdleTimeMS: 30000
});

// Reuse the same admin token verification logic as admin-auth
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'cverve_admin_secret';

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ── Admin lookup path (token + userId) ──────────────────────────────────
  if (body.token && body.userId) {
    // Validate admin token
    const { token, userId } = body;
    try {
      await client.connect();
      const db = client.db('cverve');

      // Verify token against stored admin record
      const adminsCol = db.collection('admins');
      const adminRecord = await adminsCol.findOne({});
      if (!adminRecord || adminRecord.token !== token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
      }

      // Look up the user by phone number
      const usersCol = db.collection('users');
      const user = await usersCol.findOne({ phoneNumber: userId });

      if (!user) {
        return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
      }

      // Look up Telegram info
      const tgCol = db.collection('telegram_chats');
      const tgRecord = await tgCol.findOne({ phoneNumber: userId });

      return {
        statusCode: 200,
        body: JSON.stringify({
          user: {
            phoneNumber: user.phoneNumber,
            balance: user.balance || 0,
            createdAt: user.createdAt || null,
            email: user.email || null,
            isBlocked: user.isBlocked || false,
            tgUsername: tgRecord?.username || null,
            hasTelegram: !!tgRecord
          }
        })
      };
    } catch (error) {
      console.error('Database error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ── Regular user login path (phoneNumber + password) ────────────────────
  const { phoneNumber, password } = body;

  if (!phoneNumber || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number and password are required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const collection = db.collection('users');

    const user = await collection.findOne({ phoneNumber });

    if (user) {
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (isPasswordValid) {
        // Check if user is blocked
        if (user.isBlocked) {
          return {
            statusCode: 403,
            body: JSON.stringify({ error: 'Your account has been blocked. Please contact support.' })
          };
        }

        const tgCol = db.collection('telegram_chats');
        const tgRecord = await tgCol.findOne({ phoneNumber });

        return {
          statusCode: 200,
          body: JSON.stringify({
            phoneNumber: user.phoneNumber,
            balance: user.balance,
            tgUsername: tgRecord?.username || null,
            hasTelegram: !!tgRecord
          })
        };
      } else {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid password' }) };
      }
    } else {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }
  } catch (error) {
    console.error('Database error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};