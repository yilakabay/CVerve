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

    const MAX_TEXT_LENGTH = 50000;
    const truncatedJdText = jdText.length > MAX_TEXT_LENGTH
      ? jdText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : jdText;
    const truncatedCvText = cvText.length > MAX_TEXT_LENGTH
      ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : cvText;

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
      Write a short, genuine application letter for the position in the JOB DESCRIPTION above.

      STRICT GUIDELINES:
      1. Total body length: exactly 3 paragraphs. Each paragraph is 3-4 sentences maximum. The entire letter body must fit in roughly two thirds of an A4 page — no more.
      2. Header block (no labels): Name, Phone, Email, Address, Date — each on its own line.
      3. Then a subject line naming the exact position and company.
      4. Then "Dear Hiring Manager" (or recipient name if given in the JD).
      5. Paragraph 1: State the position you are applying for and one or two specific reasons you are a strong fit, drawn directly from the CV and JD. Be factual and concrete, not generic.
      6. Paragraph 2: Express genuine interest in the company/role in one sentence, then close with availability and contact info in one sentence.
      7. Close with "Sincerely," then the applicant's name.
      8. Tone: natural, humble, and direct — write like a real person, not a template. Avoid corporate filler phrases such as "I am excited to apply", "I am confident", "leverage my skills", "dynamic team", or any similar buzzwords.
      9. No bullet points, no bold text, no em dashes, no placeholders.
      10. Only mention GPA if it is 3.0 or above; omit the "/4.0" scale.
      11. Do not mention attaching documents.

      Generate the letter now:
    `;

    // Retry logic: up to 3 attempts with 3-second delay between each
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Sending request to Gemini 2.5 Flash (attempt ${attempt} of ${MAX_ATTEMPTS})...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const letterText = response.text();
        console.log("Letter generated successfully on attempt", attempt);
        return {
          statusCode: 200,
          body: JSON.stringify({ letterText })
        };
      } catch (err) {
        lastError = err;
        console.error(`Gemini attempt ${attempt} failed:`, err.message);

        // Only retry on 503 (high demand) or 429 (rate limit); fail fast on other errors
        const isRetryable = err.message.includes('503') || err.message.includes('503 Service Unavailable') ||
                            err.message.includes('high demand') || err.message.includes('429') ||
                            err.message.includes('quota');

        if (!isRetryable || attempt === MAX_ATTEMPTS) break;

        console.log(`Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // All attempts failed
    throw lastError;

  } catch (error) {
    console.error('Letter generation error:', error);
    let errorMessage = 'Failed to generate letter. ';
    if (error.message.includes('503') || error.message.includes('high demand')) {
      errorMessage += 'The AI service is currently busy. Please wait a moment and try again.';
    } else if (error.message.includes('timeout')) {
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