const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Fast text extraction for non-image files
async function extractTextQuick(fileBuffer, mimeType) {
  try {
    if (mimeType.includes('pdf')) {
      const data = await pdfParse(fileBuffer);
      return data.text;
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return result.value;
    }
    return ''; // Skip images in quick mode
  } catch (error) {
    console.error('Quick extraction error:', error);
    return '';
  }
}

// Standalone OCR function with strict timeout
async function extractTextFromImage(base64Data) {
  const tesseract = require('tesseract.js');
  const buffer = Buffer.from(base64Data, 'base64');
  
  // Very aggressive timeout for OCR
  const ocrPromise = tesseract.recognize(buffer, 'eng', {
    logger: m => m.status === 'recognizing text' ? console.log('OCR progress...') : null,
    tessedit_pageseg_mode: '6',
    tessedit_ocr_engine_mode: '1',
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('OCR timeout after 15 seconds')), 15000);
  });

  const { data: { text } } = await Promise.race([ocrPromise, timeoutPromise]);
  return text;
}

// Process files with priority on speed
async function processFilesOptimized(files) {
  const startTime = Date.now();
  let combinedText = '';
  
  for (const file of files) {
    // If we're approaching timeout, skip remaining files
    if (Date.now() - startTime > 25000) {
      console.log('Timeout approaching, skipping remaining files');
      break;
    }

    try {
      const buffer = Buffer.from(file.data, 'base64');
      
      if (file.type.includes('image')) {
        // Process images only if we have time
        if (Date.now() - startTime < 15000) {
          console.log('Processing image with OCR...');
          const text = await extractTextFromImage(file.data);
          combinedText += text + '\n\n';
        } else {
          console.log('Skipping image due to time constraints');
        }
      } else {
        // Fast processing for PDF/Word
        console.log('Processing document quickly...');
        const text = await extractTextQuick(buffer, file.type);
        combinedText += text + '\n\n';
      }
    } catch (error) {
      console.error(`Error processing file:`, error.message);
      // Continue with next file
    }
  }
  
  return combinedText;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvFiles, jdFiles } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // Global timeout for entire function (29 seconds)
  const globalTimeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Function timeout after 29 seconds')), 29000);
  });

  try {
    if (!cvFiles || cvFiles.length === 0 || !jdFiles || jdFiles.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'CV and JD files are required' })
      };
    }

    console.log('Starting optimized processing...');
    
    // Process files with timeout protection
    const processFiles = (async () => {
      const [cvText, jdText] = await Promise.all([
        processFilesOptimized(cvFiles),
        processFilesOptimized(jdFiles)
      ]);

      // Validate minimum text
      if (!jdText || jdText.trim().length < 50) {
        throw new Error('Insufficient text extracted from job description');
      }

      if (!cvText || cvText.trim().length < 50) {
        throw new Error('Insufficient text extracted from CV');
      }

      const prompt = `JOB DESCRIPTION: ${jdText.substring(0, 8000)}

APPLICANT'S CV: ${cvText.substring(0, 8000)}

APPLICANT INFORMATION:
- Name: ${fullName}
- Phone: ${phone}
- Email: ${email}
- Address: ${address}
- Date: ${appDate}

INSTRUCTIONS: Write a professional application letter matching the CV to the job description. Use exact company/position names from the JD. Format: contact info at top, professional tone, about 4/5 page.`;

      console.log("Making API request...");

      const apiResponse = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are a professional resume writer. Use exact details from the job description.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 1500, // Reduced for speed
          stream: false // Ensure no streaming
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          timeout: 8000 // 8 second timeout for API
        }
      );

      return apiResponse.data.choices[0].message.content;
    })();

    const letterText = await Promise.race([processFiles, globalTimeout]);
    
    console.log("Success! Total time:", Date.now() - startTime, "ms");

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
    
  } catch (error) {
    console.error('Error:', error.message);
    
    let errorMessage = 'Failed to generate letter. ';
    if (error.message.includes('timeout')) {
      errorMessage += 'Processing took too long. Please try with smaller files or use PDF/Word documents instead of images.';
    } else {
      errorMessage += error.message;
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};