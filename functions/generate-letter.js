const axios = require('axios');
const FormData = require('form-data');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { prompt, cvData, jdData, cvFileType, jdFileType } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Create form data for multipart request
    const formData = new FormData();
    
    // Add files to form data
    const cvBuffer = Buffer.from(cvData, 'base64');
    const jdBuffer = Buffer.from(jdData, 'base64');
    
    formData.append('file', cvBuffer, {
      filename: 'cv.' + cvFileType.split('/')[1],
      contentType: cvFileType
    });
    
    formData.append('file', jdBuffer, {
      filename: 'jd.' + jdFileType.split('/')[1],
      contentType: jdFileType
    });

    // Add the JSON payload
    const payload = {
      model: "deepseek-reasoner",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };
    
    formData.append('payload', JSON.stringify(payload));

    // Make request to DeepSeek API
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
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