// functions/extract-file.js
//
// POST body: { userId, sessionToken, base64, mediaType }
//
// Reads the text of ONE image (or ONE page of a scanned PDF that cv.html has
// already drawn to a JPEG) using Gemini 3 Flash (via the B.AI gateway), and
// returns it.
//
// ── NETLIFY SYNCHRONOUS FUNCTION TIME LIMIT ───────────────────────────────
// Netlify's synchronous Functions have a hard 60-second execution ceiling
// (this is a platform-wide limit, not tied to plan). The budgets below used
// to be sized for an inaccurate "10-second free-plan cap" — 9s total, 6.5s
// for the first Gemini call — which meant THIS CODE was aborting its own
// vision call and giving up well before Netlify would ever have killed it.
// Dense scanned documents (certificates, transcripts, multi-page education
// records) routinely need more than 6.5s for Gemini to read, so this was
// silently failing real, legitimate extractions and showing up to users as
// "fails after a long wait" (many pages retried, every one cut short).
//
// All budgets below are now sized to fit inside the real 60s ceiling, with
// a safety margin for cold starts, network jitter, and this function's own
// JSON parse/serialize time. The client (cv.html) already allows 30s per
// attempt per call, so there was always room on that side — the ceiling was
// coming entirely from these numbers.
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

// ── Time budget (milliseconds) — MUST fit inside Netlify's real 60s sync cap ──
// TOTAL_BUDGET_MS is measured from the very start of the handler (before
// auth), so DB/auth time is automatically taken out of what's left for the
// Gemini call. Keep a safety margin below 60000 for cold starts, network
// jitter, and the time this function itself needs to parse/serialize JSON.
const TOTAL_BUDGET_MS  = 50000; // whole call, including auth — stay under Netlify's real 60s sync ceiling
const FIRST_ATTEMPT_MS = 35000; // longest the first Gemini call may take — dense scans genuinely need this
const MIN_RETRY_MS     = 5000;  // don't start a retry with less time than this
const RETRY_PAUSE_MS   = 400;   // short — there usually isn't much time to spare

const MAX_BASE64_CHARS = 4.5 * 1024 * 1024; // one file per call, so this stays well under the ~6 MB request limit

const EXTRACT_PROMPT = 'Extract EVERY piece of readable text from this document/image (certificate, transcript, CV, ID, etc), from top to bottom — not just the header, letterhead, logo text, or contact details at the top of the page. Certificates in particular usually have their MOST IMPORTANT content in a central body paragraph, often set in italic or cursive script (e.g. "This is to certify that [name] has graduated from [institution] with a [degree] in [field] on [date] with a GPA/score of [X]"). That certifying paragraph — including the exact degree, field of study, GPA/score, and dates — is the main point of the document and must be transcribed in full, in addition to the letterhead, any registrar/office stamps or seals, and the signature block. Do not stop after the header/logo area; read all the way down the page, including italicized or decorative text, before replying. IMPORTANT — orientation: this image may be scanned or photographed SIDEWAYS or UPSIDE DOWN (a whole page rotated 90, 180, or 270 degrees, not just slanted). If so, mentally rotate the page to figure out the correct reading direction and transcribe ALL of the text as if it were upright — do not skip, give up on, or only partially read text just because the page itself is rotated; rotated text is just as important as upright text. Reply with the plain extracted text only — no commentary, no markdown formatting, no summary. TRANSCRIBE LITERALLY: this applies above all to names of people, schools, and organizations. Do not "clean up", autocorrect, or substitute a name for a more common/familiar-looking one, even if a word looks unusual or you suspect it is probably a well-known name spelled differently. Copy exactly the characters you can make out. If part of a word or name is genuinely illegible, write it as-is with [?] immediately after the unclear part rather than guessing a plausible replacement — never silently swap in a different, more common name.';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Catching a "letterhead-only" read before it ever reaches the user ────
// Rotation handling was added to EXTRACT_PROMPT (see above) so the model is
// TOLD to mentally rotate a sideways/upside-down page — but in practice a
// 90°-rotated page combined with small, decorative/italic body text (very
// common on certificates) can still make the model stop after the easy,
// upright part (the letterhead/logo/stamp) and give up on the harder,
// rotated main paragraph, even with that instruction. Relying on the prompt
// alone wasn't enough — the fix needs to catch the weak result and actually
// look again, not just ask more firmly the first time.
//
// A genuine certificate/transcript/ID page essentially always has more text
// than just a letterhead once you include the body paragraph, stamps, and
// signature block — so a suspiciously short result is a good, cheap signal
// that something was missed. When that happens and there's still time left
// in the budget, take one more look with a prompt that names the likely
// failure directly (it is very likely a reading that missed a rotated body
// paragraph), rather than a generic re-ask — and keep whichever reading of
// the two actually came back longer/more complete.
//
// Length alone isn't a reliable enough signal, though: a university letter-
// head with a registrar/directorate name, phone, fax, PO box, and website
// can easily run well past a couple hundred characters ALL BY ITSELF, with
// zero actual document content — that's exactly what slipped through here
// (a pure letterhead read at ~180 characters cleared a 140-char floor with
// room to spare). So also check directly for the shape of the problem: text
// that is heavy on letterhead/contact markers (Tel:, Fax:, PO box,
// "Directorate", "Registrar", a website) but has none of the markers that
// show actual document content came through (certify, graduated, degree,
// GPA, a date, "this is to", etc.) is still an incomplete read, regardless
// of how long the letterhead itself happens to be.
const MIN_EXPECTED_CHARS = 140;
const LETTERHEAD_MARKERS = /\b(tel|fax|p\.?\s?o\.?\s?box|website|directorate|registrar|alumni)\b/i;
const CONTENT_MARKERS = /\b(certif|graduat|awarded|diploma|transcript|gpa|degree in|hereby|examination|cumulative|cgpa|has (?:been|graduated)|this is to)\b/i;
function looksIncomplete(text) {
  const t = (text || '').trim();
  if (t.length < MIN_EXPECTED_CHARS) return true;
  if (LETTERHEAD_MARKERS.test(t) && !CONTENT_MARKERS.test(t)) return true;
  return false;
}

const SECOND_PASS_PROMPT = 'Your first reading of this image only came back short — most likely it only captured a letterhead, logo, or stamp and missed the main body of the page. This almost always means the page is rotated 90, 180, or 270 degrees and a paragraph of body text (often in italic or cursive script) running sideways or upside down relative to the letterhead was overlooked entirely, not just misread. Look again, carefully, at the WHOLE image: mentally rotate it in each direction if needed, find any text block you did not transcribe the first time — especially a central certifying/body paragraph — and transcribe it in full this time, in addition to everything you already found (letterhead, stamps/seals, signature block). Reply with the complete plain extracted text only, no commentary.';

async function visionReadSecondPass(base64, mime, timeoutMs) {
  const r = await callAI({
    model: FEATURE_MODELS.CV_EXTRACTION,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: SECOND_PASS_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }],
    maxTokens: 3000,
    timeoutMs,
    attempts: 1
  });
  return { text: String((r && r.text) || '').trim(), usage: r && r.usage, cost: r && r.cost };
}

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
    maxTokens: 3000, // was 1500 — dense certificates (letterhead + full certifying paragraph + stamps + signature block) need more room
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
  if (afterAuthLeft < 5000) {
    return { statusCode: 200, body: JSON.stringify({ success: false, reason: 'Service busy — press Retry', retryable: true, error: 'Not enough time left in this request after logging in.' }) };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (attempt > 0 && left < MIN_RETRY_MS) break;
    const timeoutMs = attempt === 0 ? Math.min(FIRST_ATTEMPT_MS, left) : left;
    try {
      const r = await visionRead(base64, mime, timeoutMs);
      let finalText  = r.text;
      let totalCost  = r.cost || 0;
      let totalUsage = r.usage;

      // Weak-looking first read (very likely a missed, rotated body
      // paragraph — see looksIncomplete's comment) and there's still real
      // time left: take one more, more pointed look before accepting it.
      // Any failure here just falls back to the first (still real) result —
      // never worse than what we already have.
      if (looksIncomplete(r.text)) {
        const leftForSecondPass = TOTAL_BUDGET_MS - (Date.now() - started);
        if (leftForSecondPass > MIN_RETRY_MS) {
          try {
            const r2 = await visionReadSecondPass(base64, mime, Math.min(FIRST_ATTEMPT_MS, leftForSecondPass));
            totalCost += (r2.cost || 0);
            if (r2.usage) {
              totalUsage = {
                prompt_tokens:     ((totalUsage && totalUsage.prompt_tokens)     || 0) + (r2.usage.prompt_tokens     || 0),
                completion_tokens: ((totalUsage && totalUsage.completion_tokens) || 0) + (r2.usage.completion_tokens || 0)
              };
            }
            if (r2.text && r2.text.length > finalText.length) finalText = r2.text;
          } catch (e) {
            console.error('extract-file second-pass (short first read) failed, keeping first result:', e.message);
          }
        }
      }

      // Even with balance > 0 at the start, don't hand back the text unless
      // the balance actually covers the whole real price — if not, this is
      // a clean 402 (same shape as every other AI endpoint), nothing charged.
      try {
        assertCanDeliver(balance, totalCost);
      } catch (e) {
        return errorResponse(e, "You don't have enough CT to cover this extraction. Please top up.");
      }

      const newBalance = await deductTokens(db, userId, totalCost, {
        feature: 'CV_EXTRACTION',
        model: FEATURE_MODELS.CV_EXTRACTION,
        promptTokens:     totalUsage && totalUsage.prompt_tokens,
        completionTokens: totalUsage && totalUsage.completion_tokens
      });
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          text: finalText,
          usage: totalUsage,
          tokensUsed: totalCost,
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