const tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { files } = JSON.parse(event.body);
  
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('OCR timeout after 25 seconds')), 25000);
  });

  const extractionPromise = (async () => {
    const results = [];
    
    for (const file of files) {
      try {
        const buffer = Buffer.from(file.data, 'base64');
        let text = '';
        
        if (file.type.includes('image')) {
          const result = await tesseract.recognize(buffer, 'eng', {
            tessedit_pageseg_mode: '6',
            tessedit_ocr_engine_mode: '1',
          });
          text = result.data.text;
        } else if (file.type.includes('pdf')) {
          const data = await pdfParse(buffer);
          text = data.text;
        } else if (file.type.includes('word')) {
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        }
        
        results.push({ success: true, text });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    
    return results;
  })();

  try {
    const results = await Promise.race([extractionPromise, timeoutPromise]);
    return { statusCode: 200, body: JSON.stringify({ results }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};