const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId, screenshotData, screenshotType, paymentMethod } = JSON.parse(event.body);
  if (!userId || !screenshotData) {
    return { statusCode: 400, body: JSON.stringify({ error: 'User ID and screenshot are required' }) };
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Gemini API key missing' }) };
  }

  try {
    // Clean base64 data
    let cleanData = screenshotData;
    if (screenshotData.includes('base64,')) cleanData = screenshotData.split('base64,')[1];
    const buffer = Buffer.from(cleanData, 'base64');

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: "v1beta" });

    const prompt = `Extract from this payment receipt image (CBE, CBEBirr, or bank transfer):
1. Receiver name (the person/company that received the money)
2. Payment ID (starts with "FT" or a transaction reference number)
3. Amount (numeric value only, in ETB)

Return only JSON: {"receiver_name": "...", "payment_id": "...", "amount": number}`;

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: screenshotType, data: cleanData } }
    ]);
    const responseText = result.response.text();
    let extracted;
    try {
      extracted = JSON.parse(responseText);
    } catch (e) {
      console.error('Gemini response not JSON:', responseText);
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not extract payment details. Ensure the image is clear.' }) };
    }

    const { receiver_name, payment_id, amount } = extracted;
    if (!receiver_name || !payment_id || !amount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields in payment proof.' }) };
    }

    // Validate receiver name (case-insensitive)
    const validNames = ['Yilak Abay', 'Yilak Abay Abebe', 'YILAK ABAY', 'YILAK ABAY ABEBE'];
    if (!validNames.some(name => name.toLowerCase() === receiver_name.toLowerCase())) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Payment receiver name mismatch. Payment failed.' }) };
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 100) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Amount must be at least 100 ETB.' }) };
    }

    await client.connect();
    const db = client.db('cverve');
    const paymentsCollection = db.collection('payments');
    const existing = await paymentsCollection.findOne({ paymentId: payment_id });
    if (existing) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This payment ID has already been used.' }) };
    }

    // Store pending payment
    const pendingPayments = db.collection('pendingPayments');
    await pendingPayments.insertOne({
      userId,
      paymentId: payment_id,
      amount: numericAmount,
      paymentMethod,
      receiverName: receiver_name,
      screenshotData: cleanData,
      status: 'pending',
      createdAt: new Date(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Payment recorded. Awaiting admin verification (within 6 hours).' })
    };
  } catch (error) {
    console.error('Payment processing error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  } finally {
    await client.close();
  }
};