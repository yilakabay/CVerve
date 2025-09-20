const axios = require('axios');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { prompt, cvData, jdData, cvFileType, jdFileType } = JSON.parse(event.body);
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: cvFileType, data: cvData } },
          { inlineData: { mimeType: jdFileType, data: jdData } }
        ]
      }],
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const letterText = response.data.candidates[0].content.parts[0].text;

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