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

    // Truncate very long texts if necessary
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
      
      CRITICAL GUIDELINES:
      1. Use the exact company name and position title as they appear in the job description.
      2. Write a clear subject line that mentions the specific position the user is applying for next to the company information.
      3. Do not use placeholders like [Company Name] or [Position Title]; use the actual names.
      4. Reference specific requirements from the job description to demonstrate you have read it carefully.
      5. Highlight how the applicant's qualifications directly match the job's requirements.
      6. Format the contact information at the top: Name, Phone, Email, Address, Date
      7. Address the letter to the appropriate recipient by name. If no name is provided, use "Dear Hiring Manager."
      8. Keep the letter professional, concise, and approximately three-quarters of a page in length.
      9. Do not mention attaching a resume or other documents.
      10. Only mention the applicant's Grade Point Average (GPA) if it is 3.0 or higher. Do not include the "/4.0" scale.
      11. Adopt a humble and factual tone; avoid exaggeration.
      12. If the applicant's relevant experience is primarily from internships (and not long-term roles), focus on their soft skills and educational alignment with the position rather than the duration of their experience.
      13. Do not use any listing or bullet points, Just plain paragraphs. About three paragraphs that states the user understands the job, he fit the position and he is realy interested.
      Now generate the application letter following all these guidelines precisely:
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Always use exact details from the job description without placeholders. Follow all formatting instructions precisely. Maintain a humble, factual tone throughout.' 
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
        timeout: 25000
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