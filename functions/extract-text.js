const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

// Function to check if PDF contains actual text or is image-based
async function isImageBasedPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    // If the PDF has very little text (less than 50 characters), it's likely image-based
    return data.text.trim().length < 50;
  } catch (error) {
    // If pdf-parse fails, assume it's image-based
    return true;
  }
}

// Function to extract text from image-based PDF by converting pages to images
async function extractTextFromImagePDF(buffer) {
  try {
    // Note: This is a simplified approach. For production, you might want to use a dedicated PDF-to-image service
    // Since we can't easily convert PDF to images in serverless, we'll try to extract any embedded images
    const data = await pdfParse(buffer);
    let extractedText = data.text;
    
    // If we have very little text, try to extract from any embedded images
    if (data.text.trim().length < 100 && data.text.numpages > 0) {
      console.log('PDF appears to be image-based, attempting enhanced extraction...');
      
      // Try to extract text using a different approach
      // For now, we'll return the minimal text we got and a message
      extractedText += '\n\n[Note: This PDF appears to be image-based. For better results, please upload the original document or screenshots of the text.]';
    }
    
    return extractedText;
  } catch (error) {
    throw new Error('Failed to extract text from image-based PDF');
  }
}

// Enhanced function to extract text from different file types
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (mimeType.includes('pdf')) {
      console.log('Processing PDF file...');
      
      // First, check if it's a real PDF or image-based
      const isImagePDF = await isImageBasedPDF(buffer);
      
      if (isImagePDF) {
        console.log('Detected image-based PDF, using special handling...');
        return await extractTextFromImagePDF(buffer);
      } else {
        console.log('Detected text-based PDF, using standard extraction...');
        const data = await pdfParse(buffer);
        return data.text;
      }
      
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      console.log('Processing Word document...');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
      
    } else if (mimeType.includes('image')) {
      console.log('Processing image file...');
      
      // Preprocess image for better OCR results
      const processedImage = await sharp(buffer)
        .resize(2000, 2000, { // Resize for better OCR
          fit: 'inside',
          withoutEnlargement: true
        })
        .grayscale() // Convert to grayscale for better OCR
        .sharpen() // Sharpen the image
        .normalize() // Normalize contrast
        .toBuffer();
      
      const { data: { text } } = await tesseract.recognize(processedImage, 'eng', {
        logger: m => console.log(m),
        // Configure OCR for better accuracy
        tessedit_pageseg_mode: '6', // Uniform block of text
        tessedit_ocr_engine_mode: '1' // Neural nets LSTM engine
      });
      
      return text;
    } else {
      throw new Error('Unsupported file type: ' + mimeType);
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    
    // Provide more specific error messages
    if (error.message.includes('PDF')) {
      throw new Error('PDF processing failed. The file may be corrupted or password protected.');
    } else if (error.message.includes('image')) {
      throw new Error('Image processing failed. Please ensure the image is clear and contains readable text.');
    } else {
      throw new Error('Failed to extract text from file: ' + error.message);
    }
  }
}

// Function to validate extracted text
function validateExtractedText(text, fileType) {
  if (!text || text.trim().length === 0) {
    throw new Error(`No text could be extracted from the ${fileType} file. The file may be blank, corrupted, or in an unsupported format.`);
  }
  
  // Check if text is mostly garbage (very short or mostly special characters)
  const cleanText = text.replace(/[^a-zA-Z0-9]/g, '');
  if (cleanText.length < 10) {
    throw new Error(`Very little readable text found in the ${fileType} file. The file may be image-based with poor quality or in an unsupported language.`);
  }
  
  return text;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { files, fileType } = JSON.parse(event.body);

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
      console.log(`Processing file ${i + 1} of ${files.length} (${fileType})`);
      console.log('File type:', file.type);
      
      try {
        const text = await extractTextFromFile(file.data, file.type);
        const validatedText = validateExtractedText(text, fileType);
        combinedText += validatedText + '\n\n';
        
        console.log(`Successfully extracted ${validatedText.length} characters from file ${i + 1}`);
      } catch (error) {
        console.error(`Error processing file ${i + 1}:`, error);
        
        // Add error information to the combined text but don't fail completely
        combinedText += `[Error processing file ${i + 1}: ${error.message}]\n\n`;
        
        // If it's the first file and we have multiple, continue
        if (files.length > 1) {
          continue;
        } else {
          throw error; // If it's the only file, re-throw the error
        }
      }
    }

    // Final validation of combined text
    if (!combinedText || combinedText.replace(/\[Error[^\]]+\]/g, '').trim().length === 0) {
      throw new Error('No readable text could be extracted from any of the files.');
    }

    console.log(`Successfully extracted total ${combinedText.length} characters for ${fileType}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true,
        extractedText: combinedText,
        fileType: fileType,
        characterCount: combinedText.length
      })
    };
  } catch (error) {
    console.error('Extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: `Extraction failed: ${error.message}`,
        suggestion: 'Please ensure your files contain clear, readable text and are in supported formats (PDF, Word, or clear images).'
      })
    };
  }
};