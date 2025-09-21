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
    
    // Log extracted text for debugging
    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", jdText.length);
    console.log("JD Text:", jdText);

    // If JD text is empty or too short, throw an error
    if (!jdText || jdText.length < 50) {
      throw new Error('Job description text extraction failed. The file may be unreadable or in an unsupported format.');
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

    // Log the prompt to verify it contains the job description
    console.log("Prompt sent to AI (first 1000 chars):", prompt.substring(0, 1000));

    const response = await axios.post(
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
    console.error('Letter generation error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate letter. Please check that your job description file contains text and is in a supported format (PDF, Word, or image).' })
    };
  }
};