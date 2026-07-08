// functions/smart-finder.js
// POST body: { cvText, jobs: [{ jobId, positionIndex, company, title, qualification, experience, shortDescription }] }
//
// Basic/Pro-only feature (gated client-side by plan; this function itself does
// not enforce the plan — app.html only calls it when planLimit('smartFinder') is true).
//
// Sends the user's CV plus a compact list of open positions to Gemini and asks it
// to return only the positions that are a reasonable fit, each with a 0-100 match
// score and a short reason — so the user doesn't have to read every posting.

const { GoogleGenerativeAI } = require('@google/generative-ai');

function parseJsonLoose(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cvText, jobs } = body;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key' }) };
  }

  if (!cvText || cvText.trim().length < 20) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A CV is required to use Smart Finder. Please upload or autofill your CV first.' }) };
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ success: true, matches: [] }) };
  }

  try {
    const MAX_TEXT_LENGTH = 30000;
    const truncatedCv = cvText.length > MAX_TEXT_LENGTH ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]' : cvText;

    // Keep the position list compact — only what's needed to judge fit
    const compactJobs = jobs.map((j, i) => ({
      idx:           i,
      company:       j.company || '',
      title:         j.title || '',
      qualification: (j.qualification || '').substring(0, 600),
      experience:    (j.experience || '').substring(0, 600),
      summary:       (j.shortDescription || '').substring(0, 300)
    }));

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });

    const prompt = `
      You are a job-matching assistant. Given an applicant's CV and a list of open
      positions, decide which positions are a reasonable fit for this applicant.

      APPLICANT'S CV:
      """
      ${truncatedCv}
      """

      OPEN POSITIONS (JSON array, each with an "idx" you must reference in your answer):
      ${JSON.stringify(compactJobs)}

      INSTRUCTIONS:
      - Judge fit based on qualifications, experience, and role alignment with the CV.
      - Only include positions that are a genuine, defensible match — do not include weak or unrelated matches just to fill space. It is fine to return an empty list if nothing fits well.
      - Give each included position a matchScore from 0-100 (100 = ideal fit).
      - Give each included position a short reason (1 sentence, specific to this applicant's background, not generic).
      - Sort the result by matchScore, highest first.

      Return ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:
      {
        "matches": [
          { "idx": 0, "matchScore": 87, "reason": "Strong match because..." }
        ]
      }
    `;

    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        let parsed;
        try {
          parsed = parseJsonLoose(text);
        } catch (parseErr) {
          throw new Error('AI returned an unexpected format. Please try again.');
        }

        if (!parsed || !Array.isArray(parsed.matches)) {
          throw new Error('AI response was missing required fields. Please try again.');
        }

        // Map idx back to the original job identity, drop anything out of range
        const matches = parsed.matches
          .filter(m => Number.isInteger(m.idx) && jobs[m.idx])
          .map(m => ({
            jobId:         jobs[m.idx].jobId,
            positionIndex: jobs[m.idx].positionIndex,
            matchScore:    Math.max(0, Math.min(100, Math.round(m.matchScore || 0))),
            reason:        (m.reason || '').toString().trim()
          }))
          .sort((a, b) => b.matchScore - a.matchScore);

        return { statusCode: 200, body: JSON.stringify({ success: true, matches }) };
      } catch (err) {
        lastError = err;
        console.error(`Gemini attempt ${attempt} failed:`, err.message);
        const isRetryable = err.message.includes('503') || err.message.includes('high demand') ||
                             err.message.includes('429') || err.message.includes('quota');
        if (!isRetryable || attempt === MAX_ATTEMPTS) break;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    throw lastError;

  } catch (error) {
    console.error('smart-finder error:', error);
    let errorMessage = 'Smart Finder could not process your CV right now. ';
    if (error.message.includes('503') || error.message.includes('high demand')) {
      errorMessage += 'The AI service is currently busy. Please wait a moment and try again.';
    } else {
      errorMessage += error.message || 'An unexpected error occurred.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};