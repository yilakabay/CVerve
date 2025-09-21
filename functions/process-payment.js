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
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Prepare prompt for payment verification
    const prompt = `
      Analyze this payment screenshot from CBE (Commercial Bank of Ethiopia) and extract the following information. If any information is not present, respond with 'Not found'.
      1. Name of the payment receiver.
      2. Amount of money transferred.
      3. The payment ID, which starts with "FT".

      You must respond with a JSON object only, using exactly these keys: receiver_name, amount, payment_id.
    `;

    // Prepare the request payload for DeepSeek VL API
    const payload = {
      model: "deepseek-vl",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${screenshotType};base64,${screenshotData}`
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 1024
    };

    // Make request to DeepSeek API
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    
    // Parse the JSON response from the AI
    let extractedData;
    try {
      extractedData = JSON.parse(aiResponse);
    } catch (e) {
      console.error('Failed to parse AI response as JSON:', aiResponse);
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Payment verification failed: Could not parse response.' 
        })
      };
    }
    
    const { receiver_name, amount, payment_id } = extractedData;
    
    // Validate payment details with case-insensitive comparison
    const validNames = ['yilak abay', 'yilak abay abebe'];
    const receivedName = receiver_name ? receiver_name.toLowerCase() : '';
    
    if (!validNames.includes(receivedName) || amount < 30 || !payment_id || !payment_id.startsWith('FT')) {
      console.error('Validation failed:', { receiver_name, amount, payment_id });
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Payment failed: Invalid details from screenshot. Please ensure the screenshot shows a valid CBE payment to Yilak Abay with at least 30 ETB and an FT number.' 
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
        message: 'An unexpected error occurred during payment processing. Please try again.' 
      })
    };
  } finally {
    await client.close();
  }
};