// functions/lib/ai-billing.js
//
// Everything about "call an AI model through the B.AI gateway and charge the
// user for the real tokens it used" lives here, so generate-letter /
// fit-check / smart-finder / cv-chat / extract-text / extract-file all
// behave the same way and can't drift apart.
//
// ── HOW BILLING WORKS ────────────────────────────────────────────────────
// 1. The user's phone number + sessionToken are checked (see lib/session.js —
//    sessionToken is issued at login by verify-otp.js or telegram-auth.js and
//    replaces password as the "prove it's you" credential everywhere in the
//    app). No valid session = no AI.
// 2. BEFORE calling the AI we only check that the user's balance is above
//    zero. We do NOT require the balance to cover a full estimate up front —
//    per product rule, a user with even 1 CT is allowed to trigger a request.
//    If balance is exactly 0, we refuse immediately and never call the AI,
//    so we never spend real money on a user who can't pay anything.
// 3. We call the model via the B.AI gateway. Its reply contains a `usage`
//    object with the REAL number of input/output tokens used.
// 4. We convert that usage into CT using THAT MODEL's own input/output
//    rates (see MODEL_IDS below), and FLOOR the result (13569.34 -> 13569,
//    never rounded).
// 5. If the user's balance does not fully cover that real cost, we DO NOT
//    hand them the answer and we DO NOT charge them — we throw an
//    INSUFFICIENT_TOKENS error so the app shows the Top Up prompt. The
//    answer the model produced is simply discarded.
// 6. If the balance does cover it, we deduct exactly that many CT (never
//    below zero) and write a line to the `token_usage` collection, then
//    return the answer + new balance to the app.
//
// Only a SUCCESSFUL, AFFORDABLE answer that we actually hand to the user is
// charged. If the gateway errors out, or the user can't afford the real
// cost, nothing is charged for that attempt.
//
// ── FREE FEATURES ─────────────────────────────────────────────────────────
// Payment-screenshot extraction and CV-upload-to-storage extraction are free
// (pass `free: true` to runBilledChat / runBilledVision). Every other
// extraction done inside the CV chat still gets billed normally.

const { MongoClient } = require('mongodb');
const { checkSession } = require('./session');

// ── B.AI gateway config ────────────────────────────────────────────────────
// Confirmed against b.ai's own curl sample on 2026-10-15.
const BAI_BASE_URL = process.env.BAI_BASE_URL || 'https://api.b.ai/v1';
const BAI_CHAT_URL = `${BAI_BASE_URL}/chat/completions`;

// Confirmed exact model ID strings from the b.ai docs on 2026-10-15.
// Note: DeepSeek Pro has NO ".1" in its id — only the Flash variant does.
const MODEL_IDS = {
  DEEPSEEK_FLASH: 'DeepSeek-V4.1-Flash',
  DEEPSEEK_PRO:   'deepseek-v4-pro',
  GEMINI_FLASH:   'gemini-3-flash-preview',
  CLAUDE_SONNET:  'claude-sonnet-5.5'
};

// CT per 1000 tokens, input/output, per model. Taken straight from the
// pricing table given on 2026-10-14. Update here only — everything else
// (cost calc, deduction) adapts automatically.
const MODEL_RATES = {
  [MODEL_IDS.DEEPSEEK_FLASH]: { inputPer1000: 1,    outputPer1000: 4    },
  [MODEL_IDS.GEMINI_FLASH]:   { inputPer1000: 1.67, outputPer1000: 10   },
  [MODEL_IDS.DEEPSEEK_PRO]:   { inputPer1000: 1.45, outputPer1000: 2.9  },
  [MODEL_IDS.CLAUDE_SONNET]:  { inputPer1000: 10,   outputPer1000: 50   }
};

// Which logical model each feature uses. Change the mapping here if a
// feature should move to a different model later.
const FEATURE_MODELS = {
  LETTER_EXTRACTION:   MODEL_IDS.GEMINI_FLASH,   // Application Letter: text extraction
  LETTER_GENERATION:   MODEL_IDS.CLAUDE_SONNET,  // Application Letter: final output
  CV_CHAT:             MODEL_IDS.DEEPSEEK_PRO,   // CV Builder: chat interface / data structuring
  CV_EXTRACTION:       MODEL_IDS.GEMINI_FLASH,   // CV Builder: certificates/education doc extraction
  CV_POLISH:           MODEL_IDS.CLAUDE_SONNET,  // CV Builder: final human polish
  SMART_FINDER:        MODEL_IDS.DEEPSEEK_FLASH, // Smart Finder
  FIT_CHECK:           MODEL_IDS.DEEPSEEK_PRO,   // Fit Check
  GENERIC_EXTRACTION:  MODEL_IDS.GEMINI_FLASH    // payment screenshots, CV uploads, any other doc extraction
};

// ── Mongo (shared by every AI function that requires this file) ───────────
const mongo = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });
async function getDb() {
  await mongo.connect();
  return mongo.db('cverve');
}

// ── Error type carrying a safe, user-facing message + HTTP status ─────────
class AIError extends Error {
  constructor(status, publicMessage, extra) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.extra = extra || {};
  }
}

// Turns any thrown error into a Netlify response. Provider/internal error
// text is only ever logged, never sent to the browser.
function errorResponse(err, fallbackMessage) {
  if (err instanceof AIError) {
    return { statusCode: err.status, body: JSON.stringify({ error: err.publicMessage, ...err.extra }) };
  }
  console.error('AI function error:', err);
  return {
    statusCode: 500,
    body: JSON.stringify({ error: fallbackMessage || 'We are unable to complete your request right now. Please try again in a moment.' })
  };
}

// ── Authenticate ──────────────────────────────────────────────────────────
// sessionToken replaces password as the "prove it's you" credential — issued
// at login (verify-otp.js for web, telegram-auth.js for Telegram) and sent
// back on every request exactly where password used to go. See lib/session.js.
async function authenticate(db, userId, sessionToken) {
  if (!userId || !sessionToken) {
    throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  }
  const user = await db.collection('users').findOne({ phoneNumber: userId });
  if (!user) throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  if (!checkSession(user, sessionToken)) {
    throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  }
  return user;
}

// ── Balance gate BEFORE calling the AI ─────────────────────────────────────
// Rule: if balance is 0, refuse immediately — never spend real money calling
// the AI for a user who cannot pay anything at all. Any balance above 0 is
// allowed to trigger a request; whether the request's actual cost is
// affordable is checked AFTER we know the real cost (assertCanDeliver below).
function assertCanStart(user) {
  const balance = Math.max(0, Number(user.tokens) || 0);
  if (balance <= 0) {
    throw new AIError(402,
      'You\'re out of CT. Please top up to continue.',
      { code: 'INSUFFICIENT_TOKENS', tokenBalance: 0, topUp: true }
    );
  }
  return balance;
}

// ── Balance gate AFTER we know the real cost, BEFORE handing back the answer ─
// Rule: the user must have enough to cover the WHOLE real cost. If not, the
// answer is discarded, nothing is charged, and the app shows Top Up.
function assertCanDeliver(balance, cost) {
  if (balance < cost) {
    throw new AIError(402,
      'Your balance isn\'t enough to cover this request. Please top up to continue.',
      { code: 'INSUFFICIENT_TOKENS', tokenBalance: balance, required: cost, topUp: true }
    );
  }
}

// ── CT cost of one AI response, using that model's own rates ──────────────
function costFromUsage(model, usage) {
  if (!usage) return 0;
  const rates = MODEL_RATES[model];
  if (!rates) {
    console.error(`No CT rate configured for model "${model}" — charging 0. Fix MODEL_RATES.`);
    return 0;
  }
  const promptTokens     = Number(usage.prompt_tokens)     || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const rawCost =
    (promptTokens     / 1000) * rates.inputPer1000 +
    (completionTokens / 1000) * rates.outputPer1000;
  // Never charge a fraction of a CT — always round DOWN.
  return Math.floor(rawCost);
}

// ── Call the B.AI gateway (OpenAI-compatible) with safe retries ───────────
// `messages` can include vision content (image_url parts) for extraction.
// Returns { message, text, usage, cost }. `usage` is the gateway's real numbers.
//
// `timeoutMs` is a TOTAL budget for this whole call, across every attempt —
// not a per-attempt allowance. Callers (cv-chat.mjs above all) work out
// timeoutMs as "this is all the wall-clock time I can safely give you before
// my own deadline", so a retry that restarted the clock at the full
// timeoutMs again could silently use up to attempts × timeoutMs — e.g. with
// attempts:2 and a 40s budget, a genuinely slow-but-not-erroring first
// attempt could abort at 40s and then get a FULL second 40s attempt, total
// ~80s, blowing straight through Netlify's real 60s execution ceiling with
// nothing ever sent back to the client (the exact "connection was
// interrupted" symptom, worse the bigger the conversation/context gets).
// Each attempt below now only gets whatever is actually left of the total
// budget, so the whole call can never run longer than timeoutMs promised.
async function callAI({ model, messages, maxTokens, temperature, json, tools, toolChoice, timeoutMs, attempts }) {
  const apiKey = process.env.BAI_API_KEY;
  if (!apiKey) throw new Error('BAI_API_KEY is not configured on the server.');
  if (!model) throw new Error('callAI requires a model id (use MODEL_IDS / FEATURE_MODELS).');

  const maxAttempts = attempts || 3;
  const totalBudgetMs = timeoutMs || 25000;
  const started = Date.now();
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (attempt > 1 && remaining < 1000) break; // not enough of the total budget left for another real attempt
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, remaining));
    try {
      const payload = {
        model,
        messages,
        max_tokens: maxTokens || 1500
      };
      if (typeof temperature === 'number') payload.temperature = temperature;
      if (json) payload.response_format = { type: 'json_object' };
      if (tools) { payload.tools = tools; payload.tool_choice = toolChoice || 'auto'; }

      const res = await fetch(BAI_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      let data = null;
      try { data = await res.json(); } catch (_) {}

      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `B.AI gateway HTTP ${res.status}`;
        const err = new Error(msg);
        err.retryable = [429, 500, 502, 503, 504].includes(res.status);
        throw err;
      }

      const choice  = data && data.choices && data.choices[0];
      const message = choice && choice.message;
      if (!message) throw Object.assign(new Error('B.AI gateway returned an empty response'), { retryable: true });

      const usage = data.usage || null;
      return { message, text: (message.content || '').trim(), usage, cost: costFromUsage(model, usage) };

    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err && err.name === 'AbortError';
      const retryable = isAbort || err.retryable === true || (err.cause && err.cause.code);
      console.error(`B.AI gateway attempt ${attempt}/${maxAttempts} (${model}) failed:`, err.message);
      // Don't start another attempt if we've already used up the time budget —
      // the remaining-budget check at the top of the loop (next iteration)
      // now handles this correctly for any timeoutMs, so there's no need for
      // a hardcoded cutoff here any more (a fixed 16s used to cut retries
      // short on long-budget callers like the main chat loop, and could in
      // principle let a short-budget caller retry past what it asked for).
      if (!retryable || attempt === maxAttempts) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ── Deduct CT (atomic, never below zero, already floored) and log it ──────
async function deductTokens(db, userId, amount, meta) {
  const charge = Math.max(0, Math.floor(amount));
  if (charge === 0) {
    const u = await db.collection('users').findOne({ phoneNumber: userId }, { projection: { tokens: 1 } });
    return Math.max(0, Number(u && u.tokens) || 0);
  }

  const res = await db.collection('users').findOneAndUpdate(
    { phoneNumber: userId },
    [{
      $set: {
        tokens:       { $max: [0, { $subtract: [{ $ifNull: ['$tokens', 0] }, charge] }] },
        lastActiveAt: new Date()
      }
    }],
    { returnDocument: 'after' }
  );
  // Works with both driver 5.x (returns { value }) and 6.x (returns the doc).
  const doc = (res && Object.prototype.hasOwnProperty.call(res, 'value')) ? res.value : res;
  const balanceAfter = Math.max(0, Number(doc && doc.tokens) || 0);

  try {
    await db.collection('token_usage').insertOne({
      userId,
      feature:          (meta && meta.feature) || 'unknown',
      model:             meta && meta.model,
      promptTokens:     (meta && meta.promptTokens)     || 0,
      completionTokens: (meta && meta.completionTokens) || 0,
      charged:          charge,
      balanceAfter,
      createdAt:        new Date()
    });
  } catch (e) {
    console.error('token_usage log failed (non-fatal):', e.message);
  }
  return balanceAfter;
}

// ── The one-call helper for simple "ask once, get one answer" features ────
//   feature     — a key from FEATURE_MODELS (picks the model + its rates).
//   free        — true for payment-screenshot extraction / CV-upload-to-storage
//                 extraction: the AI is still called, but nothing is charged.
//   validate(text) — optional. Return the parsed value, or throw if the answer
//                 is unusable. An unusable answer is retried once and NOT charged.
//   preAuth     — optional { db, user } if the caller already authenticated.
async function runBilledChat({ userId, sessionToken, feature, messages, maxTokens, temperature, json, validate, free, preAuth }) {
  const model = FEATURE_MODELS[feature];
  if (!model) throw new Error(`Unknown feature "${feature}" — add it to FEATURE_MODELS.`);

  const db   = preAuth ? preAuth.db   : await getDb();
  const user = preAuth ? preAuth.user : await authenticate(db, userId, sessionToken);

  // Balance must be above 0 to even attempt the call — unless this is a free feature.
  const balance = free ? Infinity : assertCanStart(user);

  let result, parsed, lastErr;
  for (let pass = 1; pass <= 2; pass++) {
    try {
      result = await callAI({ model, messages, maxTokens, temperature, json });
      parsed = validate ? validate(result.text) : result.text;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`${feature}: attempt pass ${pass} unusable/failed:`, err.message);
      if (err.retryable === false) break;
    }
  }
  if (lastErr) throw lastErr;

  if (free) {
    return { text: result.text, parsed, tokensUsed: 0, tokenBalance: Math.max(0, Number(user.tokens) || 0) };
  }

  // The user must be able to cover the REAL cost — if not, discard the
  // answer and never charge for it.
  assertCanDeliver(balance, result.cost);

  const tokenBalance = await deductTokens(db, userId, result.cost, {
    feature,
    model,
    promptTokens:     result.usage && result.usage.prompt_tokens,
    completionTokens: result.usage && result.usage.completion_tokens
  });

  return { text: result.text, parsed, tokensUsed: result.cost, tokenBalance };
}

// Strip ``` fences some models add, then parse JSON.
function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = {
  AIError, errorResponse,
  getDb, authenticate,
  assertCanStart, assertCanDeliver,
  callAI, deductTokens, costFromUsage,
  runBilledChat, parseJsonLoose,
  MODEL_IDS, MODEL_RATES, FEATURE_MODELS
};