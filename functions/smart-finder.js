// functions/smart-finder.js
// POST body: { userId, sessionToken, cvText, jobs: [{ jobId, positionIndex, company, title, qualification, experience, shortDescription }] }
//
// Sends the user's CV plus a compact list of open positions to DeepSeek and
// asks it to return only the positions that are a reasonable fit, each with a
// 0-100 match score and a short reason — so the user doesn't have to read
// every posting. The user is charged the REAL tokens DeepSeek used
// (lib/ai-billing.js), so a bigger batch of jobs costs more CT than a small one.
//
// Response on success: { success, matches, tokensUsed, tokenBalance }
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

  const { userId, sessionToken, cvText, jobs } = body;

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('smart-finder: Missing DEEPSEEK_API_KEY');
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to complete your request right now. Please try again in a moment.' }) };
  }

  if (!cvText || cvText.trim().length < 20) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A CV is required to use Smart Finder. Please upload or autofill your CV first.' }) };
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ success: true, matches: [] }) };
  }

  try {
    const MAX_TEXT_LENGTH = 12000; // users pay per token — matching never needs more of the CV than this
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

    const prompt = `
      You are a job-matching assistant talking directly to a job seeker. Given their
      CV and a list of open positions, decide which positions are a reasonable fit
      for THEM. Address them directly as "you"/"your" in every reason — never refer
      to them in the third person (never say "the applicant" or "the candidate").

      THEIR CV:
      """
      ${truncatedCv}
      """

      OPEN POSITIONS (JSON array, each with an "idx" you must reference in your answer):
      ${JSON.stringify(compactJobs)}

      INSTRUCTIONS:
      - Judge fit based on qualifications, experience, and role alignment with the CV.
      - Only include positions that are a genuine, defensible match — do not include weak or unrelated matches just to fill space. It is fine to return an empty list if nothing fits well.
      - Give each included position a matchScore from 0-100 (100 = ideal fit).
      - Give each included position a short reason (1 sentence, specific to their background, speaking directly to them with "you"/"your" — e.g. "Your 3 years in customer support and CRM tools line up well with this role." Never say "the applicant" or "the candidate".)
      - Sort the result by matchScore, highest first.

      Return ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:
      {
        "matches": [
          { "idx": 0, "matchScore": 87, "reason": "Your experience with... makes this a strong match." }
        ]
      }
    `;

    const validate = (text) => {
      let parsed;
      try { parsed = parseJsonLoose(text); }
      catch (e) { throw new Error('AI returned an unexpected format.'); }
      if (!parsed || !Array.isArray(parsed.matches)) throw new Error('AI response was missing required fields.');
      return parsed;
    };

    const { parsed, tokensUsed, tokenBalance } = await runBilledChat({
      userId, sessionToken,
      feature: 'smart-finder',
      messages: [
        { role: 'system', content: 'You are a careful job-matching assistant. You reply with valid JSON only.' },
        { role: 'user',   content: prompt }
      ],
      maxTokens: 1500,
      temperature: 0.2,
      json: true,
      validate
    });

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

    return { statusCode: 200, body: JSON.stringify({ success: true, matches, tokensUsed, tokenBalance }) };

  } catch (error) {
    // Full detail (provider error, stack, etc) goes to server logs ONLY — the
    // client always gets a short, generic, safe message.
    return errorResponse(error, 'We are unable to complete your request right now. Please try again in a moment.');
  }
};