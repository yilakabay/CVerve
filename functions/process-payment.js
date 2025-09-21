const { MongoClient } = require('mongodb');
const axios = require('axios');
const FormData = require('form-data');

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
    // Prepare prompt for payment verification
    const prompt = `
      Analyze the following payment screenshot from CBE and extract the following information. If any information is not present, respond with 'Not found'.
      1. Name of the payment receiver.
      2. Amount of money transferred.
      3. The payment ID, which starts with "FT".
      
      Please format your response as a JSON object with keys: receiver_name, amount, payment_id.
    `;

    // Create form data for multipart request
    const formData = new FormData();
    
    // Add screenshot to form data
    const screenshotBuffer = Buffer.from(screenshotData, 'base64');
    
    formData.append('file', screenshotBuffer, {
      filename: 'payment.' + screenshotType.split('/')[1],
      contentType: screenshotType
    });

    // Add the JSON payload
    const payload = {
      model: "deepseek-reasoner",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };
    
    formData.append('payload', JSON.stringify(payload));

    // Make request to DeepSeek API
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    
    // Parse the JSON response from the AI
    let extractedData;
    try {
      extractedData = JSON.parse(aiResponse);
    } catch (e) {
      // If it's not valid JSON, try to extract the information manually
      const amountMatch = aiResponse.match(/"amount":\s*(\d+\.?\d*)/);
      const receiverMatch = aiResponse.match(/"receiver_name":\s*"([^"]*)"/);
      const paymentIdMatch = aiResponse.match(/"payment_id":\s*"([^"]*)"/);
      
      extractedData = {
        receiver_name: receiverMatch ? receiverMatch[1] : "Not found",
        amount: amountMatch ? parseFloat(amountMatch[1]) : 0,
        payment_id: paymentIdMatch ? paymentIdMatch[1] : "Not found"
      };
    }
    
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