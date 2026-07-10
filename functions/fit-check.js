// functions/fit-check.js
// POST body: { cvText, position: { title, company, qualification, experience, salary, expireDate, fullDescription } }
//
// Pro-only feature (gated client-side via planLimit('fitTests') > 0; this function
// itself does not enforce the plan — app.html only calls it for Pro users).
//
// Unlike Smart Finder (which screens many jobs at once), this checks ONE specific
// job in depth and returns a short, human verdict:
//   - "fit"     → reasonably qualified. Soft/learnable gaps (e.g. a tool or skill
//                 not mentioned on the CV) do NOT disqualify — they're noted as
//                 something to develop or simply clarify, since the CV may just be
//                 incomplete.
//   - "not_fit" → a hard, explicit, unmet requirement — e.g. the post requires a
//                 minimum CGPA/degree/certification/years of experience and the CV's
//                 stated numbers fall short.

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

  const { cvText, position } = body;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key' }) };
  }

  if (!cvText || cvText.trim().length < 20) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A CV is required for the Fit/Not fit test.' }) };
  }
  if (!position || !position.title) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Job position details are required.' }) };
  }

  try {
    const MAX_TEXT_LENGTH = 30000;
    const truncatedCv = cvText.length > MAX_TEXT_LENGTH ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]' : cvText;

    const positionText = `
      Title: ${position.title || ''}
      Company: ${position.company || ''}
      Qualification: ${position.qualification || ''}
      Experience required: ${position.experience || ''}
      Salary: ${position.salary || ''}
      Full description: ${(position.fullDescription || '').substring(0, 4000)}
    `;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });

    const prompt = `
      You are helping a job applicant understand whether they are a reasonable fit for
      ONE specific job posting, by comparing their CV against the posting's requirements.

      APPLICANT'S CV:
      """
      ${truncatedCv}
      """

      JOB POSTING:
      """
      ${positionText}
      """

      HOW TO JUDGE FIT — this distinction matters a lot:

      1. Treat the applicant as "fit" (verdict: "fit") when the gap is something that could
         reasonably be a CV omission, or something learnable/developable on the job:
         - A specific tool, software, or soft skill mentioned in the posting but not listed
           on the CV (e.g. "computer skills" or "Excel" not mentioned). The applicant may
           simply have forgotten to list it, or could pick it up quickly.
         - Preferred (not mandatory) qualifications the posting lists as a "plus" or "nice
           to have" rather than a strict requirement.
         - Experience that's close to what's asked but not an exact field/title match, where
           transferable skills plausibly apply.
         In these cases, say they ARE a fit, and briefly note the specific gap as something
         to develop, mention, or clarify — framed constructively, not as a disqualifier.

      2. Treat the applicant as "not fit" (verdict: "not_fit") ONLY when there's a hard,
         explicit, checkable requirement in the posting that the CV's own stated facts fail
         to meet — for example:
         - A minimum CGPA/GPA is stated and the CV states a lower one (e.g. posting requires
           above 3.5 CGPA, CV states 3.0).
         - A specific required degree/field is stated and the CV shows a clearly different,
           unrelated field, with the posting treating it as mandatory (not preferred).
         - A minimum number of years of experience is explicitly required and the CV shows
           meaningfully less.
         - A mandatory license/certification is required and the CV does not have it.
         Only use "not_fit" when you can point to the specific number or fact from the CV
         that falls short of a specific stated requirement in the posting.

      3. If information is simply missing/unclear on both sides (not stated in posting or
         not stated in CV), do not treat that as disqualifying — default toward "fit".

      Return ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:
      {
        "verdict": "fit" or "not_fit",
        "reason": "One short sentence (max ~25 words) explaining the verdict in plain, encouraging language.",
        "tip": "Optional: if fit but with a gap, one short sentence suggesting what to develop or mention. Empty string if not applicable or if not_fit."
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

        if (!parsed || (parsed.verdict !== 'fit' && parsed.verdict !== 'not_fit') || !parsed.reason) {
          throw new Error('AI response was missing required fields. Please try again.');
        }

        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            fit: parsed.verdict === 'fit',
            reason: (parsed.reason || '').toString().trim(),
            tip: (parsed.tip || '').toString().trim()
          })
        };
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
    console.error('fit-check error:', error);
    let errorMessage = 'Fit/Not fit check failed. ';
    if (error.message.includes('503') || error.message.includes('high demand')) {
      errorMessage += 'The AI service is currently busy. Please wait a moment and try again.';
    } else {
      errorMessage += error.message || 'An unexpected error occurred.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};