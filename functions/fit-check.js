// functions/fit-check.js
// POST body: { userId, sessionToken, cvText, position: { title, company, qualification, experience, salary, expireDate, fullDescription } }
//
// Checks ONE specific job in depth and returns a short, human verdict, using
// DeepSeek. The user is charged the REAL tokens DeepSeek used (lib/ai-billing.js).
//   - "fit"     → reasonably qualified. Soft/learnable gaps (e.g. a tool or skill
//                 not mentioned on the CV) do NOT disqualify — they're noted as
//                 something to develop or simply clarify, since the CV may just be
//                 incomplete.
//   - "not_fit" → a hard, explicit, unmet requirement — e.g. the post requires a
//                 minimum CGPA/degree/certification/years of experience and the CV's
//                 stated numbers fall short.
//
// Response on success: { success, fit, reason, tip, tokensUsed, tokenBalance }
// Not enough CT:        402 { error, code:'INSUFFICIENT_TOKENS', tokenBalance }
//
// IMPORTANT: never return raw provider/AI error text (error.message from the
// AI provider) in the HTTP response — it can include quota details, internal
// URLs, and JSON error blobs that shouldn't be shown to end users. Full errors
// are logged server-side via console.error for our own debugging; the client
// only ever receives a short, generic, safe message.


const { runBilledChat, errorResponse, parseJsonLoose } = require('./lib/ai-billing');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, sessionToken, cvText, position } = body;

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('fit-check: Missing DEEPSEEK_API_KEY');
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }

  if (!cvText || cvText.trim().length < 20) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A CV is required for the Fit/Not fit test.' }) };
  }
  if (!position || !position.title) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Job position details are required.' }) };
  }

  try {
    const MAX_TEXT_LENGTH = 12000; // users pay per token — a fit check never needs more than this
    const truncatedCv = cvText.length > MAX_TEXT_LENGTH ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]' : cvText;

    const positionText = `
      Title: ${position.title || ''}
      Company: ${position.company || ''}
      Qualification: ${position.qualification || ''}
      Experience required: ${position.experience || ''}
      Salary: ${position.salary || ''}
      Full description: ${(position.fullDescription || '').substring(0, 4000)}
    `;

    const prompt = `
      You are talking directly to a job applicant, helping them understand whether
      THEY are a reasonable fit for ONE specific job posting, by comparing their CV
      against the posting's requirements. Address them directly as "you"/"your" in
      the reason and tip — never refer to them in the third person (never say "the
      applicant" or "the candidate").

      THEIR CV:
      """
      ${truncatedCv}
      """

      JOB POSTING:
      """
      ${positionText}
      """

      HOW TO JUDGE FIT — this distinction matters a lot:

      1. Treat them as "fit" (verdict: "fit") when the gap is something that could
         reasonably be a CV omission, or something learnable/developable on the job:
         - A specific tool, software, or soft skill mentioned in the posting but not listed
           on the CV (e.g. "computer skills" or "Excel" not mentioned). They may simply
           have forgotten to list it, or could pick it up quickly.
         - Preferred (not mandatory) qualifications the posting lists as a "plus" or "nice
           to have" rather than a strict requirement.
         - Experience that's close to what's asked but not an exact field/title match, where
           transferable skills plausibly apply.
         In these cases, say they ARE a fit, and briefly note the specific gap as something
         to develop, mention, or clarify — framed constructively, not as a disqualifier.

      2. Treat them as "not fit" (verdict: "not_fit") ONLY when there's a hard,
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
        "reason": "One short sentence (max ~25 words) explaining the verdict, speaking directly to the applicant with 'you'/'your' — e.g. 'You're a strong fit — your CV covers the core requirements even though X isn't listed.' Never say 'the applicant' or 'the candidate'.",
        "tip": "Optional: if fit but with a gap, one short sentence speaking directly to the applicant ('you'/'your') suggesting what to develop or mention. Empty string if not applicable or if not_fit."
      }
    `;

    // Validation rejects an unusable answer BEFORE anything is charged; it is
    // then retried once automatically inside runBilledChat.
    const validate = (text) => {
      let parsed;
      try { parsed = parseJsonLoose(text); }
      catch (e) { throw new Error('AI returned an unexpected format.'); }
      if (!parsed || (parsed.verdict !== 'fit' && parsed.verdict !== 'not_fit') || !parsed.reason) {
        throw new Error('AI response was missing required fields.');
      }
      return parsed;
    };

    const { parsed, tokensUsed, tokenBalance } = await runBilledChat({
      userId, sessionToken,
      feature: 'fit-check',
      messages: [
        { role: 'system', content: 'You are a fair, practical career advisor. You reply with valid JSON only.' },
        { role: 'user',   content: prompt }
      ],
      maxTokens: 400,
      temperature: 0.2,
      json: true,
      validate
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        fit: parsed.verdict === 'fit',
        reason: (parsed.reason || '').toString().trim(),
        tip: (parsed.tip || '').toString().trim(),
        tokensUsed,
        tokenBalance
      })
    };

  } catch (error) {
    // Full detail (provider error, stack, etc) goes to server logs ONLY — the
    // client always gets a short, generic, safe message.
    return errorResponse(error, 'We are unable to complete your request right now. Please try again in a moment.');
  }
};