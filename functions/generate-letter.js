const { MongoClient } = require('mongodb');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');

// Function to extract text from different file types
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (mimeType.includes('pdf')) {
      // Extract text from PDF
      const data = await pdfParse(buffer);
      return data.text;
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      // Extract text from Word document
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } else if (mimeType.includes('image')) {
      // OPTIMIZED: Extract text from image using OCR with timeout and simplified config
      console.log('Starting OCR processing for image...');
      
      // Create a promise with timeout to avoid hanging
      const ocrPromise = tesseract.recognize(buffer, 'eng', {
        logger: m => console.log(m), // Log progress
        // Optimize for speed over accuracy
        tessedit_pageseg_mode: '6', // Uniform block of text
        tessedit_ocr_engine_mode: '1', // Neural nets LSTM only
      });
      
      // Set timeout of 25 seconds (leaving 5 seconds for other processing)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('OCR timeout after 25 seconds')), 25000);
      });
      
      // Race between OCR and timeout
      const { data: { text } } = await Promise.race([ocrPromise, timeoutPromise]);
      console.log('OCR completed successfully');
      return text;
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    if (error.message.includes('timeout')) {
      throw new Error('Image processing took too long. Please try with a smaller or clearer image.');
    }
    throw new Error('Failed to extract text from file');
  }
}

// Function to process multiple files with better error handling
async function processMultipleFiles(files) {
  let combinedText = '';
  let processedCount = 0;
  
  for (const file of files) {
    try {
      console.log(`Processing file ${++processedCount} of ${files.length}`);
      const text = await extractTextFromFile(file.data, file.type);
      combinedText += text + '\n\n';
      console.log(`Successfully processed file ${processedCount}`);
    } catch (error) {
      console.error(`Error processing file ${processedCount}:`, error.message);
      // Don't fail the entire process if one file fails
      if (files.length === 1) {
        // If it's the only file, we need to throw the error
        throw new Error(`Failed to process file: ${error.message}`);
      } else {
        // If multiple files, just skip the problematic one
        console.log(`Skipping file ${processedCount} due to processing error`);
      }
    }
  }
  
  return combinedText;
}

// Function to truncate text if too long (to avoid API limits)
function truncateText(text, maxLength = 15000) {
  if (text.length > maxLength) {
    console.log(`Text truncated from ${text.length} to ${maxLength} characters`);
    return text.substring(0, maxLength) + '\n\n[Content was truncated due to length limitations]';
  }
  return text;
}

exports.handler = async (event, context) => {
  // Set timeout warning - Netlify functions have 30s timeout
  context.callbackWaitsForEmptyEventLoop = false;
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvFiles, jdFiles } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Validate input
    if (!cvFiles || cvFiles.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'At least one CV file is required' })
      };
    }

    if (!jdFiles || jdFiles.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'At least one Job Description file is required' })
      };
    }

    console.log('Starting text extraction...');
    
    // Process files in parallel to save time
    const [cvText, jdText] = await Promise.all([
      processMultipleFiles(cvFiles).then(truncateText),
      processMultipleFiles(jdFiles).then(truncateText)
    ]);
    
    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", jdText.length);
    console.log("JD Text Sample:", jdText.substring(0, 500));

    // Validate that we have sufficient text
    if (!jdText || jdText.trim().length < 50) {
      throw new Error('Job description text extraction failed or resulted in insufficient text. The file may be unreadable, in an unsupported format, or contain mostly images without text.');
    }

    if (!cvText || cvText.trim().length < 50) {
      throw new Error('CV text extraction failed or resulted in insufficient text. Please ensure your CV contains readable text.');
    }

    const prompt = `
      JOB DESCRIPTION:
      ${jdText}

      APPLICANT'S CV:
      ${cvText}

      APPLICANT INFORMATION:
      - Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Date: ${appDate}

      INSTRUCTIONS:
      Write a professional application letter for the position described in the JOB DESCRIPTION section.
      
      IMPORTANT: 
      1. Use the exact company name and position title from the JOB DESCRIPTION
      2. Do NOT use placeholders like [Company Name] or [Position Title]
      3. Reference specific requirements from the job description
      4. Highlight how the applicant's qualifications match the job requirements
      5. Format the contact information at the top: Name, Phone, Email, Address, Date
      6. Address the letter to the appropriate recipient (Hiring Manager if no specific name)
      7. Keep the letter professional and about 4/5 of a page
      8. Do not mention attaching a CV or documents
      9. Only mention GPA if it's 3.00/4.00 or higher

      Now generate the application letter:
    `;

    console.log("Prompt length:", prompt.length);
    console.log("Making API request to DeepSeek...");

    // Set timeout for API call
    const apiTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('API request timeout')), 10000);
    });

    const apiRequest = axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Always use exact details from the job description without placeholders. If the job description mentions a specific company and position, use those exact names.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 10000 // 10 second timeout for axios
      }
    );

    const response = await Promise.race([apiRequest, apiTimeout]);
    const letterText = response.data.choices[0].message.content;
    console.log("Letter generated successfully, length:", letterText.length);

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.message);
    
    let errorMessage = 'Failed to generate letter. ';
    
    if (error.message.includes('timeout')) {
      errorMessage += 'The request took too long to process. This often happens with image files. Please try again with smaller images or use PDF/Word documents instead.';
    } else if (error.message.includes('OCR timeout')) {
      errorMessage += 'Image processing took too long. Please try with smaller or clearer images, or use PDF/Word documents for faster processing.';
    } else if (error.response) {
      errorMessage += `API Error: ${error.response.status} - ${error.response.statusText}`;
    } else {
      errorMessage += error.message;
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};