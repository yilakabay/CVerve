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

    const prompt = `
      INSTRUCTIONS:
      You are generating a job application letter. Please follow these guidelines carefully:

      1. FORMAT THE CONTACT INFORMATION at the top in this order: 
         - Full Name
         - Phone Number  
         - Email Address
         - Physical Address
         - Date (format: Month Day, Year)
         Each on separate lines.

      2. ADDRESS THE LETTER to the appropriate recipient:
         - Use "Hiring Manager" if no specific name is found
         - Include the company name from the job description
         - Include the company address if available in the job description

      3. CONTENT GUIDELINES:
         - The letter should be medium length (about 4/5 of a page)
         - Focus on humble requests rather than demands
         - Emphasize education, field of study, and relevant skills
         - If experience is internship, don't focus heavily on experience
         - Only mention CGPA if it's 3.00/4.00 or higher
         - Do NOT say "I have attached my CV or credentials"
         - The letter must be standard and formal
         - Do not use placeholders - use actual information provided
         - Make the letter demonstrate understanding of the job requirements

      4. IMPORTANT: The job being applied for is described in the JOB DESCRIPTION section below.
         The applicant's qualifications are described in the CV section below.
         The letter should be tailored specifically to the job described in the JOB DESCRIPTION.

      JOB DESCRIPTION (This is the position being applied for):
      ${jdText}

      APPLICANT'S CV (This is the person's background and qualifications):
      ${cvText}

      APPLICANT'S PERSONAL INFORMATION:
      - Full Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Application Date: ${appDate}

      Please write a professional application letter based on the above instructions, 
      specifically tailoring it to the job described in the JOB DESCRIPTION section.
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
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
      body: JSON.stringify({ error: 'Failed to generate letter' })
    };
  }
};