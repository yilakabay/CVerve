const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const tesseract = require('tesseract.js');
const sharp    = require('sharp');

// ── Time budget ──────────────────────────────────────────────────────────
// OCR with tesseract is slow, and the function used to keep going until the
// platform killed it — the user then got a plain error and NOTHING was read.
// Now each file gets only the time that is left in this budget. If a file
// takes too long, it is reported as "took too long" and the function still
// answers in time with whatever WAS read, so the app can show a clear message
// (or fall back to reading the PDF as page images, a couple of pages at a time).
// Keep this comfortably under the function's timeout (netlify.toml / dashboard).
const EXTRACTION_BUDGET_MS = 20000;
const MIN_TIME_TO_START_FILE_MS = 2000;

// Resolves with the promise's result, or rejects after `ms` milliseconds.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * OCR a single image buffer with tesseract (with sharp pre-processing).
 */
async function ocrImageBuffer(imageBuffer) {
  let processed = imageBuffer;
  try {
    processed = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .sharpen()
      .toBuffer();
  } catch (e) { /* use original if sharp fails */ }

  const { data: { text } } = await tesseract.recognize(processed, 'eng', {
    logger: m => {
      if (m.status === 'recognizing text') {
        console.log(`OCR progress: ${(m.progress * 100).toFixed(0)}%`);
      }
    }
  });
  return text || '';
}

/**
 * Extract text from a PDF buffer using pdf-parse (text-based PDFs only).
 * Image-based PDFs are handled client-side via PDF.js rasterisation before
 * reaching this function, so we don't attempt server-side OCR here.
 */
async function extractTextFromPDF(pdfBuffer) {
  console.log('Extracting text from PDF using pdf-parse...');
  try {
    const data = await pdfParse(pdfBuffer);
    if (data.text && data.text.trim().length > 0) {
      console.log(`pdf-parse succeeded: ${data.text.length} chars`);
      return data.text;
    }
    // No text found — likely image-based. Return empty so the handler
    // marks this file as 0 successful, triggering a 400 that the client
    // catches and retries with rasterised images.
    throw new Error('PDF contains no extractable text (may be image-based).');
  } catch (error) {
    console.log('PDF extraction failed:', error.message);
    throw new Error(error.message);
  }
}

/**
 * OCR an image buffer (plain image files or rasterised PDF pages from client).
 */
async function extractTextFromImage(imageBuffer) {
  try {
    console.log('Processing image with OCR...');
    const text = await ocrImageBuffer(imageBuffer);
    if (text && text.trim().length > 0) return text;
    throw new Error('No text found in image');
  } catch (error) {
    console.error('Image OCR failed:', error.message);
    try {
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text || '[No text could be extracted from the image]';
    } catch (e) {
      throw new Error('Could not extract text from image. The image may be too low quality or contain no text.');
    }
  }
}

async function extractTextFromFile(base64Data, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');

  if (mimeType.includes('pdf')) {
    return await extractTextFromPDF(buffer);
  } else if (mimeType.includes('word') || mimeType.includes('document')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else if (mimeType.includes('image')) {
    return await extractTextFromImage(buffer);
  } else {
    throw new Error('Unsupported file type: ' + mimeType);
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const startedAt = Date.now();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
  }

  const { files, fileType } = requestBody;

  try {
    if (!files || !Array.isArray(files) || files.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Files are required and must be an array' }) };
    }

    console.log(`Starting text extraction for ${fileType} (${files.length} file(s))`);

    let combinedText = '';
    let successfulFiles = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Processing file ${i + 1}/${files.length}, type: ${file.type}`);

      if (!file.data || !file.type) {
        combinedText += `[File ${i + 1}: Missing data or type]\n\n`;
        continue;
      }

      // Only the time that is left may be spent on this file.
      const timeLeft = EXTRACTION_BUDGET_MS - (Date.now() - startedAt);
      if (timeLeft < MIN_TIME_TO_START_FILE_MS) {
        combinedText += `[File ${i + 1}: not read — ran out of time]\n\n`;
        continue;
      }

      try {
        const text = await withTimeout(
          extractTextFromFile(file.data, file.type),
          timeLeft,
          'This file took too long to read'
        );
        if (text && text.trim().length > 0) {
          combinedText += text + '\n\n';
          successfulFiles++;
          console.log(`File ${i + 1}: extracted ${text.length} chars`);
        } else {
          combinedText += `[File ${i + 1}: No text could be extracted]\n\n`;
        }
      } catch (error) {
        console.error(`File ${i + 1} error:`, error.message);
        combinedText += `[File ${i + 1}: ${error.message}]\n\n`;
      }
    }

    if (combinedText.trim().length === 0 || successfulFiles === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Could not extract text from any of the provided files. The files may be image-based, encrypted, or corrupted.'
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        extractedText: combinedText,
        fileType,
        filesProcessed: files.length,
        successfulFiles
      })
    };
  } catch (error) {
    console.error('Extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Extraction failed: ${error.message}` })
    };
  }
};