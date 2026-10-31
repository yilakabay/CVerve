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

// ── Cloudflare "Email Address Protection" decoding ────────────────────────
// Sites behind Cloudflare often replace a real mailto link with
// <a href="/cdn-cgi/l/email-protection#HEX" class="__cf_email__" data-cfemail="HEX">[email&#160;protected]</a>
// and decode it client-side with a tiny JS snippet Cloudflare injects. Our
// scraper does a plain HTTP GET with no JS execution, so without this step
// the real address is lost and only the literal fallback text
// "[email protected]" survives tag-stripping — which is exactly what the
// admin was seeing and what the AI was passing straight through as if it
// were a real value. Cloudflare's encoding is a simple, well-documented
// single-byte XOR (first hex byte is the key), so we can recover the real
// address ourselves instead of asking the admin to re-type it by hand.
function decodeCfEmail(hex) {
  const key = parseInt(hex.substr(0, 2), 16);
  let email = '';
  for (let i = 2; i < hex.length; i += 2) {
    email += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
  }
  return email;
}

function decodeCloudflareEmails(html) {
  // Collect every data-cfemail="HEX" value in document order, decode each.
  const decoded = [];
  html.replace(/data-cfemail="([a-f0-9]+)"/gi, (match, hex) => {
    try { decoded.push(decodeCfEmail(hex)); } catch { /* ignore malformed hex */ }
    return match;
  });
  if (!decoded.length) return html;
  // The visible fallback text Cloudflare renders for each protected address
  // is literally "[email protected]" (sometimes with &#160;/&nbsp; as the
  // space). Swap each occurrence, in the same order, for its decoded email —
  // correct for the overwhelmingly common case of one protected address per
  // posting, and still an improvement (first address recovered) if there
  // happen to be more than one.
  let i = 0;
  return html.replace(/\[email(?:&#160;|&nbsp;|\s)*protected\]/gi, () => decoded[i++] || '[email protected]');
}

// Matches the literal Cloudflare fallback text if it somehow survives (e.g.
// a non-Cloudflare obfuscator using the same wording, or a decode we
// couldn't perform) so we never let it reach the admin looking like a real
// extracted value.
const CF_EMAIL_PLACEHOLDER_RE = /\[email(?:&#160;|&nbsp;|\s)*protected\]/gi;

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
  // 2026-10-30: observed in production logs that a single structuring pass
  // can legitimately need the AI ~19-20s to finish on a large/complex
  // posting, which was eating the entire old 20000ms budget and aborting
  // right as the response was about to land (request logged at 20.97s
  // total, function at 20.36s, ending in exactly this timeout). Raised to
  // 24000ms — still with a real margin below the ~26-30s hard ceiling for
  // Lambda overhead + JSON serialization + response — to give genuinely
  // slow (not broken) postings a real chance to finish instead of being
  // cut off right at the finish line.
  const handlerStarted = Date.now();
  const HANDLER_DEADLINE_MS = 24000;
  const MIN_TIME_FOR_RETRY_MS = 6000; // a second AI pass needs a real chance to finish, not a token gesture
  function timeLeft() { return HANDLER_DEADLINE_MS - (Date.now() - handlerStarted); }

  try {
    // ── Resolve raw text ───────────────────────────────────────────────────
    let rawText = jdText || '';

    if (jdUrl && (!jdText || jdText.trim().length < 20)) {
      try {
        const rawHtml = await fetchUrl(jdUrl);
        rawText = htmlToText(decodeCloudflareEmails(rawHtml));
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

    // 2026-10-31: the real lever on how long the AI call takes isn't maxTokens
    // (that's a cap on output, not a speed control — the model only runs as
    // long as the content actually needs) — it's how much source text and how
    // much generated detail we're asking for per call. A 50000-char input
    // (scraped pages often carry a LOT of boilerplate: nav, footer, unrelated
    // postings) was routinely pushing single calls past the real ~20s ceiling
    // that had just been raised to 24s. Tightened to 20000 chars, which is
    // still generous for any single posting (or a small handful), to keep
    // calls comfortably inside the time budget instead of riding the edge of
    // it every time.
    const MAX_TEXT_LENGTH = 20000;
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
          // Lowered from 8000: this isn't a speed control on its own (the
          // model only runs as long as the content needs), but a lower cap
          // means a genuinely oversized multi-position posting hits the
          // length limit — and the already-handled "please split this up"
          // message — well before it can eat the whole time budget, instead
          // of generating for 20+ seconds before we even notice it's too big.
          maxTokens: 4000,
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

    // Safety defaults in case the AI omits the newer application-method fields,
    // plus a sanitize pass: if the source page used Cloudflare's email
    // protection and our decode above couldn't recover it (different
    // obfuscator, malformed hex, etc.), the literal placeholder text
    // "[email protected]" can still show up in applicationUrl or the
    // description fields. Never let that reach the admin as if it were a
    // real value — blank applicationUrl and raise applicationUrlNeedsReview
    // so admin.html can prompt for a manually-typed email instead, and strip
    // the placeholder out of the prose fields so end users never see it.
    structured.positions = structured.positions.map(p => {
      let applicationUrl = p.applicationUrl || '';
      let needsReview = false;
      CF_EMAIL_PLACEHOLDER_RE.lastIndex = 0; // shared /g regex: reset before each .test() to avoid lastIndex leaking across positions
      if (CF_EMAIL_PLACEHOLDER_RE.test(applicationUrl)) {
        applicationUrl = '';
        needsReview = true;
      }
      const stripPlaceholder = (text) => (text || '').replace(CF_EMAIL_PLACEHOLDER_RE, '(email protected on source site — see application instructions)');
      return {
        ...p,
        applicationType:  (p.applicationType === 'physical') ? 'physical' : 'online',
        applicationUrl,
        applicationUrlNeedsReview: needsReview,
        physicalAddress:  p.physicalAddress || '',
        fullDescription:  stripPlaceholder(p.fullDescription),
        shortDescription: stripPlaceholder(p.shortDescription)
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