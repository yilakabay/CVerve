// functions/lib/ai-billing.js
//
// Everything about "call DeepSeek and charge the user for the real tokens
// it used" lives here, so generate-letter / fit-check / smart-finder / cv-chat
// all behave the same way and can't drift apart.
//
// ── HOW BILLING WORKS ────────────────────────────────────────────────────
// 1. The user's phone number + password are checked (same bcrypt check the
//    rest of the app uses). No login = no AI.
// 2. Before calling DeepSeek we make sure the user has enough CT for what
//    they're asking (an estimate of the size of the request). If not, the
//    call is NOT made and the app shows the Top Up screen.
// 3. We call DeepSeek. Its reply contains a `usage` object with the REAL
//    number of tokens used (prompt_tokens + completion_tokens).
// 4. We subtract exactly that many CT from the user's balance (never below
//    zero) and write a line to the `token_usage` collection for the record.
// 5. The new balance is sent back to the app so the screen updates live.
//
// Only a SUCCESSFUL answer that we actually hand to the user is charged.
// If DeepSeek errors out, or returns something unusable and we have to
// retry, those failed attempts are on us — the user never pays for them.
//
// ── ONE SETTING YOU MAY WANT TO CHANGE ───────────────────────────────────
// OUTPUT_TOKEN_MULTIPLIER: DeepSeek charges more for the words it WRITES
// than for the words it READS. With 1 (default), 1 CT = 1 real token,
// whether read or written — simple to explain to users. If you find output
// is eating your margin, set this to 2 or 3 and written tokens will cost
// that many CT each. Everything else adapts automatically.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const DEEPSEEK_URL   = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL  = 'deepseek-chat';
const OUTPUT_TOKEN_MULTIPLIER = 1;

// Extra CT a user must have available on top of the estimated size of their
// request before we'll start it (room for the answer itself).
const ANSWER_RESERVE_TOKENS = 500;

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

// ── Token estimate (used ONLY for the "do you have enough CT to start" check;
// the real charge always comes from DeepSeek's own usage numbers). Deliberately
// on the generous side so a user can't start something they can't finish.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3);
}
function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (m.content) total += estimateTokens(JSON.stringify(m.content));
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

// ── Authenticate ──────────────────────────────────────────────────────────
async function authenticate(db, userId, password) {
  if (!userId || !password) {
    throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  }
  const user = await db.collection('users').findOne({ phoneNumber: userId });
  if (!user) throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) throw new AIError(401, 'Your session needs a quick refresh. Please log in again.');
  return user;
}

// ── Make sure the user can afford to START this request ───────────────────
function assertCanAfford(user, estimatedPromptTokens) {
  const balance  = Math.max(0, Number(user.tokens) || 0);
  const required = estimatedPromptTokens + ANSWER_RESERVE_TOKENS;
  if (balance < required) {
    throw new AIError(402,
      'You don\'t have enough CT for this. Please top up to continue.',
      { code: 'INSUFFICIENT_TOKENS', tokenBalance: balance, required }
    );
  }
  return balance;
}

// ── CT cost of one DeepSeek response ──────────────────────────────────────
function costFromUsage(usage) {
  if (!usage) return 0;
  const prompt     = Number(usage.prompt_tokens)     || 0;
  const completion = Number(usage.completion_tokens) || 0;
  return prompt + Math.ceil(completion * OUTPUT_TOKEN_MULTIPLIER);
}

// ── Call DeepSeek (with safe retries on temporary failures) ───────────────
// Returns { message, text, usage, cost }. `usage` is DeepSeek's real numbers.
async function callDeepSeek({ messages, maxTokens, temperature, json, tools, toolChoice, model, timeoutMs, attempts }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured on the server.');

  const maxAttempts = attempts || 3;
  const started = Date.now();
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 22000);
    try {
      const payload = {
        model: model || DEFAULT_MODEL,
        messages,
        max_tokens: maxTokens || 1500
      };
      if (typeof temperature === 'number') payload.temperature = temperature;
      if (json) payload.response_format = { type: 'json_object' };
      if (tools) { payload.tools = tools; payload.tool_choice = toolChoice || 'auto'; }

      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      let data = null;
      try { data = await res.json(); } catch (_) {}

      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `DeepSeek HTTP ${res.status}`;
        const err = new Error(msg);
        err.retryable = [429, 500, 502, 503, 504].includes(res.status);
        throw err;
      }

      const choice  = data && data.choices && data.choices[0];
      const message = choice && choice.message;
      if (!message) throw Object.assign(new Error('DeepSeek returned an empty response'), { retryable: true });

      return { message, text: (message.content || '').trim(), usage: data.usage || null, cost: costFromUsage(data.usage) };

    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err && err.name === 'AbortError';
      const retryable = isAbort || err.retryable === true || (err.cause && err.cause.code);
      console.error(`DeepSeek attempt ${attempt}/${maxAttempts} failed:`, err.message);
      // Don't start another attempt if we've already used a lot of the time budget.
      if (!retryable || attempt === maxAttempts || (Date.now() - started) > 14000) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ── Deduct CT (atomic, never below zero) and log it ───────────────────────
async function deductTokens(db, userId, amount, meta) {
  const charge = Math.max(0, Math.round(amount));
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
//   validate(text) — optional. Return the parsed value, or throw if the answer
//   is unusable. An unusable answer is retried once and NOT charged.
//   preAuth — optional { db, user } if the caller already authenticated (e.g. to
//   protect a URL download that happens BEFORE the AI call), so we don't repeat it.
async function runBilledChat({ userId, password, feature, messages, maxTokens, temperature, json, validate, preAuth }) {
  const db   = preAuth ? preAuth.db   : await getDb();
  const user = preAuth ? preAuth.user : await authenticate(db, userId, password);
  assertCanAfford(user, estimateMessagesTokens(messages));

  let result, parsed, lastErr;
  for (let pass = 1; pass <= 2; pass++) {
    try {
      result = await callDeepSeek({ messages, maxTokens, temperature, json });
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

  const tokenBalance = await deductTokens(db, userId, result.cost, {
    feature,
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
  getDb, authenticate, assertCanAfford,
  estimateTokens, estimateMessagesTokens,
  callDeepSeek, deductTokens, costFromUsage,
  runBilledChat, parseJsonLoose,
  OUTPUT_TOKEN_MULTIPLIER
};