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
      Write a professional application letter that will fit within 4/5 of a single page without page breaks.

      CRITICAL FORMATTING RULES:
      1. CONTACT INFORMATION FORMAT: At the top, format exactly like this (NO LABELS like "Email:", "Phone:"):
         ${fullName}
         ${phone}
         ${email}
         ${address}
         ${appDate}

      2. COMPANY ADDRESS: Below your contact info, leave a space and then add the company address from the job description.

      3. SALUTATION: After company address, use "Dear Hiring Manager," or the specific name if provided.

      4. CONTENT REQUIREMENTS:
         - Use the exact company name and position title from the job description
         - Do NOT use any placeholders like [Company Name] or [Position Title]
         - Reference specific requirements from the job description
         - Highlight how the applicant's qualifications match the job requirements
         - Keep the letter concise (approximately 250-300 words)
         - Use only plain paragraphs (NO bullet points or lists)
         - Three main paragraphs: understanding of job, qualifications, interest in position
         - Only mention GPA if 3.0 or higher (without "/4.0" scale)
         - For internship-heavy experience, focus on soft skills and education

      5. CLOSING: Use "Sincerely," followed by ${fullName}

      6. LENGTH CONTROL: The entire letter must fit within 4/5 of one page with normal formatting.

      Generate the application letter following ALL these rules precisely:
    `;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional resume writer. Format contact information without labels. Create concise letters that fit 4/5 of a page. Use exact details from job descriptions. Maintain humble, factual tone.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1200  // Reduced to ensure shorter output
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
[file content end]