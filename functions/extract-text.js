const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const tesseract = require('tesseract.js');
const sharp    = require('sharp');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Try to rasterise a PDF page with sharp (works when libvips has poppler).
 * Returns an array of PNG Buffers (one per page), or null if unsupported.
 */
async function rasterisePdfWithSharp(pdfBuffer, dpi = 200) {
  try {
    const pages = await sharp(pdfBuffer, { density: dpi })
      .png()
      .toBuffer({ resolveWithObject: true });
    // sharp returns a single buffer when it can read the PDF as one image;
    // for multi-page we need to iterate via page option
    const meta = await sharp(pdfBuffer, { density: dpi }).metadata();
    const pageCount = meta.pages || 1;
    const buffers = [];
    for (let p = 0; p < pageCount; p++) {
      const buf = await sharp(pdfBuffer, { density: dpi, page: p })
        .grayscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      buffers.push(buf);
    }
    return buffers;
  } catch (e) {
    console.log('sharp PDF rasterise failed (poppler not available?):', e.message);
    return null;
  }
}

/**
 * OCR a single image buffer with tesseract.
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
    logger: m => { if (m.status === 'recognizing text') console.log(`OCR progress: ${(m.progress * 100).toFixed(0)}%`); }
  });
  return text || '';
}

/**
 * Extract text from a PDF buffer.
 * Strategy:
 *   1. pdf-parse  → fast text extraction for text-based PDFs
 *   2. sharp rasterise + tesseract OCR  → for image-based PDFs (when libvips/poppler available)
 *   3. tesseract directly on raw PDF buffer → last-resort fallback
 */
async function extractTextFromPDF(pdfBuffer) {
  // ── Step 1: try pdf-parse ─────────────────────────────────────────────────
  try {
    console.log('Step 1: trying pdf-parse text extraction…');
    const data = await pdfParse(pdfBuffer);
    if (data.text && data.text.trim().length > 50) {
      console.log(`pdf-parse succeeded: ${data.text.length} chars`);
      return data.text;
    }
    console.log('pdf-parse returned little/no text — falling back to OCR');
  } catch (e) {
    console.log('pdf-parse threw:', e.message, '— falling back to OCR');
  }

  // ── Step 2: sharp rasterise → per-page OCR ───────────────────────────────
  console.log('Step 2: trying sharp PDF rasterisation + OCR…');
  const pageBuffers = await rasterisePdfWithSharp(pdfBuffer);
  if (pageBuffers && pageBuffers.length > 0) {
    console.log(`Rasterised ${pageBuffers.length} page(s) — running OCR…`);
    const texts = [];
    for (let i = 0; i < pageBuffers.length; i++) {
      console.log(`OCR page ${i + 1}/${pageBuffers.length}`);
      try {
        const t = await ocrImageBuffer(pageBuffers[i]);
        texts.push(t);
      } catch (e) {
        console.error(`OCR failed on page ${i + 1}:`, e.message);
      }
    }
    const combined = texts.join('\n\n').trim();
    if (combined.length > 0) {
      console.log(`Step 2 succeeded: ${combined.length} chars from ${pageBuffers.length} pages`);
      return combined;
    }
  }

  // ── Step 3: feed raw PDF buffer directly to tesseract ───────────────────
  console.log('Step 3: passing raw PDF buffer directly to tesseract…');
  try {
    const { data: { text } } = await tesseract.recognize(pdfBuffer, 'eng', {
      logger: m => { if (m.status === 'recognizing text') console.log(`OCR: ${(m.progress * 100).toFixed(0)}%`); }
    });
    if (text && text.trim().length > 0) {
      console.log(`Step 3 succeeded: ${text.length} chars`);
      return text;
    }
  } catch (e) {
    console.error('Step 3 tesseract direct failed:', e.message);
  }

  throw new Error('Could not extract text from this PDF. The file may be encrypted, corrupted, or contain only non-readable content.');
}

// ── Image OCR ─────────────────────────────────────────────────────────────────
async function extractTextFromImage(imageBuffer) {
  try {
    console.log('Processing image with OCR…');
    const text = await ocrImageBuffer(imageBuffer);
    if (text && text.trim().length > 0) return text;
    throw new Error('No text found in image');
  } catch (error) {
    console.error('Image OCR failed:', error.message);
    // Fallback without pre-processing
    try {
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text || '[No text could be extracted from the image]';
    } catch (e) {
      throw new Error('Could not extract text from image. The image may be too low quality or contain no text.');
    }
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
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

// ── Netlify handler ───────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

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

      try {
        const text = await extractTextFromFile(file.data, file.type);
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
          error: 'Could not extract text from any of the provided files. The files may be encrypted, corrupted, or contain only non-readable content.'
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