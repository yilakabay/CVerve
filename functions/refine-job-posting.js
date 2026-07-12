// functions/refine-job-posting.js
// POST body: { token, jdText?, jdUrl? }
//
// Admin pastes a job posting URL OR supplies text already extracted client-side
// (e.g. via extract-text.js, same flow used for letter generation uploads).
// This function resolves the raw text, then asks Gemini to structure it into:
//   { company, positions: [ { title, qualification, experience, salary, expireDate,
//                              shortDescription, fullDescription } ] }
//
// shortDescription = the teaser shown on the job feed card
// fullDescription  = the complete detail shown when the user taps "Detail"
//
// This does NOT save anything — admin.html reviews/edits the structured result,
// then calls manage-jobs.js (action: 'create') to actually post it.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret   = process.env.ADMIN_SECRET || 'cverve_admin_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) return false;
    return data.admin === true;
  } catch { return false; }
}

// ── Fetch plain text from a URL (mirrors generate-letter.js) ─────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVcaseBot/1.0)' } }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch URL: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL fetch timed out after 15 seconds.')); });
    req.on('error', reject);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Strip ``` / ```json fences some models add, then parse
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

  const { token, jdText, jdUrl } = body;

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key' }) };
  }

  try {
    // ── Resolve raw text ───────────────────────────────────────────────────
    let rawText = jdText || '';

    if (jdUrl && (!jdText || jdText.trim().length < 20)) {
      try {
        const rawHtml = await fetchUrl(jdUrl);
        rawText = htmlToText(rawHtml);
      } catch (fetchErr) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Could not fetch the job posting URL: ${fetchErr.message}` })
        };
      }
    }

    if (!rawText || rawText.trim().length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Job posting text is required and must contain sufficient content.' }) };
    }

    const MAX_TEXT_LENGTH = 50000;
    const truncated = rawText.length > MAX_TEXT_LENGTH
      ? rawText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : rawText;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });

    const prompt = `
      You are structuring a raw job posting (possibly containing several openings from
      one company) into clean, consistent JSON for a job board.

      RAW SOURCE TEXT:
      """
      ${truncated}
      """

      Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

      {
        "company": "Company Name",
        "positions": [
          {
            "title": "Exact position title",
            "qualification": "Required qualifications/education, as a short paragraph",
            "experience": "Required years/type of experience, as a short paragraph",
            "salary": "Salary or salary range if stated, otherwise \\"Not specified\\"",
            "expireDate": "Application deadline if stated, in YYYY-MM-DD format if possible, otherwise \\"Not specified\\"",
            "shortDescription": "1-2 sentence teaser summarizing the role, shown on a job feed card",
            "fullDescription": "The complete detail for this position — responsibilities, requirements, benefits, how to apply, everything relevant from the source, well formatted with line breaks between sections. Do not include information about OTHER positions here.",
            "applicationType": "\\"online\\" or \\"physical\\" — see rules below",
            "applicationUrl": "If an application link/URL/email is explicitly given in the source for THIS position, extract it exactly as written. Otherwise empty string.",
            "physicalAddress": "Only if applicationType is \\"physical\\": the office/location address stated for submitting the application in person. Otherwise empty string."
          }
        ]
      }

      RULES:
      - If multiple distinct positions/openings are present in the source, create one object per position in the "positions" array, numbered implicitly by array order.
      - If only one position is present, return an array with a single object.
      - Do not invent facts. If a field isn't stated in the source, use "Not specified".
      - Keep "shortDescription" genuinely short (max ~30 words) — it's a preview, not the full posting.
      - "fullDescription" should be thorough and self-contained for that specific position only.
      - "applicationType": use "physical" ONLY when the posting explicitly requires submitting the application in person, by hand delivery, or by visiting a physical office/location to apply. Use "online" for everything else, including applying by email, an online portal/link, or when the method isn't stated at all — online is the default assumption.
      - "applicationUrl": only extract a value if the source text literally contains a link or email address meant for applying to THIS position. Never guess or construct a URL that isn't explicitly present — leave it as an empty string if unsure. The admin will fill this in manually afterward if it's missing.
      - Return raw JSON only — no backticks, no explanation text before or after.
    `;

    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        let structured;
        try {
          structured = parseJsonLoose(text);
        } catch (parseErr) {
          throw new Error('AI returned an unexpected format. Please try again.');
        }

        if (!structured || !structured.company || !Array.isArray(structured.positions) || structured.positions.length === 0) {
          throw new Error('AI response was missing required fields. Please try again.');
        }

        // Safety defaults in case the AI omits the newer application-method fields
        structured.positions = structured.positions.map(p => ({
          ...p,
          applicationType:  (p.applicationType === 'physical') ? 'physical' : 'online',
          applicationUrl:   p.applicationUrl || '',
          physicalAddress:  p.physicalAddress || ''
        }));

        return { statusCode: 200, body: JSON.stringify({ success: true, ...structured }) };
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
    console.error('refine-job-posting error:', error);
    let errorMessage = 'Failed to refine job posting. ';
    if (error.message.includes('503') || error.message.includes('high demand')) {
      errorMessage += 'The AI service is currently busy. Please wait a moment and try again.';
    } else {
      errorMessage += error.message || 'An unexpected error occurred.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};