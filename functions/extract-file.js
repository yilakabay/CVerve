// functions/extract-file.js
//
// POST body: { userId, sessionToken, base64, mediaType }
//
// Reads the text of ONE image (or ONE page of a scanned PDF that cv.html has
// already drawn to a JPEG) using Gemini 3 Flash (via the B.AI gateway), and
// returns it.
//
// ── NETLIFY FREE PLAN TIME LIMIT ──────────────────────────────────────────
// Netlify's free plan runs synchronous Functions with a HARD 10-second
// execution ceiling (the longer 26s limit is Pro-only). The budgets below
// used to total 22s, which meant Netlify itself was killing this function
// with a raw 502/504 well before any of the code's own "ran out of time"
// or retry logic ever got a chance to run — that's what was showing up as
// "extraction fails" with no clean error message.
//
// All budgets below are now sized to fit inside 10s, including: JSON parse,
// DB connect + authenticate() (can be slow on a cold Lambda/Mongo
// connection), the Gemini vision call itself, and a possible one retry.
// If you move this function to a paid Netlify plan with a longer timeout,
// you can raise TOTAL_BUDGET_MS and FIRST_ATTEMPT_MS back up — bigger/denser
// images and a full retry attempt both genuinely do better with more room.
//
// ── WHY THIS FUNCTION EXISTS ─────────────────────────────────────────────
// cv-chat.js used to read every attached file itself, one after another,
// inside the SAME function call that then also had to run the whole chat
// loop. A few images (or a scanned PDF) could use up the time budget, and if
// the function was killed the user lost the whole turn.
//
// Now cv.html calls this function once per image / scanned page (2 at a time)
// BEFORE it calls cv-chat. So:
//   - every image / page gets its OWN full time limit,
//   - a slow or failed file never takes the chat down with it,
//   - text that was read successfully stays in the browser, so a Retry only
//     reads what is still missing (nothing is ever read twice).
//
// ── RETRY ────────────────────────────────────────────────────────────────
// One automatic retry, ONLY for problems that usually go away by themselves
// (HTTP 429 / 5xx / a timeout / a network error) and ONLY if enough time is
// left. Other errors (for example HTTP 400) would fail the same way again,
// so they are reported straight away. Given the free-plan ceiling, there is
// usually only room for a short retry, not a full second attempt — the code
// below always re-checks how much time is actually left rather than
// assuming a fixed retry budget exists.
//
// ── RESPONSE ─────────────────────────────────────────────────────────────
//   success:  200 { success:true, text, usage, tokensUsed, tokenBalance }
//   failure:  200 { success:false, reason, retryable, error, tokenBalance? }
//   auth/billing: errorResponse() — same shape as cv-chat.js / extract-text.js
//
// ── BILLING ──────────────────────────────────────────────────────────────
// This is the CV-chat document-extraction path (certificates, transcripts,
// etc. the user attaches in the chat), which — unlike payment-screenshot or
// CV-upload-to-storage extraction — is NOT free: every extraction here
// deducts real CT, per the standard rule: don't even ask the AI to spend a
// token at 0 balance, but if the user has at least 1 CT, make the call —
// just don't deliver the text unless the balance actually covers the whole
// real cost. Deduction is always floored, never rounded, via deductTokens().

const {
  getDb, authenticate, errorResponse,
  assertCanStart, assertCanDeliver,
  callAI, deductTokens,
  FEATURE_MODELS
} = require('./lib/ai-billing');

// Same dev gate as cv-chat.js — only this account may use the CV feature for now.
const CV_DEV_ALLOWED_USER_ID = '0985576139';

// ── Time budget (milliseconds) — MUST fit inside Netlify's free-plan 10s cap ──
// TOTAL_BUDGET_MS is measured from the very start of the handler (before
// auth), so DB/auth time is automatically taken out of what's left for the
// Gemini call. Keep a safety margin below 10000 for cold starts, network
// jitter, and the time this function itself needs to parse/serialize JSON.
const TOTAL_BUDGET_MS  = 9000;  // whole call, including auth — stay under Netlify's 10s free-plan ceiling
const FIRST_ATTEMPT_MS = 6500;  // longest the first Gemini call may take
const MIN_RETRY_MS     = 1800;  // don't start a retry with less time than this
const RETRY_PAUSE_MS   = 300;   // short — there usually isn't much time to spare

const MAX_BASE64_CHARS = 4.5 * 1024 * 1024; // one file per call, so this stays well under the ~6 MB request limit

const EXTRACT_PROMPT = 'Extract all readable text from this document/image (certificate, transcript, CV, ID, etc). Reply with the plain extracted text only — no commentary, no markdown formatting, no summary. If it is a certificate or award, include the recipient name, the title/subject, the issuing body, and any date exactly as written. TRANSCRIBE LITERALLY: this applies above all to names of people, schools, and organizations. Do not "clean up", autocorrect, or substitute a name for a more common/familiar-looking one, even if a word looks unusual or you suspect it is probably a well-known name spelled differently. Copy exactly the characters you can make out. If part of a word or name is genuinely illegible, write it as-is with [?] immediately after the unclear part rather than guessing a plausible replacement — never silently swap in a different, more common name.';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Problems that usually go away by themselves (rate limit, server error,
// timeout) vs. ones that would just fail the same way again. Matches exactly
// what callAI() itself throws: a plain AbortError on timeout, or an Error
// with .retryable set true/false on an HTTP error (see ai-billing.js).
function isTransientError(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return true; // timed out
  return e.retryable === true;
}

// One Gemini vision call via the B.AI gateway. attempts:1 — this function's
// own loop below is what handles retries, with its own Netlify-safe time
// budget; callAI is deliberately told not to retry on top of that.
// Returns { text, usage, cost } — cost is already computed by callAI()
// using MODEL_RATES, so there's no need to call costFromUsage() again.
async function visionRead(base64, mime, timeoutMs) {
  const r = await callAI({
    model: FEATURE_MODELS.CV_EXTRACTION, // Gemini 3 Flash
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: EXTRACT_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }],
    maxTokens: 1500,
    timeoutMs,
    attempts: 1
  });
  return { text: String((r && r.text) || '').trim(), usage: r && r.usage, cost: r && r.cost };
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const started = Date.now();

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!process.env.BAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'BAI_API_KEY is not configured on the server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userId, sessionToken, base64, mediaType } = body;

  // Real enforcement of the dev gate — see cv-chat.js.
  if (userId !== CV_DEV_ALLOWED_USER_ID) {
    return { statusCode: 403, body: JSON.stringify({ error: 'CV Builder is not available yet.' }) };
  }

  // Log in, then check the balance BEFORE spending anything on a Gemini call.
  let db, user, balance;
  try {
    db = await getDb();
    user = await authenticate(db, userId, sessionToken);
    balance = assertCanStart(user); // balance must be > 0 — don't even ask Gemini to spend a token at 0
  } catch (e) {
    return errorResponse(e, 'Something went wrong. Please try again.');
  }

  if (!base64 || typeof base64 !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'No image was sent.' }) };
  }
  const mime = String(mediaType || 'image/jpeg');
  if (!mime.startsWith('image/')) {
    return { statusCode: 200, body: JSON.stringify({ success: false, reason: 'Unsupported file type', retryable: false, error: 'Only images can be read by this function.' }) };
  }
  if (base64.length > MAX_BASE64_CHARS) {
    return { statusCode: 200, body: JSON.stringify({ success: false, reason: 'Too large', retryable: false, error: 'This image is too large to read.' }) };
  }

  // If auth/DB already ate most of the budget (cold start, slow Mongo
  // connection), there may not be enough time left to even attempt a
  // Gemini call safely. Fail fast with a clean, retryable error instead
  // of starting a fetch that Netlify will kill mid-flight.
  const afterAuthLeft = TOTAL_BUDGET_MS - (Date.now() - started);
  if (afterAuthLeft < 2500) {
    return { statusCode: 200, body: JSON.stringify({ success: false, reason: 'Service busy — press Retry', retryable: true, error: 'Not enough time left in this request after logging in.' }) };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (attempt > 0 && left < MIN_RETRY_MS) break;
    const timeoutMs = attempt === 0 ? Math.min(FIRST_ATTEMPT_MS, left) : left;
    try {
      const r = await visionRead(base64, mime, timeoutMs);
      const cost = r.cost || 0; // already computed by callAI() via MODEL_RATES, already floored

      // Even with balance > 0 at the start, don't hand back the text unless
      // the balance actually covers the whole real price — if not, this is
      // a clean 402 (same shape as every other AI endpoint), nothing charged.
      try {
        assertCanDeliver(balance, cost);
      } catch (e) {
        return errorResponse(e, "You don't have enough CT to cover this extraction. Please top up.");
      }

      const newBalance = await deductTokens(db, userId, cost, {
        feature: 'CV_EXTRACTION',
        model: FEATURE_MODELS.CV_EXTRACTION,
        promptTokens:     r.usage && r.usage.prompt_tokens,
        completionTokens: r.usage && r.usage.completion_tokens
      });
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          text: r.text,
          usage: r.usage,
          tokensUsed: cost,
          tokenBalance: newBalance
        })
      };
    } catch (e) {
      lastErr = e;
      console.error(`extract-file attempt ${attempt + 1} failed:`, e.message);
      if (!isTransientError(e)) break; // would fail the same way again
      if (attempt === 0) await sleep(RETRY_PAUSE_MS);
    }
  }

  // Tell the user the truth: a busy service is not the same as a bad file.
  if (lastErr && isTransientError(lastErr)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, reason: 'Service busy — press Retry', retryable: true, error: lastErr.message }) };
  }
  return { statusCode: 200, body: JSON.stringify({ success: false, reason: "Couldn't be read", retryable: false, error: lastErr ? lastErr.message : 'Unknown error' }) };
};