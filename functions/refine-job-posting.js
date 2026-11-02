// functions/refine-job-posting.js
// POST body: { token, jdText?, jdUrl? }
//
// Admin pastes a job posting URL OR supplies text already extracted client-side
// (e.g. via extract-text.js, same flow used for letter generation uploads).
// This function resolves the raw text, then asks Gemini 3 Flash (via the
// B.AI gateway) to structure it into:
//   { company, positions: [ { title, qualification, experience, salary, expireDate,
//                              shortDescription, fullDescription } ] }
//
// shortDescription = the teaser shown on the job feed card
// fullDescription  = the complete detail shown when the user taps "Detail"
//
// This does NOT save anything — admin.html reviews/edits the structured result,
// then calls manage-jobs.js (action: 'create') to actually post it.
//
// This is an ADMIN tool, so it is NOT charged to any user's CT balance — it's
// part of running the platform. It calls `callAI` directly (not
// `runBilledChat`, which enforces a per-user balance gate that doesn't apply
// here).

const { callAI, parseJsonLoose, MODEL_IDS } = require('./lib/ai-billing');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

// A posting's "apply online" URL often arrives without a scheme, e.g.
// "www.ethiojobs.net" (some only ever give the bare domain, not a
// job-specific page — admin can still edit in a deeper link once they find
// one, but the domain itself is a useful fallback so applicants can go
// search the site). window.open()/location on a schemeless string like
// "www.ethiojobs.net" is treated as a RELATIVE path by the browser, not an
// external URL — so it was silently resolving to
// https://cverve.netlify.app/www.ethiojobs.net (our own site, 404) instead
// of https://www.ethiojobs.net. Always prefix with https:// when no scheme
// is present so "Open Link" actually leaves our app and lands on the real
// site.
function normalizeApplicationUrl(url) {
  const trimmed = (url || '').toString().trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

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

  if (!process.env.BAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing B.AI API key' }) };
  }

  // Wall-clock anchor for the WHOLE handler, not just one AI call. This is a
  // classic exports.handler-style function proxied through the same
  // AWS-API-Gateway path that extract-file.js/extract-text.js discovered has
  // a real, undocumented hard ceiling around 26-30s — well short of
  // Netlify's documented 60s. The old code gave EACH of up to 2 retry passes
  // its own fresh 24000ms callAI budget, so a genuinely slow posting (a
  // large multi-position one, pushing the full 8000-token JSON output) could
  // legitimately run pass 1 for ~24s, fail, then start pass 2 for another
  // ~24s — total wall time up to ~48s, guaranteed to blow past that real
  // ceiling and get killed mid-response with no clean error at all, which is
  // what actually produced "AI refinement failed" with no useful detail.
  // Fixed by budgeting the WHOLE handler against one deadline: pass 2 only
  // runs if there's real time left, and gets whatever time remains (never a
  // fresh full budget), so the total never approaches the real ceiling.
  //
  // Was 20000ms — too conservative. This handler does nothing but ONE AI
  // call (no vision reads, no multi-step tool loop), unlike cv-chat.mjs,
  // which does far more work per turn and still safely runs its own
  // HANDLER_DEADLINE_MS at 27000ms against this SAME real ~26-30s ceiling.
  // A posting with several positions, each needing a full, thorough
  // "fullDescription", genuinely needs more than 20s to generate up to
  // 8000 tokens of structured JSON — that, not a stuck/hung request, is
  // what was actually producing "The AI took too long" on real postings.
  // Matched to cv-chat.mjs's battle-tested value so this gets the same
  // safe margin other functions already rely on.
  const handlerStarted = Date.now();
  const HANDLER_DEADLINE_MS = 27000;
  const MIN_TIME_FOR_RETRY_MS = 6000; // a second AI pass needs a real chance to finish, not a token gesture
  function timeLeft() { return HANDLER_DEADLINE_MS - (Date.now() - handlerStarted); }

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
            "physicalAddress": "If the posting allows submitting the application in person, the office/location address stated for THIS position. Otherwise empty string.",
            "applicationEmail": "If the posting allows applying by email, the email address stated for THIS position, extracted exactly as written. If the source page's email is hidden by spam/scraper protection (shown as placeholder text like \\"[email protected]\\" instead of a real address), leave this empty — never output that placeholder text. Otherwise empty string.",
            "emailProtected": "true (boolean, not string) ONLY if this position is meant to be applied to by email but the real address could not be read because the source hid/obfuscated it (e.g. shows literal placeholder text instead of a real address). false in every other case, including when no email method is offered at all.",
            "applicationUrl": "If the posting allows applying via a link or online portal (not an email address), that URL for THIS position, extracted exactly as written. Otherwise empty string."
          }
        ]
      }

      RULES:
      - If multiple distinct positions/openings are present in the source, create one object per position in the "positions" array, numbered implicitly by array order.
      - If only one position is present, return an array with a single object.
      - Do not invent facts. If a field isn't stated in the source, use "Not specified".
      - Keep "shortDescription" genuinely short (max ~30 words) — it's a preview, not the full posting.
      - "fullDescription" should be thorough and self-contained for that specific position only.
      - A posting can offer MORE THAN ONE way to apply at once (e.g. both in person and by email, or both email and an online link). Fill in "physicalAddress", "applicationEmail" and "applicationUrl" independently — each one on its own, based only on what that specific method's instructions say. Leave any of them empty if that method isn't offered. Do not pick just one.
      - Never guess or construct a value that isn't explicitly present in the source — leave a field empty string if unsure. The admin will fill in anything missing manually afterward.
      - Return raw JSON only — no backticks, no explanation text before or after.
    `;

    // Up to 2 passes if the answer comes back unusable (not charged to anyone)
    // — but pass 2 only runs if there's genuinely enough of the handler's
    // own deadline left for it to have a real chance of finishing. See the
    // HANDLER_DEADLINE_MS comment above for why this is no longer "2 fresh
    // 24000ms attempts" the way it used to be.
    let structured, lastError;
    for (let pass = 1; pass <= 2; pass++) {
      const remaining = timeLeft();
      if (pass > 1 && remaining < MIN_TIME_FOR_RETRY_MS) {
        console.error(`refine-job-posting: skipping retry pass ${pass} — only ${remaining}ms left of the handler's own deadline.`);
        break;
      }
      try {
        const result = await callAI({
          model: MODEL_IDS.GEMINI_FLASH,
          messages: [
            { role: 'system', content: 'You turn raw job postings into clean structured JSON. You reply with valid JSON only.' },
            { role: 'user',   content: prompt }
          ],
          maxTokens: 8000,
          temperature: 0.1,
          json: true,
          timeoutMs: Math.max(3000, remaining - 500),
          attempts: 1 // the per-call internal retry loop is redundant with — and used to combine badly with — this outer pass loop; one real attempt per pass, budgeted off the real remaining time
        });

        let parsed;
        try { parsed = parseJsonLoose(result.text); }
        catch (parseErr) { throw Object.assign(new Error('AI returned an unexpected format. Please try again.'), { userFacing: true }); }

        if (!parsed || !parsed.company || !Array.isArray(parsed.positions) || parsed.positions.length === 0) {
          throw Object.assign(new Error('AI response was missing required fields. Please try again.'), { userFacing: true });
        }
        if (result.finishReason === 'length') {
          // Genuinely too big for one response at this token cap — asking
          // again won't help (it'll hit the same cap), so say so plainly
          // instead of quietly handing back a truncated/malformed posting.
          throw Object.assign(
            new Error('This posting has too much content to structure in one pass (it may list many positions). Please split it up — paste one position at a time, or a shorter excerpt.'),
            { retryable: false, userFacing: true }
          );
        }
        structured = parsed;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`refine-job-posting AI pass ${pass} failed:`, err.message);
        if (err.retryable === false) break;
      }
    }
    if (lastError) throw lastError;

    // Safety defaults, plus a cheap sanitize pass: a page that hides its
    // email behind spam/scraper protection (e.g. Cloudflare's "Email
    // Address Protection") only leaves behind placeholder text like
    // "[email protected]" where the real address should be — if that literal
    // text slips through into applicationEmail, never show it to the admin
    // as if it were a real value. Blank it and flag it instead, so
    // admin.html can prompt for the real address to be typed in by hand.
    // This is a plain string check on the AI's own output — it adds no
    // extra network/HTML work, so it carries none of the latency risk the
    // earlier full-page-decoding attempt did.
    const EMAIL_PLACEHOLDER_RE = /\[email(?:&#160;|&nbsp;|\s)*protected\]/i;
    structured.positions = structured.positions.map(p => {
      let applicationEmail = (p.applicationEmail || '').toString().trim();
      // Trust the AI's own emailProtected flag, but also catch the literal
      // placeholder text directly in case it slipped into the field anyway.
      let emailNeedsReview = p.emailProtected === true || EMAIL_PLACEHOLDER_RE.test(applicationEmail);
      if (EMAIL_PLACEHOLDER_RE.test(applicationEmail)) applicationEmail = '';

      const applicationUrl = normalizeApplicationUrl(p.applicationUrl);

      return {
        ...p,
        physicalAddress:  (p.physicalAddress || '').toString().trim(),
        applicationEmail,
        emailNeedsReview,
        applicationUrl
      };
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, ...structured }) };

  } catch (error) {
    console.error('refine-job-posting error:', error);
    let errorMessage;
    if (error.userFacing) {
      // One of the specific, deliberately-written messages above (bad
      // JSON shape, missing fields, too-long-for-one-pass) — these were
      // being thrown away and replaced with a generic "try again in a
      // moment" below, which is exactly why the admin only ever saw an
      // unhelpful failure with no indication of what actually went wrong
      // or what to do about it. Forward these as-is; they're already safe,
      // written-for-humans text, not a raw provider error.
      errorMessage = error.message;
    } else if (error.name === 'AbortError' || (error.message && /timeout|timed out/i.test(error.message))) {
      errorMessage = 'We are unable to refine this job posting right now. The AI took too long. Please try again, or paste a shorter posting.';
    } else {
      // Never forward the raw provider error to the client — see the same
      // reasoning documented in generate-letter.js / smart-finder.js.
      errorMessage = 'We are unable to refine this job posting right now. Please try again in a moment.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};