const { MongoClient } = require('mongodb');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');

// Function to clean and preprocess OCR text
function cleanOCRText(text) {
  if (!text) return '';
  
  // Remove excessive whitespace and line breaks
  let cleaned = text.replace(/\s+/g, ' ').trim();
  
  // Fix common OCR errors
  const commonErrors = {
    'szme8me788': 'skills', // Example fix based on your log
    'Siingee': 'Singee', // Fix from your log
    'SIINOEE': 'Slingee', // Fix from your log
    'siingee': 'slingee' // Fix from your log
  };
  
  Object.keys(commonErrors).forEach(error => {
    const regex = new RegExp(error, 'gi');
    cleaned = cleaned.replace(regex, commonErrors[error]);
  });
  
  return cleaned;
}

// Function to extract text from different file types
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (mimeType.includes('pdf')) {
      const data = await pdfParse(buffer);
      return data.text;
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } else if (mimeType.includes('image')) {
      // Enhanced OCR for images with better configuration
      const { data: { text } } = await tesseract.recognize(buffer, 'eng', {
        logger: m => console.log(m), // Optional: for debugging OCR process
        tessedit_pageseg_mode: '6', // Uniform block of text
        tessedit_ocr_engine_mode: '1', // Neural nets LSTM engine
        preserve_interword_spaces: '1' // Preserve spacing
      });
      
      // Clean the OCR text
      return cleanOCRText(text);
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error('Failed to extract text from file');
  }
}

// Function to validate extracted text
function validateText(text, fileType) {
  if (!text || text.trim().length < 10) {
    throw new Error(`${fileType} text is too short or empty`);
  }
  
  // Check if text contains mostly garbage characters (poor OCR)
  const alphaNumericRatio = text.replace(/[^a-zA-Z0-9]/g, '').length / text.length;
  if (alphaNumericRatio < 0.3) { // If less than 30% of characters are alphanumeric
    throw new Error(`Poor quality ${fileType} extraction. Please try a clearer image or different file format.`);
  }
  
  return true;
}

// Function to process multiple files with enhanced error handling
async function processMultipleFiles(files, fileType) {
  let combinedText = '';
  let successfulFiles = 0;
  
  for (const file of files) {
    try {
      const text = await extractTextFromFile(file.data, file.type);
      
      if (text && text.trim().length > 50) { // Only use files with substantial content
        combinedText += text + '\n\n';
        successfulFiles++;
        console.log(`Successfully processed ${fileType} file: ${text.substring(0, 100)}...`);
      }
    } catch (error) {
      console.warn(`Warning: Failed to process one ${fileType} file:`, error.message);
      // Continue with other files instead of failing completely
    }
  }
  
  if (successfulFiles === 0) {
    throw new Error(`Could not extract readable text from any ${fileType} files. Please try clearer images or different file formats.`);
  }
  
  // Validate the combined text
  validateText(combinedText, fileType);
  
  return combinedText;
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Set longer timeout for image processing
  context.callbackWaitsForEmptyEventLoop = false;

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

    console.log(`Processing ${cvFiles.length} CV files and ${jdFiles.length} JD files`);

    // Extract text from CV and JD files with enhanced error handling
    const cvText = await processMultipleFiles(cvFiles, 'CV');
    const jdText = await processMultipleFiles(jdFiles, 'Job Description');
    
    // Log cleaned text for debugging
    console.log("Cleaned CV Text Length:", cvText.length);
    console.log("Cleaned JD Text Length:", jdText.length);
    console.log("Cleaned JD Text Sample:", jdText.substring(0, 500));

    // Enhanced prompt with clearer instructions
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
Write a professional application letter for the position described in the JOB DESCRIPTION.

CRITICAL REQUIREMENTS:
1. Use the EXACT company name and position title from the JOB DESCRIPTION
2. Do NOT use placeholders like [Company Name] or [Position Title]
3. Reference specific requirements from the job description
4. Highlight how the applicant's qualifications match the job requirements
5. Format professionally with contact info at top
6. Address to Hiring Manager if no specific name given
7. Keep the letter concise (about 4/5 of a page)
8. Do not mention attaching documents
9. Only mention GPA if it's 3.00/4.00 or higher

Generate the application letter now:
    `;

    console.log("Prompt length sent to AI:", prompt.length);

    // Enhanced API call with better error handling and timeout
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Always use exact details from the job description without placeholders. Extract and use the exact company name and position title from the provided job description.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4000, // Increased token limit for longer responses
        stream: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 30000 // 30 second timeout for AI response
      }
    );

    if (!response.data.choices || !response.data.choices[0] || !response.data.choices[0].message) {
      throw new Error('Invalid response format from AI API');
    }

    const letterText = response.data.choices[0].message.content;
    
    if (!letterText || letterText.trim().length < 100) {
      throw new Error('Generated letter is too short or empty');
    }

    console.log("Successfully generated letter of length:", letterText.length);

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.message);
    console.error('Error details:', error.response?.data || error);
    
    let errorMessage = 'Failed to generate letter. ';
    
    if (error.message.includes('timeout')) {
      errorMessage += 'The request timed out. Please try again with smaller files or clearer images.';
    } else if (error.message.includes('Poor quality')) {
      errorMessage += 'The image quality is poor. Please try clearer images or use PDF/Word documents instead.';
    } else if (error.message.includes('text is too short')) {
      errorMessage += 'The uploaded files contain too little text. Please ensure your files contain readable text.';
    } else {
      errorMessage += 'Please check that your files contain readable text and are in supported formats (PDF, Word, or clear images).';
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};