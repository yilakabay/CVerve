const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const tesseract = require('tesseract.js');
const sharp = require('sharp');

// Function to extract text from different file types
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (mimeType.includes('pdf')) {
      return await extractTextFromPDF(buffer);
    } else if (mimeType.includes('word') || mimeType.includes('document')) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } else if (mimeType.includes('image')) {
      return await extractTextFromImage(buffer);
    } else {
      throw new Error('Unsupported file type: ' + mimeType);
    }
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error('Failed to extract text from file: ' + error.message);
  }
}

// Simplified function for PDFs - ONLY use pdf-parse, no OCR attempts
async function extractTextFromPDF(pdfBuffer) {
  try {
    console.log('Extracting text from PDF using pdf-parse...');
    
    const data = await pdfParse(pdfBuffer);
    
    // Check if we got meaningful text
    if (data.text && data.text.trim().length > 0) {
      console.log(`Successfully extracted ${data.text.length} characters from PDF`);
      return data.text;
    } else {
      throw new Error('PDF appears to be image-based or contains no extractable text');
    }
  } catch (error) {
    console.log('PDF extraction failed:', error.message);
    throw new Error('Could not extract text from PDF. If this is an image-based PDF, please convert it to images (JPG/PNG) and upload those instead.');
  }
}

// Function for image OCR
async function extractTextFromImage(imageBuffer) {
  try {
    console.log('Processing image with OCR...');
    
    // Pre-process image to improve OCR accuracy
    let processedBuffer;
    try {
      processedBuffer = await sharp(imageBuffer)
        .grayscale()
        .normalize()
        .sharpen()
        .toBuffer();
      console.log('Image pre-processing successful');
    } catch (processError) {
      console.log('Image pre-processing failed, using original image:', processError.message);
      processedBuffer = imageBuffer;
    }
    
    const { data: { text } } = await tesseract.recognize(processedBuffer, 'eng', {
      logger: m => console.log(m)
    });
    
    if (text && text.trim().length > 0) {
      console.log('Successfully extracted text from image');
      return text;
    } else {
      throw new Error('No text found in image');
    }
  } catch (error) {
    console.error('Image OCR failed:', error.message);
    
    // Fallback: try without pre-processing
    try {
      console.log('Trying OCR without pre-processing...');
      const { data: { text } } = await tesseract.recognize(imageBuffer, 'eng');
      return text || '[No text could be extracted from the image]';
    } catch (fallbackError) {
      console.error('Fallback OCR also failed:', fallbackError.message);
      throw new Error('Could not extract text from image. The image may be too low quality or contain no text.');
    }
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (parseError) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON in request body' })
    };
  }

  const { files, fileType } = requestBody;

  try {
    if (!files || !Array.isArray(files) || files.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Files are required and must be an array' })
      };
    }

    console.log(`Starting text extraction for ${fileType} files. Number of files: ${files.length}`);

    let combinedText = '';
    let successfulFiles = 0;
    
    // Process files sequentially to avoid memory issues
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Processing file ${i + 1} of ${files.length}, type: ${file.type}`);
      
      if (!file.data || !file.type) {
        console.log(`Skipping file ${i + 1} - missing data or type`);
        combinedText += `[File ${i + 1}: Missing data or type]\n\n`;
        continue;
      }

      try {
        const text = await extractTextFromFile(file.data, file.type);
        if (text && text.trim().length > 0) {
          combinedText += text + '\n\n';
          successfulFiles++;
          console.log(`Successfully extracted ${text.length} characters from file ${i + 1}`);
        } else {
          console.log(`No text extracted from file ${i + 1}`);
          combinedText += `[File ${i + 1}: No text could be extracted]\n\n`;
        }
      } catch (error) {
        console.error(`Error processing file ${i + 1}:`, error.message);
        combinedText += `[File ${i + 1}: ${error.message}]\n\n`;
      }
    }

    console.log(`Processing complete. Successfully processed ${successfulFiles} out of ${files.length} files. Total characters: ${combinedText.length}`);

    // If no text was extracted from any file, return a specific error
    if (combinedText.trim().length === 0 || successfulFiles === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Could not extract text from any of the provided files. Please ensure your files contain readable text and are in supported formats (PDF, Word, Images). For image-based PDFs, convert to images (JPG/PNG) and upload those instead.' 
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true,
        extractedText: combinedText,
        fileType: fileType,
        filesProcessed: files.length,
        successfulFiles: successfulFiles
      })
    };
  } catch (error) {
    console.error('Extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: `Extraction failed: ${error.message}`,
        suggestion: 'For image-based PDFs, please convert to images (JPG/PNG) and upload those instead.'
      })
    };
  }
};