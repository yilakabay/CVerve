const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

// Function to extract text from different file types
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (mimeType.includes('pdf')) {
      try {
        // First try to extract text directly from PDF
        const data = await pdfParse(buffer);
        
        // If we get meaningful text, return it
        if (data.text && data.text.trim().length > 50) {
          console.log('Extracted text from PDF directly');
          return data.text;
        }
        
        // If text is too short (likely image-based PDF), use OCR
        console.log('PDF appears to be image-based, using OCR...');
        return await extractTextFromImagePDF(buffer);
      } catch (pdfError) {
        console.log('PDF parsing failed, trying OCR...', pdfError.message);
        // If pdf-parse fails, try OCR
        return await extractTextFromImagePDF(buffer);
      }
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } else if (mimeType.includes('image')) {
      // For images, use OCR with pre-processing
      return await extractTextFromImage(buffer);
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error('Failed to extract text from file');
  }
}

// Enhanced function for image-based PDFs
async function extractTextFromImagePDF(pdfBuffer) {
  try {
    // For now, we'll use Tesseract directly on the PDF buffer
    // In a more advanced implementation, you might want to convert PDF pages to images first
    const { data: { text } } = await tesseract.recognize(pdfBuffer, 'eng', {
      logger: m => console.log(m) // Optional: log progress
    });
    
    return text;
  } catch (error) {
    console.error('OCR for PDF failed:', error);
    throw new Error('Could not extract text from image-based PDF');
  }
}

// Enhanced function for image OCR with pre-processing
async function extractTextFromImage(imageBuffer) {
  try {
    // Pre-process image to improve OCR accuracy
    const processedImage = await sharp(imageBuffer)
      .grayscale() // Convert to grayscale
      .normalize() // Enhance contrast
      .sharpen() // Sharpen image
      .toBuffer();
    
    const { data: { text } } = await tesseract.recognize(processedImage, 'eng', {
      logger: m => console.log(m), // Optional: log progress
      tessedit_pageseg_mode: '6', // Uniform block of text
      tessedit_ocr_engine_mode: '1' // Neural nets LSTM engine
    });
    
    return text;
  } catch (error) {
    console.error('Image OCR failed:', error);
    
    // Fallback: try without pre-processing
    try {
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text;
    } catch (fallbackError) {
      console.error('Fallback OCR also failed:', fallbackError);
      throw new Error('Could not extract text from image');
    }
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
      console.log(`Processing file ${i + 1} of ${files.length}, type: ${file.type}`);
      
      try {
        const text = await extractTextFromFile(file.data, file.type);
        if (text && text.trim().length > 0) {
          combinedText += text + '\n\n';
          console.log(`Successfully extracted ${text.length} characters from file ${i + 1}`);
        } else {
          console.log(`No text extracted from file ${i + 1}`);
          combinedText += `[No text could be extracted from file ${i + 1}]\n\n`;
        }
      } catch (error) {
        console.error(`Error processing file ${i + 1}:`, error);
        // Continue with other files even if one fails
        combinedText += `[Error processing file ${i + 1}: ${error.message}]\n\n`;
      }
    }

    console.log(`Successfully extracted text from ${files.length} files for ${fileType}, total characters: ${combinedText.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true,
        extractedText: combinedText,
        fileType: fileType,
        filesProcessed: files.length
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