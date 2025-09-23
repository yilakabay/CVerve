const axios = require('axios');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvText, jdText } = JSON.parse(event.body);
  const apiKey = process.env.DEEPSEEK_API_KEY;

  try {
    // Validate input
    if (!cvText || cvText.length < 20) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'CV text is required and must contain sufficient content' })
      };
    }

    if (!jdText || jdText.length < 20) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job description text is required and must contain sufficient content' })
      };
    }

    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", jdText.length);

    // Truncate very long texts if necessary (keep most of the content)
    const MAX_TEXT_LENGTH = 15000;
    const truncatedJdText = jdText.length > MAX_TEXT_LENGTH 
      ? jdText.substring(0, MAX_TEXT_LENGTH) + '... [text truncated for length]'
      : jdText;
    
    const truncatedCvText = cvText.length > MAX_TEXT_LENGTH
      ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [text truncated for length]'
      : cvText;

    console.log("Sending request to AI...");

    const prompt = `
      JOB DESCRIPTION:
      ${truncatedJdText}

      APPLICANT'S CV:
      ${truncatedCvText}

      APPLICANT INFORMATION:
      - Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Date: ${appDate}

      INSTRUCTIONS:
      Write a professional application letter for the position described in the JOB DESCRIPTION section.
      
      IMPORTANT: 
      1. Use the exact company name and position title from the JOB DESCRIPTION
      2. Do NOT use placeholders like [Company Name] or [Position Title]
      3. Reference specific requirements from the job description
      4. Highlight how the applicant's qualifications match the job requirements
      5. Format the contact information at the top: Name, Phone, Email, Address, Date
      6. Address the letter to the appropriate recipient (Hiring Manager if no specific name)
      7. Keep the letter professional and about 4/5 of a page
      8. Do not mention attaching a CV or documents
      9. Only mention GPA if it's 3.00/4.00 or higher

      Now generate the application letter:
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Always use exact details from the job description without placeholders. If the job description mentions a specific company and position, use those exact names.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 25000 // 25 second timeout for AI
      }
    );

    const letterText = response.data.choices[0].message.content;
    console.log("Letter generated successfully");

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error.message);
    
    let errorMessage = 'Failed to generate letter. ';
    
    if (error.message.includes('timeout')) {
      errorMessage += 'The AI request took too long. Please try again.';
    } else {
      errorMessage += 'Please check your internet connection and try again.';
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};