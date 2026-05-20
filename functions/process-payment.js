const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

const uri = process.env.MONGODB_URI;
let cachedClient = null;

// ─────────────────────────────────────────────────────────────────
// 1. MONGODB CONNECTION (reuse across warm invocations)
// ─────────────────────────────────────────────────────────────────
async function getMongoClient() {
  if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
    return cachedClient;
  }
  cachedClient = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  });
  await cachedClient.connect();
  return cachedClient;
}

// ─────────────────────────────────────────────────────────────────
// 2. EXTRACT TEXT FROM PAYMENT FILE
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
// 3. GEMINI CALL WITH RETRY (handles 503 + logs real errors)
// ─────────────────────────────────────────────────────────────────
async function callGeminiWithRetry(model, prompt, retries = 3, initialDelay = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result;
    } catch (err) {
      lastError = err;

      // Always log the real error for debugging
      console.error(`Gemini attempt ${attempt}/${retries} failed — status: ${err.status ?? 'unknown'}, message: ${err.message}`);

      const status = err.status ?? 0;
      const msg = err.message ?? '';

      // Only retry on 503 (overloaded) or network errors
      const shouldRetry =
        status === 503 ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('fetch failed');

      if (shouldRetry && attempt < retries) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For auth/rate limit/not-found errors, fail immediately — no point retrying
      break;
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────
// 4. MAIN HANDLER
// ─────────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  // ── Parse request body ──
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
  }

  const { userId, screenshotData, screenshotType, paymentMethod } = body;

  if (!userId || !screenshotData) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'User ID and screenshot are required' }),
    };
  }

  // ── Check env vars upfront ──
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('GEMINI_API_KEY environment variable is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error. Please contact support.' }),
    };
  }

  if (!uri) {
    console.error('MONGODB_URI environment variable is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error. Please contact support.' }),
    };
  }

  // ── Clean base64 ──
  let cleanData = screenshotData;
  if (screenshotData.includes('base64,')) {
    cleanData = screenshotData.split('base64,')[1];
  }

  // ── Step 1: Extract text from file ──
  let extractedText;
  try {
    extractedText = await extractTextFromPaymentFile(cleanData, screenshotType);
    console.log(`Extracted text length: ${extractedText.length}`);

    if (!extractedText || extractedText.trim().length < 20) {
      throw new Error('Extracted text too short to be a valid receipt');
    }
  } catch (extractError) {
    console.error('Text extraction failed:', extractError.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Could not read payment receipt. Please upload a clear image or PDF of the transaction confirmation.',
      }),
    };
  }

  // ── Step 2: Parse with Gemini ──
  let extracted;
  try {
    const genAI = new GoogleGenerativeAI(geminiApiKey);

    // gemini-2.0-flash is current, stable, and fast
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `
You are a payment receipt parser. Extract the following from the text below.

Text:
${extractedText}

Return ONLY valid JSON with no markdown, no backticks, no explanation:
{"receiver_name": "...", "payment_id": "...", "amount": number}

Rules:
- receiver_name: must be exactly "Yilak Abay" or "Yilak Abay Abebe" (case insensitive). If not found, use null.
- payment_id: a transaction reference. For CBE it often starts with "FT". If multiple, pick the one that looks like a transaction ID. Use null if none.
- amount: numeric value in ETB (e.g. 100). Ignore currency symbols. Use null if not found.
`;

    const result = await callGeminiWithRetry(model, prompt);
    const responseText = result.response.text();

    console.log('Gemini raw response:', responseText);

    // Strip markdown fences if present
    const clean = responseText.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in Gemini response');

    extracted = JSON.parse(jsonMatch[0]);
  } catch (geminiError) {
    console.error('Gemini error:', geminiError.status, geminiError.message);

    // Give a specific message for known error types
    const status = geminiError.status ?? 0;
    const msg = geminiError.message ?? '';

    if (status === 401 || msg.includes('API_KEY') || msg.includes('authentication')) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Payment service authentication error. Please contact support.' }),
      };
    }

    if (status === 429 || msg.includes('quota') || msg.includes('RATE_LIMIT')) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Payment verification is busy. Please try again in a minute.' }),
      };
    }

    if (msg.includes('No JSON')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Could not parse payment details. Please ensure the receipt is complete and readable.' }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment verification service temporarily unavailable. Please try again in a few minutes.' }),
    };
  }

  // ── Step 3: Validate extracted fields ──
  const { receiver_name, payment_id, amount } = extracted;

  if (!receiver_name || !payment_id || amount === undefined || amount === null) {
    console.error('Missing fields in extracted data:', extracted);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing required fields (receiver name, payment ID, or amount). Please upload a complete transaction receipt.',
      }),
    };
  }

  const validNames = ['yilak abay', 'yilak abay abebe'];
  if (!validNames.includes(receiver_name.toLowerCase().trim())) {
    console.error('Receiver name mismatch:', receiver_name);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Payment receiver name mismatch. Please ensure you paid to the correct account.' }),
    };
  }

  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount < 100) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Amount must be at least 100 ETB.' }),
    };
  }

  // ── Step 4: Store in MongoDB ──
  try {
    const client = await getMongoClient();
    const db = client.db('cverve');

    // Check for duplicate payment ID
    const existing = await db.collection('payments').findOne({ paymentId: payment_id });
    if (existing) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'This payment ID has already been used.' }),
      };
    }

    await db.collection('pendingPayments').insertOne({
      userId,
      paymentId: payment_id,
      amount: numericAmount,
      paymentMethod,
      receiverName: receiver_name,
      screenshotData: cleanData,
      extractedText: extractedText.substring(0, 500),
      status: 'pending',
      createdAt: new Date(),
    });
  } catch (dbError) {
    console.error('MongoDB error:', dbError.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Database error. Please try again.' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'Payment recorded. Awaiting admin verification (within 6 hours).',
    }),
  };
};