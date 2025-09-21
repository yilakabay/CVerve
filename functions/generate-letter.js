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
      // Extract text from image using OCR
      const { data: { text } } = await tesseract.recognize(buffer, 'eng');
      return text;
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error('Failed to extract text from file');
  }
}

// Function to process multiple files
async function processMultipleFiles(files) {
  let combinedText = '';
  for (const file of files) {
    try {
      const text = await extractTextFromFile(file.data, file.type);
      combinedText += text + '\n\n';
    } catch (error) {
      console.error(`Error processing file: ${error.message}`);
      throw new Error(`Failed to process one or more files: ${error.message}`);
    }
  }
  return combinedText;
}

// Function to extract key information from job description
function extractJobInfo(jdText) {
  console.log("Full JD Text:", jdText);
  
  // Try to extract company name using multiple patterns
  let company = "the company";
  const companyPatterns = [
    /(?:Company|Bank|Organization)[:\s-]*([^\n\r.,]+)/i,
    /^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Bank|Company|Organization))/m,
    /at\s+([^\n\r.,]+)(?:\s+(?:Bank|Company|Organization))/i
  ];
  
  for (const pattern of companyPatterns) {
    const match = jdText.match(pattern);
    if (match && match[1]) {
      company = match[1].trim();
      break;
    }
  }
  
  // Try to extract position title using multiple patterns
  let position = "the position";
  const positionPatterns = [
    /(?:Position|Role|Title|Vacancy)[:\s-]*([^\n\r.,]+)/i,
    /^(?:Position|Role|Title|Vacancy)[\s\S]{1,100}?$/im,
    /(?:apply|applications?|seeking)[\s\S]{1,100}?(?:for|as)\s+([^\n\r.,]+)/i
  ];
  
  for (const pattern of positionPatterns) {
    const match = jdText.match(pattern);
    if (match && match[1]) {
      position = match[1].trim();
      // Clean up position title
      position = position.replace(/^[:\s-]+|[:\s-]+$/g, '');
      break;
    }
  }
  
  // If we still have default values, try to extract from the beginning of the text
  if (company === "the company") {
    const firstLine = jdText.split('\n')[0].trim();
    if (firstLine.length > 0 && firstLine.length < 100) {
      company = firstLine;
    }
  }
  
  if (position === "the position") {
    // Look for words that might indicate a position
    const positionKeywords = ['trainee', 'officer', 'manager', 'specialist', 'analyst', 'assistant', 'intern'];
    for (const keyword of positionKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(jdText)) {
        position = keyword.charAt(0).toUpperCase() + keyword.slice(1);
        break;
      }
    }
  }
  
  console.log("Extracted Company:", company);
  console.log("Extracted Position:", position);
  
  return { company, position };
}

exports.handler = async (event, context) => {
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

    // Extract text from CV and JD files
    const cvText = await processMultipleFiles(cvFiles);
    const jdText = await processMultipleFiles(jdFiles);
    
    // Log extracted text for debugging
    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", jdText.length);
    console.log("JD Text Sample:", jdText.substring(0, 500));
    
    // Extract key information from job description
    const jobInfo = extractJobInfo(jdText);

    const prompt = `
      JOB DESCRIPTION CONTENT:
      ${jdText}

      APPLICANT'S CV CONTENT:
      ${cvText}

      APPLICANT INFORMATION:
      - Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Date: ${appDate}

      EXTRACTED JOB INFORMATION:
      - Company: ${jobInfo.company}
      - Position: ${jobInfo.position}

      INSTRUCTIONS:
      Write a professional application letter for the position described in the JOB DESCRIPTION CONTENT.
      
      IMPORTANT RULES:
      1. Use the exact company name from the JOB DESCRIPTION CONTENT, not from the CV
      2. Use the exact position title from the JOB DESCRIPTION CONTENT
      3. Reference specific requirements mentioned in the job description
      4. Do NOT use placeholders like [Company Name] or [Position Title]
      5. If you can't find specific details, use the extracted job information above
      6. Format the contact information at the top: Name, Phone, Email, Address, Date
      7. Address the letter to the appropriate recipient
      8. Keep the letter professional and about 4/5 of a page
      9. Do not mention attaching a CV or documents
      10. Only mention GPA if it's 3.00/4.00 or higher

      Now generate the application letter:
    `;

    console.log("Prompt sent to AI:", prompt.substring(0, 1000) + "...");

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Always use exact details from the job description. If the job description mentions a specific company and position, use those exact names. Never use placeholders. Ignore any company names mentioned in the CV unless they match the job description exactly.' 
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
        }
      }
    );

    const letterText = response.data.choices[0].message.content;
    console.log("Generated letter:", letterText);

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.response?.data || error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate letter. Please check that your files contain text and try again.' })
    };
  }
};