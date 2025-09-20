const { MongoClient } = require('mongodb');
const axios = require('axios');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId, screenshotData, screenshotType } = JSON.parse(event.body);
  
  if (!userId || !screenshotData) {
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: 'User ID and screenshot are required' }) 
    };
  }

  const uri = process.env.MONGODB_URI;
  const client = new MongoClient(uri);
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    // Call Gemini API to extract payment details
    const prompt = `
      Analyze the following payment screenshot from CBE and extract the following information. If any information is not present, respond with 'Not found'.
      1. Name of the payment receiver.
      2. Amount of money transferred.
      3. The payment ID, which starts with "FT".
      
      Please format your response as a JSON object with keys: receiver_name, amount, payment_id.
    `;

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: screenshotType, data: screenshotData } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            "receiver_name": { "type": "STRING" },
            "amount": { "type": "NUMBER" },
            "payment_id": { "type": "STRING" }
          },
        }
      }
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const extractedData = JSON.parse(response.data.candidates[0].content.parts[0].text);
    const { receiver_name, amount, payment_id } = extractedData;
    
    // Validate payment details
    const validNames = ['Yilak Abay', 'Yilak Abay Abebe', 'YILAK ABAY', 'YILAK ABAY ABEBE'];
    if (!validNames.includes(receiver_name) || amount < 30 || !payment_id || !payment_id.startsWith('FT')) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Payment failed: Invalid details from screenshot.' 
        })
      };
    }
    
    await client.connect();
    const db = client.db('cverve');
    const paymentsCollection = db.collection('payments');
    const usersCollection = db.collection('users');
    
    // Check if payment ID has been used before
    const existingPayment = await paymentsCollection.findOne({ paymentId: payment_id });
    if (existingPayment) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Payment failed: This payment ID has already been used.' 
        })
      };
    }
    
    // Record payment and update balance
    await paymentsCollection.insertOne({ 
      paymentId: payment_id, 
      userId, 
      amount, 
      timestamp: new Date() 
    });
    
    const user = await usersCollection.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount } },
      { returnDocument: 'after', upsert: true }
    );
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        newBalance: user.value.balance 
      })
    };
  } catch (error) {
    console.error('Payment processing error:', error.response?.data || error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        success: false, 
        message: 'An unexpected error occurred during payment processing.' 
      })
    };
  } finally {
    await client.close();
  }
}; 