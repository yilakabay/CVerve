const axios = require('axios');

exports.handler = async (event) => {
  const { cvText, jdText, applicantInfo } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('API timeout after 15 seconds')), 15000);
  });

  const apiPromise = axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Professional resume writer' },
        { role: 'user', content: `JD: ${jdText}\nCV: ${cvText}\nInfo: ${JSON.stringify(applicantInfo)}\nWrite application letter:` }
      ],
      max_tokens: 1500,
      temperature: 0.7
    },
    {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 10000
    }
  );

  try {
    const response = await Promise.race([apiPromise, timeoutPromise]);
    return { statusCode: 200, body: JSON.stringify({ letterText: response.data.choices[0].message.content }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};