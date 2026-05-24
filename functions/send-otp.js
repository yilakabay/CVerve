// functions/send-otp.js
// POST body: { phoneNumber }
// Generates a 6-digit OTP, stores it in MongoDB with a 10-minute expiry,
// and sends it via Twilio SMS.

const { MongoClient } = require('mongodb');
const twilio = require('twilio');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

function formatEthiopianPhone(phone) {
  // Convert 09XXXXXXXX or 07XXXXXXXX to international +2519XXXXXXXX / +2517XXXXXXXX
  const cleaned = phone.replace(/\s+/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('09')) return '+251' + cleaned.slice(1);
  if (cleaned.startsWith('07')) return '+251' + cleaned.slice(1);
  return cleaned;
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

  const { phoneNumber } = body;

  if (!phoneNumber) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number is required' }) };
  }

  // Basic Ethiopian phone validation
  if (!/^(09|07)\d{8}$/.test(phoneNumber)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Phone number must start with 09 or 07 and be 10 digits total' })
    };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const usersCol = db.collection('users');
    const otpCol   = db.collection('otp_codes');

    // Check if user already exists
    const existing = await usersCol.findOne({ phoneNumber });
    if (existing) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'An account with this phone number already exists. Please log in.' })
      };
    }

    // Rate-limit: allow max 3 OTPs per phone per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCount = await otpCol.countDocuments({
      phoneNumber,
      createdAt: { $gte: tenMinutesAgo }
    });
    if (recentCount >= 3) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Too many OTP requests. Please wait a few minutes and try again.' })
      };
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Upsert: replace any existing pending OTP for this phone
    await otpCol.findOneAndUpdate(
      { phoneNumber },
      {
        $set: {
          phoneNumber,
          otp,
          expiresAt,
          verified: false,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    // Send SMS via Twilio
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const internationalPhone = formatEthiopianPhone(phoneNumber);

    await twilioClient.messages.create({
      body: `Your CVerve verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: internationalPhone
    });

    console.log(`OTP sent to ${internationalPhone}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'OTP sent successfully' })
    };

  } catch (error) {
    console.error('send-otp error:', error);

    // Give a useful message if Twilio fails
    if (error.code && error.code.toString().startsWith('2')) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Failed to send SMS. Please check your phone number and try again.' })
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error. Please try again.' })
    };
  }
};