const { MongoClient } = require('mongodb');
const axios = require('axios');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const textract = require('textract');
const mime = require('mime-types');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId, screenshotData, screenshotType, fileName } = JSON.parse(event.body);
  
  if (!userId || !screenshotData) {
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: 'User ID and file are required' }) 
    };
  }

  const uri = process.env.MONGODB_URI;
  const client = new MongoClient(uri);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Extract text based on file type
    let extractedText = '';
    const fileBuffer = Buffer.from(screenshotData, 'base64');
    const mimeType = screenshotType || mime.lookup(fileName || '') || 'application/octet-stream';

    if (mimeType.startsWith('image/')) {
      // Process images with Tesseract OCR
      console.log('Processing image with OCR...');
      const { data: { text } } = await Tesseract.recognize(
        fileBuffer,
        'eng',
        {
          logger: m => console.log(m),
          // Enhanced configuration for better OCR accuracy
          tessedit_pageseg_mode: 6, // Assume a single uniform block of text
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .@:/,-_$€£¥₹ETBFTP#*+()'
        }
      );
      extractedText = text;
      console.log('OCR extracted text:', extractedText);
    } 
    else if (mimeType === 'application/pdf') {
      // Process PDF files
      console.log('Processing PDF...');
      const data = await pdfParse(fileBuffer);
      extractedText = data.text;
    }
    else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
             mimeType === 'application/msword') {
      // Process Word documents
      console.log('Processing Word document...');
      if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        extractedText = result.value;
      } else {
        // For .doc files, use textract
        extractedText = await new Promise((resolve, reject) => {
          textract.fromBufferWithMime(mimeType, fileBuffer, (error, text) => {
            if (error) reject(error);
            else resolve(text);
          });
        });
      }
    }
    else {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Unsupported file type. Please upload an image, PDF, or Word document.' 
        })
      };
    }

    // If no text was extracted, try OCR as fallback for all file types
    if (!extractedText || extractedText.trim().length < 10) {
      console.log('Text extraction failed, trying OCR fallback...');
      const { data: { text } } = await Tesseract.recognize(
        fileBuffer,
        'eng',
        {
          logger: m => console.log(m),
          tessedit_pageseg_mode: 6,
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .@:/,-_$€£¥₹ETBFTP#*+()'
        }
      );
      extractedText = text;
    }

    // If still no text, return error
    if (!extractedText || extractedText.trim().length < 10) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          success: false, 
          message: 'Could not extract text from the file. Please ensure the file is clear and readable.' 
        })
      };
    }

    console.log('Final extracted text:', extractedText);

    // Prepare prompt for payment verification
    const prompt = `
      Analyze this text extracted from a payment confirmation and extract the following information. If any information is not present, respond with 'Not found'.
      
      EXTRACTED TEXT:
      ${extractedText}
      
      Extract the following information from the text above:
      1. Name of the payment receiver.
      2. Amount of money transferred.
      3. The payment ID, which starts with "FT".

      You must respond with a JSON object only, using exactly these keys: receiver_name, amount, payment_id.

      IMPORTANT: For CBE (Commercial Bank of Ethiopia) payments, the receiver name is typically "Yilak Abay" or "Yilak Abay Abebe". 
      The amount should be in ETB. The payment ID always starts with "FT".
    `;

    // Send to DeepSeek API
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 1024,
        temperature: 0.1
      },
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
      // Fallback: Try to extract data manually from OCR text
      extractedData = extractPaymentDataManually(extractedText);
    }
    
    const { receiver_name, amount, payment_id } = extractedData;
    
    // Validate payment details with case-insensitive comparison
    const validNames = ['yilak abay', 'yilak abay abebe'];
    const receivedName = receiver_name ? receiver_name.toLowerCase() : '';
    
    if (!validNames.includes(receivedName) || amount < 30 || !payment_id || !payment_id.startsWith('FT')) {
      console.error('AI validation failed, trying manual extraction:', { receiver_name, amount, payment_id });
      // Try manual extraction as fallback
      const manualData = extractPaymentDataManually(extractedText);
      if (manualData.receiver_name && manualData.amount && manualData.payment_id) {
        extractedData = manualData;
      } else {
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            success: false, 
            message: 'Payment failed: Invalid details from screenshot. Please ensure the screenshot shows a valid CBE payment to Yilak Abay with at least 30 ETB and an FT number.' 
          })
        };
      }
    }
    
    await client.connect();
    const db = client.db('cverve');
    const paymentsCollection = db.collection('payments');
    const usersCollection = db.collection('users');
    
    // Check if payment ID has been used before
    const existingPayment = await paymentsCollection.findOne({ paymentId: extractedData.payment_id });
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
      paymentId: extractedData.payment_id, 
      userId, 
      amount: extractedData.amount, 
      timestamp: new Date() 
    });
    
    const user = await usersCollection.findOneAndUpdate(
      { userId },
      { $inc: { balance: extractedData.amount } },
      { returnDocument: 'after', upsert: true }
    );
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        newBalance: user.value.balance,
        extractedData: extractedData
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

// Manual extraction fallback function
function extractPaymentDataManually(text) {
  const result = {
    receiver_name: 'Not found',
    amount: 0,
    payment_id: 'Not found'
  };
  
  // Try to extract receiver name
  const nameRegex = /to\s+([Yy]ilak\s+[Aa]bay(?:\s+[Aa]bebe)?)/;
  const nameMatch = text.match(nameRegex);
  if (nameMatch) {
    result.receiver_name = nameMatch[1];
  }
  
  // Try to extract amount
  const amountRegex = /ETB\s+([0-9]+(?:\.[0-9]{2})?)/;
  const amountMatch = text.match(amountRegex);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1]);
  }
  
  // Try to extract payment ID (FT number)
  const ftRegex = /FT[0-9A-Z]{10,}/;
  const ftMatch = text.match(ftRegex);
  if (ftMatch) {
    result.payment_id = ftMatch[0];
  }
  
  return result;
}