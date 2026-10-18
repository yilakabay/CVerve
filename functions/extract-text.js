// functions/extract-text.js
// POST body: { userId, sessionToken, files: [{ data, type }], fileType, feature, free }
//
//   files[].data — base64 file content
//   files[].type — mime type (application/pdf, image/*, application/msword, ...)
//   feature      — which FEATURE_MODELS key to bill the Gemini fallback against
//                  (defaults to 'GENERIC_EXTRACTION'). Pass 'CV_EXTRACTION' for
//                  CV-chat certificate/education uploads, 'LETTER_EXTRACTION'
//                  for Application Letter uploads, etc.
//   free         — true for payment-screenshot extraction and CV-upload-to-
//                  storage extraction, which must never be charged even when
//                  the Gemini fallback is used.
//
// STRATEGY (hybrid, cheapest-first):
//   1. Try local, free extraction for every file:
//        - pdf-parse for text-based PDFs
//        - mammoth for Word docs
//        - tesseract.js (+ sharp pre-processing) OCR for images
//   2. Only if a file comes back EMPTY from step 1 do we fall back to asking
//      Gemini 3 Flash (via the B.AI gateway) to read the text out of it. This
//      is the only point where the user is charged CT (unless `free: true`),
//      and only for the files that actually needed it.
//
// Response on success: { success, extractedText, fileType, filesProcessed,
//                         successfulFiles, tokensUsed, tokenBalance }
// Not enough CT (only possible if the Gemini fallback was needed and the user
// can't cover it): 402 { error, code:'INSUFFICIENT_TOKENS', tokenBalance }

const pdfParse  = require('pdf-parse');
const mammoth   = require('mammoth');
const tesseract = require('tesseract.js');
const sharp     = require('sharp');
const { runBilledChat, getDb, authenticate, errorResponse, AIError } = require('./lib/ai-billing');

// ── Time budget ──────────────────────────────────────────────────────────
// OCR with tesseract is slow, and the function used to keep going until the
// platform killed it — the user then got a plain error and NOTHING was read.
// Now each file gets only the time that is left in this budget. If a file
// takes too long, it is reported as "took too long" and the function still
// answers in time with whatever WAS read, so the app can show a clear message
// (or fall back to reading the PDF as page images, a couple of pages at a time).
//
// Netlify's synchronous Functions have a real 60-second execution ceiling
// (platform-wide, not plan-dependent). 20000ms here was sized for an
// inaccurate "10s free-plan cap" and was cutting off tesseract OCR / the
// Gemini fallback mid-read for genuinely slow files (multi-page scanned
// certificates, dense transcripts) well before the platform would ever
// have killed the function — that showed up as extraction silently failing
// after a long wait. Budget is now sized to the real ceiling with a safety
// margin for cold starts and this function's own overhead.
const EXTRACTION_BUDGET_MS = 50000;
const MIN_TIME_TO_START_FILE_MS = 3000;

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
    // No text found — likely image-based. Return empty so the caller falls
    // back to the Gemini vision path.
    return '';
  } catch (error) {
    console.log('PDF extraction failed:', error.message);
    return '';
  }
}

/**
 * OCR an image buffer (plain image files or rasterised PDF pages from client).
 */
async function extractTextFromImage(imageBuffer) {
  try {
    console.log('Processing image with OCR...');
    const text = await ocrImageBuffer(imageBuffer);
    return text || '';
  } catch (error) {
    console.error('Image OCR failed:', error.message);
    try {
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text || '';
    } catch (e) {
      return '';
    }
  }
}

// Local, free extraction attempt. Returns '' (never throws) when it can't
// get usable text, so the caller knows to fall back to Gemini.
async function extractTextLocally(base64Data, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');

  if (mimeType.includes('pdf')) {
    return await extractTextFromPDF(buffer);
  } else if (mimeType.includes('word') || mimeType.includes('document')) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    } catch (e) {
      console.log('mammoth extraction failed:', e.message);
      return '';
    }
  } else if (mimeType.includes('image')) {
    return await extractTextFromImage(buffer);
  } else if (mimeType.includes('text')) {
    try { return buffer.toString('utf-8'); } catch (e) { return ''; }
  } else {
    return '';
  }
}

// ── Gemini 3 Flash fallback (billed, via the B.AI gateway) ─────────────────
// Only used when local extraction came back empty. Sends the file as a
// vision message so Gemini can read text straight off the image/page.
async function extractTextWithGemini({ userId, sessionToken, feature, free, preAuth, base64Data, mimeType }) {
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const { text, tokensUsed, tokenBalance } = await runBilledChat({
    userId, sessionToken,
    feature: feature || 'GENERIC_EXTRACTION',
    free,
    preAuth,
    messages: [
      {
        role: 'system',
        content: 'You transcribe every piece of readable text from a document or image exactly as it appears, in reading order, from top to bottom — not just a header, letterhead, or logo area. Certificates and transcripts usually have their most important content in a central body paragraph, often in italic or cursive script (the actual certifying statement: name, degree, field of study, GPA/score, dates) — that text is the main point of the document and must be included in full, not skipped in favor of the letterhead or contact details. This image may also be scanned or photographed sideways or upside down (the whole page rotated 90/180/270 degrees, not just slanted) — if so, mentally rotate it to the correct reading direction and transcribe all of the text anyway; do not skip or give up on rotated text. Reply with the extracted text only — no commentary, no markdown, no summary. If genuinely no text is visible, reply with an empty response.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract all text from this file, including any body paragraph in italic or cursive script, even if the page is sideways or upside down.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    maxTokens: 3000,
    temperature: 0
  });

  return { text: (text || '').trim(), tokensUsed, tokenBalance };
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

  const { userId, sessionToken, files, fileType, feature, free } = requestBody;

  if (!files || !Array.isArray(files) || files.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Files are required and must be an array' }) };
  }

  try {
    // Authenticate once up front — even local-only extraction runs are gated
    // behind a valid session, and we need the user doc ready in case any
    // file needs the billed Gemini fallback.
    const db   = await getDb();
    const user = await authenticate(db, userId, sessionToken);

    console.log(`Starting text extraction for ${fileType} (${files.length} file(s))`);

    let combinedText = '';
    let successfulFiles = 0;
    let totalTokensUsed = 0;
    let latestTokenBalance;
    let geminiBlockedError = null; // set if the user can't afford a needed Gemini fallback

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

      let text = '';
      try {
        text = await withTimeout(
          extractTextLocally(file.data, file.type),
          timeLeft,
          'This file took too long to read'
        );
      } catch (error) {
        console.error(`File ${i + 1} local extraction error:`, error.message);
        text = '';
      }

      // Step 2: local extraction gave nothing usable — fall back to Gemini,
      // but only if we haven't already hit a billing wall on an earlier file.
      if ((!text || text.trim().length === 0) && !geminiBlockedError) {
        const timeLeftForGemini = EXTRACTION_BUDGET_MS - (Date.now() - startedAt);
        if (timeLeftForGemini < MIN_TIME_TO_START_FILE_MS) {
          combinedText += `[File ${i + 1}: No text could be extracted]\n\n`;
          continue;
        }
        try {
          console.log(`File ${i + 1}: local extraction empty, falling back to Gemini`);
          const geminiResult = await withTimeout(
            extractTextWithGemini({
              userId, sessionToken, feature, free,
              preAuth: { db, user },
              base64Data: file.data,
              mimeType: file.type
            }),
            timeLeftForGemini,
            'This file took too long to read'
          );
          text = geminiResult.text;
          totalTokensUsed += geminiResult.tokensUsed;
          latestTokenBalance = geminiResult.tokenBalance;
        } catch (error) {
          if (error instanceof AIError && error.extra && error.extra.code === 'INSUFFICIENT_TOKENS') {
            // Don't fail the whole request yet — just remember it, so files
            // already extracted (free, local) still get returned, but we
            // stop spending on further Gemini fallbacks this run.
            geminiBlockedError = error;
            combinedText += `[File ${i + 1}: Not enough CT to read this file]\n\n`;
            continue;
          }
          console.error(`File ${i + 1} Gemini fallback error:`, error.message);
          text = '';
        }
      }

      if (text && text.trim().length > 0) {
        combinedText += text + '\n\n';
        successfulFiles++;
        console.log(`File ${i + 1}: extracted ${text.length} chars`);
      } else if (!geminiBlockedError) {
        combinedText += `[File ${i + 1}: No text could be extracted]\n\n`;
      }
    }

    if (combinedText.trim().length === 0 || successfulFiles === 0) {
      // If the ONLY reason nothing came through is an unaffordable Gemini
      // fallback, surface that as a proper 402 so the app shows Top Up.
      if (geminiBlockedError) return errorResponse(geminiBlockedError);
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
        successfulFiles,
        tokensUsed: totalTokensUsed,
        tokenBalance: latestTokenBalance !== undefined ? latestTokenBalance : Math.max(0, Number(user.tokens) || 0)
      })
    };
  } catch (error) {
    if (error instanceof AIError) return errorResponse(error);
    console.error('Extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Extraction failed: ${error.message}` })
    };
  }
};