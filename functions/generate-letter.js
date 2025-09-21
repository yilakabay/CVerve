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

    // Log extracted text for debugging (commented out for production)
    // console.log("CV Text:", cvText.substring(0, 500) + "...");
    // console.log("JD Text:", jdText.substring(0, 500) + "...");

    const prompt = `
      TASK: Generate a job application letter for a specific position described in the JOB DESCRIPTION.

      IMPORTANT: The letter must be specifically tailored to the JOB DESCRIPTION provided below, 
      not based on any previous experience mentioned in the CV unless it's directly relevant.

      JOB DESCRIPTION CONTENT:
      ${jdText}

      APPLICANT'S CV CONTENT:
      ${cvText}

      APPLICANT PERSONAL INFORMATION:
      - Full Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Application Date: ${appDate}

      INSTRUCTIONS FOR THE APPLICATION LETTER:

      1. FORMAT:
        - Place the applicant's contact information at the top (name, phone, email, address, date)
        - Address it to the appropriate recipient based on the job description
        - Use a professional, formal tone throughout

      2. CONTENT REQUIREMENTS:
        - The letter must specifically address the position described in the JOB DESCRIPTION
        - Highlight how the applicant's qualifications match the job requirements
        - If the job description mentions specific qualifications, skills, or requirements, 
          address how the applicant meets these
        - Do not focus on unrelated previous experiences unless they directly relate to the new position
        - The letter should be medium length (approximately 4/5 of a page)
        - Do not include phrases like "I have attached my CV" or similar
        - Only mention GPA if it's 3.00/4.00 or higher

      3. KEY ELEMENTS TO EXTRACT FROM JOB DESCRIPTION:
        - Company name
        - Position title
        - Key qualifications required
        - Any specific skills mentioned
        - Application requirements

      4. KEY ELEMENTS TO EXTRACT FROM CV:
        - Education background
        - Relevant skills
        - Any experience that matches the job requirements
        - Achievements that are relevant to the position

      IMPORTANT: The letter must be written as if applying specifically for the position 
      described in the JOB DESCRIPTION section. Do not assume the applicant is applying for 
      a position based on their previous experience unless it matches the job description.

      Now generate a professional application letter following these instructions exactly.
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer who creates tailored application letters for specific job positions.' 
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