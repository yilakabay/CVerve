const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ─────────────────────────────────────────────────────────────────
// 1. EXTRACT TEXT FROM PAYMENT FILE (same as extract-text.js)
// ─────────────────────────────────────────────────────────────────
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
    // Pre‑process image for better OCR
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

// ─────────────────────────────────────────────────────────────────
// 2. GEMINI CALL WITH RETRY (handles 503 Service Unavailable)
// ─────────────────────────────────────────────────────────────────
async function callGeminiWithRetry(model, prompt, retries = 3, initialDelay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result;
    } catch (err) {
      const is503 = err.message?.includes('503') || err.status === 503;
      if (is503 && attempt < retries) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.log(`Gemini 503 error, retrying in ${delay}ms (attempt ${attempt}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. MAIN HANDLER
// ─────────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { userId, screenshotData, screenshotType, paymentMethod } = body;
  if (!userId || !screenshotData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'User ID and screenshot are required' }) };
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Gemini API key missing' }) };
  }

  // Clean base64 data
  let cleanData = screenshotData;
  if (screenshotData.includes('base64,')) cleanData = screenshotData.split('base64,')[1];

  // Step 1: Extract text from file (robust, same as CV/JD)
  let extractedText;
  try {
    extractedText = await extractTextFromPaymentFile(cleanData, screenshotType);
    console.log(`Extracted text length: ${extractedText.length}`);
    if (extractedText.length < 20) {
      throw new Error('Extracted text too short');
    }
  } catch (extractError) {
    console.error('Text extraction failed:', extractError.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Could not read payment receipt. Please upload a clear image or PDF of the transaction confirmation.' })
    };
  }

  // Step 2: Parse with Gemini (using text only)
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // more stable than 2.5-flash

  const prompt = `
You are a payment receipt parser. Extract the following from the text below.

Text:
${extractedText}

Return ONLY valid JSON: {"receiver_name": "...", "payment_id": "...", "amount": number}

Rules:
- receiver_name: must be exactly "Yilak Abay" or "Yilak Abay Abebe" (case insensitive). If not found, use null.
- payment_id: a transaction reference. For CBE it often starts with "FT". If multiple, pick the one that looks like a transaction ID. Use null if none.
- amount: numeric value in ETB (e.g. 100). Ignore currency symbols. Use null if not found.
`;

  let result;
  try {
    result = await callGeminiWithRetry(model, prompt);
  } catch (geminiError) {
    console.error('Gemini error after retries:', geminiError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment verification service temporarily unavailable. Please try again in a few minutes.' })
    };
  }

  const responseText = result.response.text();
  let extracted;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : responseText;
    extracted = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error('Failed to parse Gemini response:', responseText);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Could not parse payment details. Please ensure the receipt is complete and readable.' })
    };
  }

  const { receiver_name, payment_id, amount } = extracted;
  if (!receiver_name || !payment_id || amount === undefined || amount === null) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing required fields (receiver name, payment ID, or amount). Please upload a complete transaction receipt.' })
    };
  }

  // Validate receiver name (case‑insensitive)
  const validNames = ['Yilak Abay', 'Yilak Abay Abebe', 'YILAK ABAY', 'YILAK ABAY ABEBE'];
  const nameMatch = validNames.some(name => name.toLowerCase() === receiver_name.toLowerCase());
  if (!nameMatch) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Payment receiver name mismatch. Payment failed.' }) };
  }

  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount < 100) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Amount must be at least 100 ETB.' }) };
  }

  // Step 3: Store pending payment in MongoDB
  await client.connect();
  const db = client.db('cverve');
  const paymentsCollection = db.collection('payments');
  const existing = await paymentsCollection.findOne({ paymentId: payment_id });
  if (existing) {
    await client.close();
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'This payment ID has already been used.' }) };
  }

  const pendingPayments = db.collection('pendingPayments');
  await pendingPayments.insertOne({
    userId,
    paymentId: payment_id,
    amount: numericAmount,
    paymentMethod,
    receiverName: receiver_name,
    screenshotData: cleanData,
    extractedText: extractedText.substring(0, 500), // store preview for debugging
    status: 'pending',
    createdAt: new Date()
  });

  await client.close();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, message: 'Payment recorded. Awaiting admin verification (within 6 hours).' })
  };
};