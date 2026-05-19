const { GoogleGenerativeAI } = require('@google/generative-ai');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvText, jdText } = JSON.parse(event.body);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key' }) };
  }

  try {
    if (!cvText || cvText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'CV text is required and must contain sufficient content' }) };
    }
    if (!jdText || jdText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Job description text is required and must contain sufficient content' }) };
    }

    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", jdText.length);

    // Truncate very long texts (Gemini 2.5 Flash has 1M context, but keep for safety)
    const MAX_TEXT_LENGTH = 50000;
    const truncatedJdText = jdText.length > MAX_TEXT_LENGTH 
      ? jdText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : jdText;
    const truncatedCvText = cvText.length > MAX_TEXT_LENGTH
      ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : cvText;

    console.log("Sending request to Gemini 2.5 Flash...");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: "v1beta" });

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
      2. Write a clear subject line that mentions the specific position the user is applying for next to the company information. This is crucial and must not be skipped.
      3. Do not use placeholders like [Company Name] or [Position Title]; use the actual names.
      4. Format the contact information at the top: Name, Phone, Email, Address, Date (just put the values, no labels).
      5. Address the letter to the appropriate recipient by name. If no name is provided, use "Dear Hiring Manager."
      6. Keep the letter professional, concise, and approximately 4/5 of a page in length including the user and the company information.
      7. Do not mention attaching a resume or other documents.
      8. Only mention the applicant's Grade Point Average (GPA) if it is 3.0 or higher. Do not include the "/4.0" scale.
      9. Adopt a humble and factual tone; avoid exaggeration and overpromising.
      10. If the applicant's relevant experience is primarily from internships (and not long-term roles), focus on their soft skills and educational alignment with the position rather than the duration of their experience.
      11. Do not use any listing or bullet points. Just plain paragraphs. About three paragraphs that state the user understands the job, fits the position, and is really interested.
      12. Do not bold any text on the letter.
      13. Avoid using em dashes (—).
      
      Now generate the application letter following all these guidelines precisely:
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const letterText = response.text();

    console.log("Letter generated successfully");

    return {
      statusCode: 200,
      body: JSON.stringify({ letterText })
    };
  } catch (error) {
    console.error('Letter generation error:', error);
    let errorMessage = 'Failed to generate letter. ';
    if (error.message.includes('timeout')) {
      errorMessage += 'The AI request took too long. Please try again.';
    } else {
      errorMessage += error.message || 'An unexpected error occurred.';
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};