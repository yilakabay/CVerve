const axios = require('axios');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { prompt, cvData, jdData, cvFileType, jdFileType } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    const payload = {
      model: "deepseek-vl",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${cvFileType};base64,${cvData}`
              }
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${jdFileType};base64,${jdData}`
              }
            }
          ]
        }
      ],
      max_tokens: 2048
    };

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
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