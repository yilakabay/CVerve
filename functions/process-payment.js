const { MongoClient } = require('mongodb');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

// Function to optimize image for faster OCR processing
async function optimizeImageForOCR(buffer) {
  try {
    // Resize image to maximum 1200px width (maintains aspect ratio)
    // Convert to grayscale for better OCR accuracy
    // Increase contrast slightly
    return await sharp(buffer)
      .resize(1200, null, { withoutEnlargement: true })
      .grayscale()
      .linear(1.1, -10)
      .toBuffer();
  } catch (error) {
    console.error('Image optimization error:', error);
    return buffer; // Return original if optimization fails
  }
}

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
      // Optimize image first for faster OCR
      const optimizedBuffer = await optimizeImageForOCR(buffer);
      
      // Extract text from image using OCR with optimized settings
      const { data: { text } } = await Tesseract.recognize(optimizedBuffer, 'eng', {
        logger: () => {}, // Disable logging to reduce memory usage
        // Use faster OCR engine (legacy engine is faster but less accurate)
        oem: Tesseract.OEM.TESSERACT_ONLY,
        // Set page segmentation mode to auto
        psm: Tesseract.PSM.AUTO,
      });
      return text;
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error('Failed to extract text from file');
  }
}

exports.handler = async (event, context) => {
  // Increase timeout to 30 seconds (Netlify's maximum)
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvData, jdData, cvFileType, jdFileType } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Extract text from CV and JD files
    let cvText, jdText;
    
    // Set a longer timeout for text extraction (25 seconds)
    const extractionTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Text extraction timeout')), 25000);
    });

    const extractionPromise = Promise.all([
      extractTextFromFile(cvData, cvFileType),
      extractTextFromFile(jdData, jdFileType)
    ]);

    try {
      [cvText, jdText] = await Promise.race([extractionPromise, extractionTimeout]);
    } catch (error) {
      console.error('Text extraction failed:', error);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Failed to extract text from files. Please try again with clearer images or text-based documents.' })
      };
    }

    const prompt = `
      Instructions for the application letter:
      - Format the contact information at the top in this order: Name, Phone, Email, Address, Date (each on separate lines).
      - The application letter must be medium sized (about 4/5 of a page).
      - It must not be exaggerated or over-promising.
      - Focus on humble requests rather than demands.
      - Emphasize education, field of study, position, and soft skills.
      - If experience is internship, don't focus on experience as it's just training.
      - If the user's grade is less than 3.00/4.00, do not mention the CGPA. But if it is greater than or equal to 3.00/4.00, mention it on the application.
      - Do not say "I have attached my CV or credentials" at the end.
      - The application letter must be standard and formal.
      - Extract the job title and company name from the job description.
      - Extract the company address from the job description if available.
      - Do not use placeholders like [Your Name], [Date], [Company Name], etc. Use the actual information provided.
      - If the company address is not mentioned in the job description, omit it from the letter.
      - The letter should be addressed to the hiring manager with the company name.
      - Make the application letter demonstrate that the user understands the vacancy as well as the responsibilities and the goal of the company.
      - Format the letter properly with sender information at the top, date, recipient information, and proper closing.
      - Use the exact information provided by the user without any placeholders.

      User's Full Name: ${fullName}
      User's Phone: ${phone}
      User's Email: ${email}
      User's Address: ${address}
      Date of Application: ${appDate}
      
      CV Content:
      ${cvText}
      
      Job Description Content:
      ${jdText}
      
      Please write a professional application letter based on the above instructions.
    `;

    // Set timeout for DeepSeek API call
    const apiTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('API timeout')), 10000);
    });

    const apiPromise = axios.post(
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

    const response = await Promise.race([apiPromise, apiTimeout]);
    const letterText = response.data.choices[0].message.content;

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate letter. Please try again with smaller files or text-based documents.' })
    };
  }
};