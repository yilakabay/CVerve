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
  // Simple extraction of company name and position
  const companyMatch = jdText.match(/(Company|Bank|Organization)[:\s]*([^\n\r]+)/i);
  const positionMatch = jdText.match(/(Position|Role|Title)[:\s]*([^\n\r]+)/i);
  
  return {
    company: companyMatch ? companyMatch[2].trim() : "the company",
    position: positionMatch ? positionMatch[2].trim() : "the position"
  };
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
    
    // Extract key information from job description
    const jobInfo = extractJobInfo(jdText);

    const prompt = `
      TASK: Generate a job application letter for the specific position described below.

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

      JOB INFORMATION (extracted from description):
      - Company: ${jobInfo.company}
      - Position: ${jobInfo.position}

      INSTRUCTIONS:
      1. Write a professional application letter specifically for the position described above
      2. Address it to the hiring manager at the company mentioned in the job description
      3. Use the exact company name and position title from the job description
      4. Highlight how the applicant's qualifications match the specific job requirements
      5. Do not use placeholders like [Company Name] or [Position Title]
      6. Format the contact information at the top: Name, Phone, Email, Address, Date
      7. Keep the letter to about 4/5 of a page
      8. Use a formal, professional tone
      9. Do not mention attaching a CV or documents
      10. Only mention GPA if it's 3.00/4.00 or higher

      IMPORTANT: The letter must be specifically tailored to the job description provided.
      Do not generate a generic letter - it must reference specific details from the job description.

      Now generate the application letter:
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer who creates tailored application letters for specific job positions. Always use the exact details from the job description without placeholders.' 
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

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.response?.data || error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate letter. Please try again with different files.' })
    };
  }
};