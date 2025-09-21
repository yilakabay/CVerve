const { MongoClient } = require('mongodb');
const axios = require('axios');
const tesseract = require('tesseract.js');

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
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Extract text from screenshot using OCR
    // Ensure we have proper base64 data (remove data URI prefix if present)
    let cleanScreenshotData = screenshotData;
    if (screenshotData.includes('base64,')) {
      cleanScreenshotData = screenshotData.split('base64,')[1];
    }
    
    const buffer = Buffer.from(cleanScreenshotData, 'base64');
    const { data: { text } } = await tesseract.recognize(buffer, 'eng');
    
    // For debugging - log the extracted text
    console.log('Extracted text from image:', text);
    
    // Call DeepSeek API to extract payment details
    const prompt = `
      Analyze the following payment text from CBE and extract the following information. If any information is not present, respond with 'Not found'.
      1. Name of the payment receiver.
      2. Amount of money transferred (extract only the numeric value, without currency symbols).
      3. The payment ID, which starts with "FT".
      
      Please format your response as a JSON object with keys: receiver_name, amount, payment_id.
      
      Payment Text:
      ${text}
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );

    const extractedData = JSON.parse(response.data.choices[0].message.content);
    const { receiver_name, amount, payment_id } = extractedData;
    
    // For debugging - log the extracted data
    console.log('Extracted data:', extractedData);
    
    // Convert amount to number, handling Ethiopian currency format
    let numericAmount;
    if (typeof amount === 'string') {
      // Remove "ETB", commas, and any other non-numeric characters except decimal point
      numericAmount = parseFloat(amount.replace(/ETB|[^\d.]/g, ''));
    } else {
      numericAmount = parseFloat(amount);
    }
    
    // For debugging - log the numeric amount
    console.log('Numeric amount:', numericAmount);
    
    // Validate payment details
    const validNames = ['Yilak Abay', 'Yilak Abay Abebe', 'YILAK ABAY', 'YILAK ABAY ABEBE'];
    if (!validNames.includes(receiver_name) || isNaN(numericAmount) || numericAmount < 30 || !payment_id || !payment_id.startsWith('FT')) {
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
      amount: numericAmount, 
      timestamp: new Date() 
    });
    
    const user = await usersCollection.findOneAndUpdate(
      { userId },
      { $inc: { balance: numericAmount } },
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