// functions/process-payment.js
// Handles payment submission: extracts text from uploaded file,
// uses Gemini to parse payment details, validates, and stores as "pending".

const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

// ── Text extraction (exact same logic as extract-text.js) ───────────────────

async function extractTextFromImage(imageBuffer) {
  let processedBuffer;
  try {
    processedBuffer = await sharp(imageBuffer).grayscale().normalize().sharpen().toBuffer();
    console.log('Image pre-processing successful');
  } catch (processError) {
    console.log('Image pre-processing failed, using original:', processError.message);
    processedBuffer = imageBuffer;
  }
  try {
    const { data: { text } } = await tesseract.recognize(processedBuffer, 'eng', { logger: () => {} });
    if (text && text.trim().length > 0) return text;
    throw new Error('No text found in image');
  } catch {
    try {
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text || '[No text extracted]';
    } catch (fallbackError) {
      throw new Error('Could not extract text from image: ' + fallbackError.message);
    }
  }
}

async function extractTextFromFile(base64Data, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');

  if (mimeType.includes('pdf')) {
    try {
      const data = await pdfParse(buffer);
      if (data.text && data.text.trim().length > 0) {
        console.log('PDF text extracted, length:', data.text.length);
        return data.text;
      }
      // image-based PDF → fall through to OCR on the raw buffer
      console.log('PDF has no text layer, attempting OCR...');
      return await extractTextFromImage(buffer);
    } catch (err) {
      console.log('PDF parse failed, attempting OCR:', err.message);
      return await extractTextFromImage(buffer);
    }
  } else if (mimeType.includes('word') || mimeType.includes('document')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else if (mimeType.includes('image')) {
    return await extractTextFromImage(buffer);
  }
  throw new Error('Unsupported file type: ' + mimeType);
}

// ── Gemini extraction with retry + fallback ──────────────────────────────────

async function extractPaymentDetailsWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing Gemini API key');

  const genAI = new GoogleGenerativeAI(apiKey);
  const prompt = `
Analyze the following payment confirmation text and extract exactly:
1. receiver_name – the name of the person or account that received the money
2. payment_id   – the transaction/reference ID (usually starts with "FT", but include whatever ID is present)
3. amount       – numeric value only (no currency symbols)

Respond ONLY with a valid JSON object with keys: receiver_name, payment_id, amount.
If a field is not found, set its value to null.

Payment text:
${text}
  `.trim();

  const models = ['gemini-2.5-flash', 'gemini-2.5-pro'];
  let lastError;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName }, { apiVersion: 'v1beta' });
        const result = await model.generateContent(prompt);
        const raw = result.response.text().replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(raw);
        console.log(`Gemini (${modelName}) extracted:`, parsed);
        return parsed;
      } catch (err) {
        console.error(`Gemini attempt failed (${modelName}, attempt ${attempt + 1}):`, err.message);
        lastError = err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw new Error('Gemini extraction failed after retries: ' + lastError.message);
}

// ── Validation helpers ───────────────────────────────────────────────────────

function isValidReceiverName(name) {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return normalized === 'yilak abay' || normalized === 'yilak abay abebe';
}

// ── Handler ──────────────────────────────────────────────────────────────────

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

  const { userId, fileData, fileType, paymentMethod } = body;

  if (!userId || !fileData || !fileType) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'userId, fileData, and fileType are required' })
    };
  }

  try {
    // 1. Extract text from uploaded file (same path as CV/JD extraction)
    console.log('Extracting text from payment file, mimeType:', fileType);
    let extractedText;
    try {
      extractedText = await extractTextFromFile(fileData, fileType);
    } catch (err) {
      console.error('Text extraction failed:', err.message);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Could not read your file. Please upload a clear screenshot or PDF of the payment confirmation.' })
      };
    }

    if (!extractedText || extractedText.trim().length < 5) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No readable text found in the uploaded file. Please upload a clearer image or PDF.' })
      };
    }

    console.log('Extracted text length:', extractedText.length);

    // 2. Use Gemini to parse payment details
    let extracted;
    try {
      extracted = await extractPaymentDetailsWithGemini(extractedText);
    } catch (err) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to analyze payment details. Please try again in a moment.' })
      };
    }

    const { receiver_name, payment_id, amount } = extracted;

    // 3. Validate receiver name
    if (!isValidReceiverName(receiver_name)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Payment validation failed: The receiver name "${receiver_name || 'not found'}" does not match the expected account holder. Please make sure you sent money to the correct account.`
        })
      };
    }

    // 4. Validate amount
    const numericAmount = parseFloat(String(amount).replace(/[^\d.]/g, ''));
    if (isNaN(numericAmount) || numericAmount < 100) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Payment validation failed: The detected amount (${amount ?? 'not found'} ETB) is below the minimum of 100 ETB. Please top up with at least 100 ETB.`
        })
      };
    }

    // 5. Validate payment ID
    if (!payment_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Payment validation failed: Could not find a transaction ID in the uploaded file. Please upload the original payment confirmation.' })
      };
    }

    // 6. Check for duplicate payment ID
    await client.connect();
    const db = client.db('cverve');
    const pendingCol = db.collection('pending_payments');
    const verifiedCol = db.collection('payments');

    const alreadyPending  = await pendingCol.findOne({ paymentId: payment_id });
    const alreadyVerified = await verifiedCol.findOne({ paymentId: payment_id });

    if (alreadyPending || alreadyVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This payment ID has already been submitted or used. Please do not resubmit the same transaction.' })
      };
    }

    // 7. Store as pending
    await pendingCol.insertOne({
      paymentId: payment_id,
      userId,
      amount: numericAmount,
      receiverName: receiver_name,
      paymentMethod: paymentMethod || 'unknown',
      status: 'pending',
      submittedAt: new Date()
    });

    console.log('Payment stored as pending:', payment_id, 'amount:', numericAmount, 'user:', userId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        pending: true,
        message: 'Payment recorded. Awaiting admin verification (within 6 hours).',
        paymentId: payment_id,
        amount: numericAmount
      })
    };

  } catch (error) {
    console.error('Payment processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An unexpected error occurred. Please try again.' })
    };
  }
};