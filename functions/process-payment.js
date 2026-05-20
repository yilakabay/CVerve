const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// 🔁 Reuse exact extraction logic from extract-text.js (single file)
async function extractTextFromPaymentFile(base64Data, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');

  if (mimeType.includes('pdf')) {
    const data = await pdfParse(buffer);
    if (data.text && data.text.trim().length > 0) return data.text;
    throw new Error('PDF contains no extractable text');
  }

  if (mimeType.includes('word') || mimeType.includes('document')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType.includes('image')) {
    // Pre-process image for better OCR (same as extract-text.js)
    let processedBuffer;
    try {
      processedBuffer = await sharp(buffer)
        .grayscale()
        .normalize()
        .sharpen()
        .toBuffer();
    } catch {
      processedBuffer = buffer;
    }
    const { data: { text } } = await tesseract.recognize(processedBuffer, 'eng');
    if (text && text.trim().length > 0) return text;
    throw new Error('No text found in image');
  }

  throw new Error('Unsupported file type: ' + mimeType);
}

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

    // Extract text from the uploaded file (image, PDF, Word) – same as CV/JD extraction
    let extractedText;
    try {
      extractedText = await extractTextFromPaymentFile(cleanData, screenshotType);
      console.log('Extracted text length:', extractedText.length);
    } catch (extractError) {
      console.error('Text extraction failed:', extractError.message);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Could not read the payment receipt. Please upload a clear image or PDF of the transaction receipt.' })
      };
    }

    if (!extractedText || extractedText.trim().length < 20) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'The uploaded file does not contain enough readable text. Please upload a clearer screenshot or PDF of the payment confirmation.' })
      };
    }

    // Now use Gemini to parse the extracted text
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: "v1beta" });

    const prompt = `You are a payment receipt parser. Extract the following information from the text below:

1. Receiver name (the person or company that received the money). It should match "Yilak Abay" or "Yilak Abay Abebe" (case insensitive). If not present, put null.
2. Payment ID – this is a transaction reference number. For CBE it often starts with "FT" or is a long alphanumeric string. If not present, put null.
3. Amount – the amount of money transferred in ETB (numeric value only, ignore currency symbols like ETB, Birr, etc.). If not present, put null.

Return ONLY a valid JSON object in this exact format:
{"receiver_name": "...", "payment_id": "...", "amount": number}

If you cannot find a field, use null.

Here is the payment receipt text:
${extractedText}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let extracted;
    try {
      // Clean possible markdown code fences
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : responseText;
      extracted = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Gemini response not JSON:', responseText);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Could not parse payment details from the receipt. Please ensure the image is clear and contains the required information.' })
      };
    }

    const { receiver_name, payment_id, amount } = extracted;
    if (!receiver_name || !payment_id || amount === undefined || amount === null) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields in payment proof (receiver name, payment ID, or amount). Please upload a complete transaction receipt.' })
      };
    }

    // Validate receiver name (case-insensitive)
    const validNames = ['Yilak Abay', 'Yilak Abay Abebe', 'YILAK ABAY', 'YILAK ABAY ABEBE'];
    const nameMatch = validNames.some(name => name.toLowerCase() === receiver_name.toLowerCase());
    if (!nameMatch) {
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
      extractedText: extractedText.substring(0, 1000), // store preview for debugging
      status: 'pending',
      createdAt: new Date(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Payment recorded. Awaiting admin verification (within 6 hours).' })
    };
  } catch (error) {
    console.error('Payment processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error: ' + error.message })
    };
  } finally {
    await client.close();
  }
};