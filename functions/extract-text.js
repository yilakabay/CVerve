const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');

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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { files, fileType } = JSON.parse(event.body); // fileType: 'cv' or 'jd'

  try {
    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Files are required' })
      };
    }

    console.log(`Starting text extraction for ${fileType} files...`);

    let combinedText = '';
    
    // Process files sequentially to avoid memory issues
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Processing file ${i + 1} of ${files.length}`);
      
      try {
        const text = await extractTextFromFile(file.data, file.type);
        combinedText += text + '\n\n';
      } catch (error) {
        console.error(`Error processing file ${i + 1}:`, error);
        // Continue with other files even if one fails
        combinedText += `[Error processing file ${i + 1}: ${error.message}]\n\n`;
      }
    }

    console.log(`Successfully extracted ${combinedText.length} characters for ${fileType}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true,
        extractedText: combinedText,
        fileType: fileType
      })
    };
  } catch (error) {
    console.error('Extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Extraction failed: ${error.message}` })
    };
  }
};