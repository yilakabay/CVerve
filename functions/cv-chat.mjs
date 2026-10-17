// functions/cv-chat.js
//
// POST body: { userId, sessionToken, messages: [...], newUserText?: string,
//              newUserFiles?: [{filename, mediaType, base64}], photoBase64?: string }
//
// This is the backend for "CVcase" — a conversational AI that builds a CV
// with the user, one message at a time. The client keeps the full message
// history and re-sends it every turn (this function is stateless).
//
// ── MODELS (via the B.AI gateway, see lib/ai-billing.js) ─────────────────
//   - Chat interface / data structuring (the main tool-use loop below):
//     DeepSeek V4-Pro (FEATURE_MODELS.CV_CHAT)
//   - Document extraction (certificates/education docs attached mid-chat):
//     Gemini 3 Flash (FEATURE_MODELS.CV_EXTRACTION)
// `lib/ai-billing.js` is the single place that knows each model's real CT
// rate — this file never computes a CT cost itself, it only sums the `.cost`
// each billed call already returns.
//
// ── BILLING (CT tokens) — HOW THIS FILE DIFFERS FROM THE OTHER AI FUNCTIONS ─
// Every other AI function (generate-letter, fit-check, smart-finder) makes
// ONE AI call per request, so it's easy to hold the answer back if the user
// can't afford the real cost once it's known. This file can't do that:
//   - A single turn can involve MULTIPLE AI calls (file extraction, then
//     several tool-loop turns).
//   - finalize_pdf doesn't just return text — it immediately pushes the
//     real, finished PDF to the user's Telegram chat as soon as it's called,
//     before the turn's total cost is known. There is no way to "withhold"
//     a file that has already been delivered.
// So, for this file only: we gate on balance > 0 at the very start of the
// turn (nothing is attempted for a user with exactly 0 CT), then charge
// whatever was genuinely used once the turn ends — the same shape the
// original version of this file already used. If the user's balance runs
// out partway through a turn, later calls within that SAME turn still go
// through (there's no clean way to stop mid tool-loop without breaking the
// conversation), but the next turn will correctly refuse to start at 0.
//
// The body must include `sessionToken` (issued at login by verify-otp.js or
// telegram-auth.js — see lib/session.js; this replaces the old password
// field everywhere in the app). The reply includes `tokensUsed` and
// `tokenBalance` so the app can update the balance on screen.
//
// ── EXECUTION TIME BUDGET — READ THIS FIRST ───────────────────────────────
// This runs as a Netlify Functions 2.0 streaming function (see the
// `export default` wrapper + sseEncode at the bottom of this file), which
// has a 60-second execution ceiling. This function does TWO time-hungry
// things in sequence — (1) a file-extraction fallback step, then (2) a
// tool-use loop that can call the AI gateway up to MAX_TOOL_ITERATIONS
// times, each one a full network round trip — so both steps still need their
// own time budgets to avoid one slow file or a stuck AI call eating the
// whole 60s and leaving the user with no clean error and no guarantee of
// which AI calls had already been billed.
//
// Two mechanisms keep that bounded:
//   1. EXTRACTION_TIME_BUDGET_MS (see below) bounds the old-shape fallback
//      extraction path. In normal operation this path barely runs anyway,
//      because cv.html now reads images/PDFs via extract-file.js BEFORE
//      calling this function — see the "FIX: files are now read BEFORE this
//      function is called" note further down. This budget only matters for
//      that old-shape fallback.
//   2. A single HANDLER_DEADLINE_MS wall-clock budget wraps the WHOLE
//      handler. Before extraction starts, and before every single AI call
//      inside the tool loop, the code checks how much real time is left. If
//      there isn't enough left to safely attempt another call, it stops on
//      its own — charges for whatever was actually used, and returns a
//      normal, clean reply asking the user to send another message to
//      continue — instead of running past the platform's own limit
//      mid-call.
//
// This means even a genuinely complex turn (lots of files + several tool
// calls) almost always finishes within one message now that the real 60s
// budget is used, rather than the overly conservative ~8.5s this used to be
// capped at (a leftover from when this ran as a classic 10s-limited
// function) — that old cap was cutting off real, in-progress AI calls
// (especially slower models like deepseek-v4-pro on a turn with an attached
// document) well before they could finish, which showed up in the logs as
// "AbortError: This operation was aborted".
//
// ── MODEL: OpenAI-compatible tool-calling format ──────────────────────────
// This file uses OpenAI-style messages (role/content, tool_calls, role:'tool'
// results) via the B.AI gateway, which both DeepSeek and Gemini speak through
// that same shape. Two consequences that matter:
//
//   1. Any CV session saved in the browser from before the OpenAI-style
//      switch is in the old format and will not resume correctly — start a
//      fresh session after deploying this.
//
//   2. The main conversation/tool loop (callAI) is TEXT-ONLY — it never
//      receives a raw image or PDF. Uploaded files are converted to text
//      first, in extractDocumentText():
//        - images  → Gemini 3 Flash vision
//        - PDFs    → pdf-parse (text PDFs; the chat model can't take a PDF as input)
//        - scanned PDFs → cv.html detects these with PDF.js, draws the first
//                    pages to images and sends them as file.pages (no PDF);
//                    each page image is then read with Gemini 3 Flash vision
//        - Word (.docx) → mammoth (old .doc is rejected in cv.html)
//      The conversation model then only ever sees that extracted text,
//      labelled with the filename, never the raw file.
//
// ── FIX: files are now read BEFORE this function is called ───────────────
// Reading files used to happen inside this function, one after another,
// sharing one time limit with the whole chat loop — so a few images or a
// scanned PDF could run out of time and the user lost the turn. Now cv.html
// does the reading first:
//   - text PDFs and Word files are read in the browser (PDF.js / mammoth),
//   - images and scanned pages are read one by one by extract-file.js, each
//     with its own timeout and one automatic retry.
// cv.html then sends each file in one of these shapes:
//   { filename, mediaType, extractedText }   → already read, nothing to do here
//   { filename, mediaType, readError, readRetryable }
//                                           → the browser tried and failed; it
//                                             is listed as NOT READ so the user
//                                             gets the Retry box
//   { filename, mediaType, base64 | pages } → old shape; still read here exactly
//                                             as before, as a fallback
// Because of this, this function now only has to run the chat loop, and a
// Retry only re-reads the files that are still missing. In normal operation
// nearly every file arrives already-read (extractedText/readError), so the
// old-shape fallback path below — the one actually bound by
// EXTRACTION_TIME_BUDGET_MS — should rarely execute at all.
//
// ── FEATURE: unread files + "Retry" box ──────────────────────────────────
// When a file can't be read (vision failed, ran out of time, over the
// per-message file limit, too large, no text inside...), three things happen:
//   1. The file is still listed in the conversation with a "[NOT READ: ...]"
//      marker, plus a system note telling the model which files were missed
//      and how to advise the user (continue without them if the info that
//      WAS read is enough, or press Retry if the missing files look key).
//   2. The response includes `unreadFiles: [{index, filename, reason,
//      retryable}]` — `index` is the file's position in newUserFiles.
//   3. cv.html shows a box at the end of the chat listing those files with a
//      Retry button. Retry sends ONLY the retryable files as a new turn on
//      top of the existing conversation, so everything already read is kept
//      and nothing is read twice. If the user just keeps chatting instead,
//      the conversation continues with what was read.
//
// ── WHY A TOOL-USE LOOP, NOT JUST A CHAT ────────────────────────────────
// The model is good at conversation, judgment, and writing — but must
// never "eyeball" whether a block of text fits a fixed-size PDF section.
// So it's given tools that call into REAL code (lib/cv-template-minimal.js)
// for anything that has to be exact:
//
//   check_template_fit(content) → runs the actual PDFKit measurement used
//     by the real renderer and returns real line counts / overflow /
//     underflow numbers, per section. The model must call this before ever
//     telling the user "this fits" or deciding to trim something, and must
//     act on the numbers it gets back, not its own guess.
//
//   finalize_pdf(content) → produces the actual PDF (same renderer) and
//     returns it as base64 so the client can show/download it.
//
// ── FIX: no more separate "preview" PDF step ─────────────────────────────
// Previously there were two rendering tools — render_preview and
// finalize_pdf — producing a "not-yet-final" PDF before a "final" one.
// This added an extra file the user had to look at and confirm before
// they ever saw a real, finished document. Now there is only ONE
// rendering tool, finalize_pdf. The flow instead is:
//
//   1. The model builds the content object through conversation.
//   2. Once it's complete and fits (per check_template_fit), the model
//      shows the organized content back to the user as PLAIN TEXT in the
//      chat — not a PDF — so they can review the actual wording/sections
//      before any file is produced at all.
//   3. Only once the user confirms that text looks right does the model
//      ask for their photo (request_photo_upload).
//   4. Once the photo is attached (or skipped), the model calls
//      finalize_pdf ONCE to produce the real, finished PDF.
//   5. The user is still in the same chat afterward, so any further
//      change they ask for is just handled by updating the content object
//      and calling finalize_pdf again — there's no separate "preview vs.
//      final" distinction anymore; every render IS the current version of
//      the finished document.
//
// ── FIX: the photo is never mentioned before the model actually asks for
// it ───────────────────────────────────────────────────────────────────
// Earlier revisions of this prompt let the model bring up the photo as a
// friendly aside at almost any point ("you can add a photo later, no
// rush") while it was still building out other sections. That's a real
// problem, not just a tone issue: cv.html's photo-cropping frame ONLY
// opens when request_photo_upload has actually been called (it sets
// awaitingPhoto:true in the response, which the client reads to decide
// whether an attached image is a photo or a document to extract text
// from). An early, casual mention of "the photo" is not a tool call, so
// the client never learns to expect one — if the user then attaches their
// photo in response to that casual remark, it gets read as a document
// (vision-extracted as text) instead of applied as the profile photo, and
// finalize_pdf later renders the CV with no photo at all even though the
// user believes they already supplied one. The system prompt now states
// this as a hard, repeated rule (see step 6 and the Hard rules section
// below): no mention of a photo, in any form, before the user has
// confirmed the step-5 content review and the model calls
// request_photo_upload.
//
// ── FIX: the user's photo is now actually forwarded ──────────────────────
// Previously, photoBase64 was accepted from the client but never inserted
// anywhere — the model had no way to "pass it through" as the old system
// prompt claimed, since it never actually saw the value. The model should
// never have to carry a giant base64 string through its own context anyway
// (wasteful, and error-prone if it got copied wrong). Instead, the server
// now tracks the most recently supplied photoBase64 and silently injects
// it into content.photoBase64 itself, every time check_template_fit or
// finalize_pdf is called — the model just needs to build the rest of the
// content object; the photo is handled for it.
//
// ── FIX: file delivery inside the Telegram Mini App ──────────────────────
// Telegram's in-app browser has no filesystem access at all — a blob: URL
// or <a download> silently does nothing there. So the moment finalize_pdf
// produces a PDF buffer, this file now pushes it straight into the user's
// Telegram chat as a real document via the bot (same sendDocument logic
// send-telegram-file.js uses, shared from lib/telegram-send.js). The
// base64 is still also returned to the client so the in-app chat log can
// show a card for it — but the actual, reliable delivery path is the
// Telegram push, not the in-app Open/Download links. A failed push (e.g.
// Telegram not linked yet) is non-fatal: the conversation continues
// either way.
//
// ── FIX: content schema now supports multiple references + optional
// contact fields ──────────────────────────────────────────────────────
// Every template's renderer was updated (see cv-shared.js / each
// cv-template-*.js) to: (a) accept `references` as an ARRAY of 0, 1, 2, 3+
// entries instead of a single `reference` object, laying them out
// side-by-side or stacked depending on the template; (b) treat any missing
// contact field (phone/email/location/linkedin) or reference field as simply
// absent, never drawing an orphan label for it; and (c) compute language
// proficiency bars from each language's own `level` text via
// proficiencyToFill() in cv-shared.js, instead of guessing from array
// position. The system prompt below has been updated to match — the model
// now asks about contact fields and references without assuming there's
// only ever one of the latter.
//
// ── FEATURE: LinkedIn — full URL only, never a bare handle or name ───────
// contact now has an optional `linkedin` field. If the user gives only a
// handle (e.g. "@yilak_abay") or just their name (e.g. "Yilak Abay") instead
// of a real profile URL, the model is instructed (see the "About LinkedIn"
// section of buildSystemPrompt() below) to NOT store that as-is. Instead it
// shows the user what the full URL is likely to look like as a suggestion,
// tells them exactly where on LinkedIn to find and copy their real profile
// URL, and only writes contact.linkedin once the user has given or confirmed
// an actual https://www.linkedin.com/in/... link. This mirrors the existing
// "never invent a fact" philosophy elsewhere in the prompt — a guessed URL
// is a convenience suggestion to confirm, never something the content object
// accepts unconfirmed.
//
// ── FEATURE: translating static UI chrome to the conversation's language ──
// cv.html has no language picker and never will — the app's own UI chrome
// (buttons, labels, static notices) stays in English by default. But the
// user and the AI can end up chatting in any language, and a couple of
// small static UI pieces (right now: the "may not open in Telegram" notice
// box, with its paragraph, checkbox label, and two buttons) read oddly if
// they're the only thing left in English in an otherwise non-English
// conversation.
//
// Rather than hardcode a second (or third) language directly into cv.html,
// cv.html asks THIS function to translate those strings, using the same
// model already powering the conversation to both (a) detect what language
// the user has actually been writing in, from the real recent messages, and
// (b) translate the fixed UI strings into that language — never the other
// way around (never translate the CV content itself; that's the unrelated,
// existing English-only rule in buildSystemPrompt). See handleTranslateUI()
// below. This is a separate, much smaller request than the main chat loop:
// no tools, a tiny prompt, one AI call, and a fallback to the original
// English strings for absolutely any failure (bad JSON back, detection
// unclear, network error, low balance) — a UI label staying in English is a
// cosmetic miss, never worth breaking the chat over.

// ── ESM/CommonJS bridge ───────────────────────────────────────────────────
// This file is .mjs (ES module) so it can return a streaming Response (see
// the "LIVE PHASE STREAMING" note near the bottom) — Netlify's streaming
// support needs the modern Request/Response handler shape, which the old
// Lambda-style `exports.handler` can't return from. Everything else in this
// file is completely unchanged from the CommonJS version: createRequire
// gives a real, synchronous require() so every `require('./lib/...')` call
// below still works exactly as written, with zero changes to any of the
// template/library modules themselves (they stay CommonJS).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── Template registry ──────────────────────────────────────────────────
// Each entry maps a templateId (chosen by the user in the gallery, sent by
// the client with every request) to its measure()/render() module. Adding
// a new template later is just one more line here plus a new lib file.
const TEMPLATES = {
  minimal:          { name: 'Minimal / Scandinavian', mod: require('./lib/cv-template-minimal') },
  'navy-sidebar':   { name: 'Navy Sidebar',            mod: require('./lib/cv-template-navy-sidebar') },
  'gold-header':    { name: 'Corporate Minimal Gold',  mod: require('./lib/cv-template-gold-header') },
  'teal-gold':      { name: 'Teal & Gold',             mod: require('./lib/cv-template-teal-gold') },
  'copper-diagonal':{ name: 'Diagonal Navy & Copper',  mod: require('./lib/cv-template-copper-diagonal') },
  'emerald-hex':    { name: 'Emerald & Gold Hexagon',  mod: require('./lib/cv-template-emerald-hex') },
  'editorial':      { name: 'Editorial Column',        mod: require('./lib/cv-template-editorial') },
  'block-band':     { name: 'Gray Block & Black Band', mod: require('./lib/cv-template-block-band') },
  'classic':        { name: 'Classic / International',  mod: require('./lib/cv-template-classic') },
  'accent':         { name: 'Quiet Accent',            mod: require('./lib/cv-template-accent') },
  'banded':         { name: 'Banded Gray',             mod: require('./lib/cv-template-banded') },
  'timeline':       { name: 'Timeline Sidebar',        mod: require('./lib/cv-template-timeline') },
  'purple':         { name: 'Purple Executive',        mod: require('./lib/cv-template-purple') },
  'orangeline':     { name: 'Orange Line',              mod: require('./lib/cv-template-orangeline') },
  'navytitle':      { name: 'Navy Title',               mod: require('./lib/cv-template-navytitle') },
  'graybox':        { name: 'Gray Box',                 mod: require('./lib/cv-template-graybox') },
  'blackband':      { name: 'Black Band',               mod: require('./lib/cv-template-blackband') }
};
const DEFAULT_TEMPLATE_ID = 'minimal';

function resolveTemplate(templateId) {
  return TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE_ID];
}
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { sendPdfDocument } = require('./lib/telegram-send');

const {
  callAI, getDb, authenticate, assertCanStart,
  deductTokens, errorResponse, AIError,
  FEATURE_MODELS, MODEL_IDS
} = require('./lib/ai-billing');

const BAI_API_KEY = process.env.BAI_API_KEY;
const MAX_TOOL_ITERATIONS = 6; // safety cap on the internal tool loop — see HANDLER_DEADLINE_MS below for the real, time-based cap

// ── Whole-handler wall-clock deadline ─────────────────────────────────────
// This is the actual guard against the function running past its platform
// limit mid tool-loop. It is checked (a) once before the extraction
// fallback runs and (b) before every single AI call inside the tool loop.
// If too little time is left to safely start another call, the code stops
// itself, bills for whatever was genuinely used, and returns a normal reply
// asking the user to continue — instead of letting the platform kill it
// mid-request.
//
// cv-chat.mjs runs as a Netlify Functions 2.0 streaming function (see the
// `export default` wrapper + sseEncode at the bottom of this file), which
// has a 60s execution ceiling — not the old classic-function 10s free-plan
// limit this comment used to describe. 8500ms was sized for that old 10s
// ceiling and was cutting off real AI calls (especially slower models like
// deepseek-v4-pro on a turn with an attached document) well before they
// could finish, surfacing as AbortError in the logs. 50000ms leaves ~10s of
// margin inside the real 60s ceiling for JSON parsing, response
// serialization, and runtime jitter.
const HANDLER_DEADLINE_MS = 50000;
// Don't even start an AI chat-loop call with less than this much time
// left — a chat-loop call realistically needs at least this long to have a
// chance of finishing instead of being cut off mid-stream.
const MIN_TIME_TO_START_CHAT_CALL_MS = 3000;

function timeLeft(startedAt) {
  return HANDLER_DEADLINE_MS - (Date.now() - startedAt);
}

// ── DEV ACCESS GATE ──────────────────────────────────────────────────────
// While the CV feature is being built and tested, only this one account may
// use it, no matter how the request reaches this function. cv.html also has
// a client-side gate for a clean "coming soon" screen, but THIS check is
// the one that actually matters — client-side checks can always be
// bypassed, so the server must independently refuse everyone else here.
const CV_DEV_ALLOWED_USER_ID = '0985576139';

function buildSystemPrompt(templateName, convLanguage, noPhoto = false) {
  // Computed fresh on every call (never hardcoded) so this stays correct as
  // real time passes — see the "About today's date" note just below for why
  // this matters at all.
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // convLanguage is the app's current display language (e.g. "አማርኛ
  // (Amharic)"), passed in from cv.html's own i18n choice — or the literal
  // string "English" if the app is set to English or sent nothing. This
  // governs ONLY how the model talks to the user in chat — see the
  // "About language" section right below for the hard line it draws
  // against ever letting that bleed into the CV's actual content.
  const languageSection = (convLanguage && convLanguage !== 'English')
    ? `## About language — read this before anything else
The app's current display language is ${convLanguage}. Write your own side of the conversation — greetings, questions, confirmations, explanations, anything you say to the user — in ${convLanguage}, the same way the rest of the app's own text is shown in that language right now.

This does NOT extend to the CV itself. A CV / job application document is conventionally expected in English, so every single piece of text that becomes part of the actual content object — ALL of it: name (as the user gave it, never retranslated), subtitle, profile, skills, each experience bullet, achievements, certification titles, reference details, customSections titles and content, and the section labels/headers the renderer draws (Skills, Experience, Education, Profile, Languages, Achievements, Certifications, References, and any custom section title) — must always be written in English, exactly as if the app were set to English, regardless of ${convLanguage} being the conversation language. If the user describes their experience, skills, or any other CV content to you in ${convLanguage}, you translate THEIR meaning into natural, professional English for the content object — you do not carry their language into the document. Never translate a section header or label into ${convLanguage} inside the content object itself; those are drawn by the renderer in English no matter what you put there, so writing them in another language would just look broken. The one exception already covered elsewhere in this prompt: transcribed text you quote verbatim from a scanned document (e.g. when a name reads ambiguously) stays exactly as scanned, in whatever script that was — that's about transcription accuracy, not translation, and is unrelated to this rule.

`
    : '';

  const noPhotoRules = noPhoto ? `## THIS TEMPLATE HAS NO PHOTO — this overrides every other rule about photos
This template never shows a profile photo. Therefore:
- Never ask the user for a photo, in any form, at any step. Never mention a photo, and never say things like "you can add a photo later". Do not call request_photo_upload; for this template that step does not exist.
- Once the user confirms the step-5 content review, go straight to finalize_pdf. Do not ask about a photo first.
- If the user attaches a photo, do not use it and do not treat it as their photo. Reply briefly that this template does not use a photo, and ask them to describe their details or send a document instead (certificates, transcripts or an old CV are still welcome).

` : '';

  return `${noPhotoRules}You are "CVcase", a friendly, efficient AI that builds a professional one-page CV with the user through conversation, using the "${templateName}" template — this is the ONE template for this whole conversation; the user already picked it in the gallery before you started talking, so never ask them to choose a template again.

## You are the expert in charge — the user is likely NOT a CV writer
Most users here have no idea what makes a good CV, what the "right" next step is, or what professional wording sounds like — that's exactly why they're using this instead of writing it themselves. So you drive every step, and you make the professional judgment calls, not them. Concretely:
- When a choice is genuinely a matter of professional judgment — phrasing, which of two reasonable subtitle options fits better, whether a bullet reads well, how to order sections — decide it yourself using your best expertise and move straight on to the next step in the SAME reply. Do not ask the user to pick between options you already have a professional opinion on; give them your pick (briefly say what you chose, so they can correct you if they disagree) and keep going.
- If the user explicitly hands a decision back to you — "you choose", "whatever you think is best", "you're the expert", "up to you" — that is your cue to decide immediately and continue, never to pause, go quiet, or ask what to do next. Pick the better option using your professional judgment, say what you picked in one short clause, and carry on with the next step in the SAME reply. Never end a reply with an open question like "What would you like me to do next?" after a user has just told you to decide something — that puts the decision right back on them, which is the one thing they just asked you not to do.
- The only things worth actually asking the user about are things only they can know: their own facts (name, employer, dates, grades), their own preferences when two options are genuinely close calls that reasonably come down to personal taste, or a hard stop condition (e.g. content doesn't fit and a specific cut needs their buy-in, per the fit rules below). Everything else — what step comes next, how to phrase something, which reasonable option to pick — is your call to make and act on, not theirs to be asked.
- You always know what the next step is (see "Your job, step by step" below) — there is never a moment where you genuinely don't know what to do next. If you ever find yourself with nothing obvious to say, that means you should just continue the CV-building process at whatever step comes next, not hand the conversation back with a vague question.

${languageSection}## About today's date
Today's real-world date is ${today}. Your own training data stops well before this, so recent or ongoing dates the user gives you — a job that started in 2025, a degree finishing in 2026, a certificate dated last month, an experience entry that says "2024 - Present" — are completely normal and current, not "in the future" or suspicious. Never flag, question, or hesitate over a date just because it falls after your training cutoff; treat it exactly the way you'd treat their name or job title — the user's own word on it is the source of truth. The ONLY time to question a date at all is the unrelated, existing rule about transcribing a document's text exactly as scanned (see step 1) — that's about reading accuracy, not about whether a date is plausible.

## About the photo — read this before anything else
The user's profile photo is handled entirely by step 6 below, and ONLY by step 6. Until you reach that exact step, never say the word "photo" in any form — not "do you have a photo", not "you can add one later", not "no rush on the photo", nothing, not even in passing while talking about something else. This isn't a style preference: the app's photo-cropping screen only opens for the user the moment you call the request_photo_upload tool. If you mention the photo earlier without calling that tool, the app has no way to know a photo is coming — so if the user reacts to your early mention by attaching their photo right then, the app treats it as a document to read for text, not as their profile picture, and the CV ends up finished with no photo on it even though the user believed they'd already given you one. Stay completely silent about photos through steps 1-5; raise it for the first time only inside step 6, by calling request_photo_upload.

## About LinkedIn — read this before step 3
LinkedIn is entirely optional and only comes up if the user brings it up or wants it added. If the user gives you a LinkedIn handle (e.g. "@yilak_abay") or just their name (e.g. "Yilak Abay") instead of a full profile URL, don't just take it silently — help them get the real link first:
1. Tell the user what the full URL is LIKELY to look like based on what they gave you, clearly framed as a guess to confirm — e.g. "Based on that, your LinkedIn URL is probably something like https://www.linkedin.com/in/yilak-abay — is that the right one, or can you paste your exact profile link?"
2. In the same message, tell them exactly where to find and copy their real one: on LinkedIn (app or website), open their own profile and look for "Edit public profile & URL" (on the right-hand side of the desktop profile page, just under the profile photo/headline; in the mobile app it's under the "..." / edit-profile menu) — tapping that shows the full public profile URL with a copy option. The simplest alternative: on desktop, their profile URL is just whatever is shown in the browser's address bar while viewing their own profile page.
3. If the user then gives you the real full URL, use that. But if they don't bother — they just confirm the guess, repeat the handle/name, or say to just use what they gave you — go ahead and accept it and put it in contact.linkedin as given. Ask once and offer the guidance once; don't block them or keep insisting on a "proper" link if they'd rather not look it up.

## Your job, step by step
1. Greet the user briefly and ask them to describe themselves OR upload documents (certificates, transcripts, old CV) — either is fine. Any document or image the user attaches has ALREADY been read for you and appears in the conversation as extracted text labelled with its filename — read that text as the source of information, you never see the raw file yourself.
   - If a file could NOT be read, it appears as "[NOT READ: ...]" (or "[Could not read this file.]") under its filename, followed by a system note. The app shows the user a box with a Retry button for those files, so never ask them to re-upload or resend them. Name the unread files, then decide: if what was read is already enough to build a good CV, say the missing files probably aren't essential and suggest continuing; if they likely hold key information, recommend pressing Retry first. Never guess what an unread file contains.
   - NEVER "correct", normalize, or substitute a person's name (or any other proper noun — a school, an organization, a place) based on what name you think it's "probably supposed to be". The extracted text is a raw, sometimes imperfect reading of a photo — treat it as exactly that: a reading, not a hint. If the same name appears to read differently across files, quote EXACTLY what the extracted text shows for each file (verbatim, including any odd characters) and simply ask the user: "Your name reads differently across these — which is your correct full name?" Do NOT propose alternate spellings or similar-sounding real names of your own (e.g. turning a garbled fragment into a common name you know) — that is inventing a fact, not reading one, and a wrong name on someone's CV is a serious, real-world mistake. The user typing their own name is always the source of truth, not your best guess at what the scan "probably" says.
2. Build a content object matching this exact schema:
   {
     name, subtitle, contact: {phone,email,location,linkedin},
     education: {degree,school,extra},
     languages: [{name,level}],   // level is a free-text proficiency label — see note below
     profile, skills: [string],
     experience: [{org,role,dateRange,bullets:[string]}],
     achievements: [string], certifications: [{title,issuer}],
     references: [{name,role,email,phone}],   // 0, 1, 2, 3+ entries — see note below
     customSections: [{title, placement, items, text}]   // extra sections the user asks for — see note below
   }
   Every field in contact and in each item of references is OPTIONAL — omit a key entirely if the user doesn't have it (e.g. contact: {email: "..."} with no phone/location/linkedin is valid). Never fill a missing field with a placeholder like "N/A" or an empty string — the renderer already knows to skip a field that isn't there, so a placeholder would be the only thing that actually shows up wrong. languages[].level should be a plain proficiency word the renderer can read a fill-bar amount from (e.g. "Native", "Fluent", "Advanced", "Intermediate", "Basic") — use the label the user actually gave you, don't invent a different scale. contact.linkedin, when present, must always be a full profile URL (e.g. "https://www.linkedin.com/in/yilak-abay") — never a bare handle like "@yilak_abay" and never just a name like "Yilak Abay". See the "About LinkedIn" section above for exactly how to handle it when the user only gives you a handle or a name.
   - subtitle is the person's professional title (e.g. "Software Engineer", "Marketing Specialist", "Recent Graduate — Computer Science"). Several templates display this as ONE line in a fixed-width banner, so keep it genuinely short — aim for 2-4 words and well under 40 characters. If what the user describes is naturally longer (a dual title, a long specialization), pick the most important part or shorten the phrasing yourself rather than passing the long version through — the templates will shrink an oversized title as a last resort, but a title you kept short in the first place always looks better than one that had to be shrunk or, in an extreme case, cut off.
   - customSections: use this whenever the user wants a section that isn't in the fixed schema above — e.g. "Add an Academic Projects section", "Add Volunteering", "Add Interests". Each entry is { title, placement: "sidebar" | "main", items?: [string], text?: string }. Give it EITHER items (a short bullet list — use this for anything list-like: project names, tools used, hobbies) OR text (one paragraph — use this for something more narrative/descriptive), not both. Decide placement yourself based on the content and available space, the same way you'd judge any other section:
     - The sidebar (where Education/Skills/Languages live) suits short, scannable entries — a handful of one-line items, not paragraphs. Prefer placement:"sidebar" for compact lists like tools, interests, or a short project list.
     - The main column (where Experience/Achievements/Certifications live) suits longer or more detailed entries — a project with a description, multiple bullet points, or a paragraph. Prefer placement:"main" for anything with real detail.
     - Whichever you pick, ALWAYS call check_template_fit with the content object that includes the new customSections entry before telling the user it's been added — the renderer wraps everything to the real column width automatically (so long items can't run off the page or off the sidebar), but fit (whether the page still has room at all) is only ever something check_template_fit's numbers can tell you, never your own guess. If it doesn't fit, follow the same "give one specific, confident recommendation" rule as any other overflow case (see below) — a custom section is exactly the kind of thing that's reasonable to suggest trimming first, since it's an extra the user chose to add on top of the base CV.
3. If a section is thin or missing (e.g. no experience, no skills), do NOT just leave it empty and do NOT interrogate the user with a long form. Ask ONE short, friendly question at a time, offering an easy way out — e.g. "Have you done any internship, volunteer work, or class project? If not, no worries, I can suggest some based on your field." If they still have nothing, propose 3-5 common, reasonable skills/achievements for their field of study as SUGGESTIONS ONLY, clearly labeled as suggestions, and ask them to confirm/edit before including them. NEVER silently invent facts (like a specific employer, degree, or grade) — only suggest generic, clearly-labeled filler for skills/soft-skills, never for verifiable facts.
   - Contact details: ask for phone, email, location, and LinkedIn together in one friendly question, but don't insist on all of them — if the user only has one or two, that's completely fine, just leave the others out of contact rather than asking again or inventing something. If they give LinkedIn as a handle or a name instead of a full URL, follow the "About LinkedIn" rule above — offer the likely full link and where to copy it, then use whatever they end up confirming or sticking with.
   - References: ask if they'd like to include a reference, and if so how many (most CVs list 1-3). Collect each one's name/role/email/phone the same way — one short, friendly question at a time, not a long form — and put all of them in the references array in the order given. If the user has none, use an empty array and move on without pushing back.
   - Remember: nothing about a photo belongs in this step either, however natural it might feel to mention while you're already asking about contact details or references. Hold that entirely until step 6.
4. Before you EVER tell the user their CV "fits" or "is too long", call check_template_fit with your current best content object. Trust ONLY its numbers — never estimate this yourself.
   - The renderer automatically tries space-saving layout techniques (like packing skills onto fewer lines) BEFORE reporting overflow — so if check_template_fit or finalize_pdf returns fits:true, the content already fits with no changes needed from the user, even if the layout looks slightly denser than before. Never ask the user to cut anything in this case.
   - If it reports real overflow (fits:false) after those automatic techniques were already tried: do NOT ask an open-ended question like "what would you like to remove?". Instead, look at the result's "recommendation" field (or, if finalize_pdf failed with an error, its message) and give the user ONE specific, confident recommendation — name the exact section and roughly how much to cut, e.g. "Your Experience section is the longest part — I'd suggest shortening the Acme Corp bullets from 4 to 2, focusing on your biggest wins. Want me to do that?" Propose the cut, don't just describe the problem.
   - If finalize_pdf itself fails with an error whose message says content is too long even at maximum compaction (this happens when the content is genuinely too much for one page, not just a close call): treat this as a hard limit, not a suggestion. Clearly tell the user this specific template can't fit everything they've given you no matter how it's laid out, give them the same specific, confident recommendation from the error message, and don't attempt to render again until the content has actually been shortened — retrying with the same content will fail the same way.
   - If the user pushes back on your recommendation and insists on keeping everything, you can offer them one alternative (e.g. a different section to trim instead, or suggest switching to a template with more room) — but don't keep proposing vague options back and forth; make a clear call and act on it once they've responded once.
5. Once check_template_fit confirms the content fits, call polish_review_text with that same content object. This runs the content through a separate step that turns it into warm, natural-sounding, human review text — section by section (Profile, Experience, Skills, etc.) — instead of you writing that review text yourself. Take the "text" the tool returns and relay it to the user VERBATIM, exactly as given — do not rewrite, shorten, or restyle it yourself, and do not add your own version of the sections. This is NOT a PDF and NOT a preview file — it is just that polished text, shown back to them in the chat for them to read and confirm or correct. Do not call finalize_pdf yet at this point, no matter how confident you are it fits — the user reviews the text first. After the polished text, add ONE plain confirmation question of your own — e.g. "Does everything look right?" or "Let me know if you'd like to change anything, or if this looks good." Do NOT preview what you'll do once they confirm (e.g. never say anything like "If so, I'll ask for your photo next") — just ask for confirmation. This also means not mentioning the photo here, even obliquely — say nothing about it until step 6 actually begins, which only happens after the user confirms.
   - IMPORTANT — keep that same voice afterward: polish_review_text is called ONCE per CV, right here in step 5. If the user then asks you to refine, correct, or add something to the review text before confirming, make the edit yourself (you are capable of writing in that voice too) and show the updated section(s) — do NOT call polish_review_text again. When you make that edit, deliberately match the warm, natural tone polish_review_text used rather than reverting to flatter, more robotic phrasing — read back over its text before you write your edit so the voice stays consistent across the whole review, including any later section you add or rewrite.
6. Once the user explicitly confirms that text looks right (or finishes correcting it and confirms), THIS is the first and only moment you may say anything about a photo at all. Call request_photo_upload and ask them to attach their photo. Do NOT ask for a photo any earlier than this step, and do not soften that into a passing mention beforehand — the app only shows the photo-cropping frame the instant you call request_photo_upload, and any image attached before that call is read as a text document instead of applied as the profile photo, which means the CV would quietly finish without it even though the user thinks they already sent it. If the user has no photo or doesn't want one, that's fine — proceed without it.
7. Once the user has attached a photo (or said to skip it), call finalize_pdf with the final content object. This produces the actual, finished CV and delivers it to the user as a file in this Telegram chat — there is no separate "preview" step; this IS the real document. Tell the user it's ready and to check the chat for the file.
8. The user stays in this same chat after seeing the PDF, and may ask for changes at any point afterward (e.g. "can you reword the profile" or "add another skill"). When that happens: update just the relevant field(s), call check_template_fit again first if the edit could plausibly cause overflow (e.g. adding a paragraph or another reference), then call finalize_pdf again with the updated content object to deliver the corrected PDF. You do not need to re-show the plain-text content or re-ask for a photo for a simple edit like this — just make the change and re-render.

## Hard rules
- The content object — every field in it, including section labels/headers — is always written in English, no matter what language you're chatting with the user in. See "About language" above for the full rule and why.
- Never mention a photo — in any form, including a quick "you can add one later" aside — before step 6. This is absolute: it applies through every part of steps 1-5, even while you're already talking about something adjacent like contact details, appearance, or formatting. The single allowed moment to bring it up for the first time is calling request_photo_upload at the start of step 6, after the user has confirmed the step-5 content review. Mentioning it earlier without calling the tool leaves the app unable to tell a later-attached photo apart from a document, and the CV can end up finished with no photo even though the user believes they already sent one.
- When the user gives a LinkedIn handle or name instead of a full URL, follow the "About LinkedIn" section above: show them the likely full URL and where to copy the real one, but if they still want to go with what they gave you, accept it as given rather than refusing or repeating the request.
- Never call check_template_fit or finalize_pdf without a reasonably complete content object — but never call finalize_pdf before the user has reviewed the plain-text content (step 5) and confirmed it, and before you've asked about their photo (step 6), on the FIRST render. After that first PDF, later edit requests can go straight to finalize_pdf once the change is made.
- Never call finalize_pdf without having called check_template_fit at least once on that same content first, unless the content is trivially short (e.g. a one-field edit unrelated to length) or this is a re-render after the very first PDF where fit was already recently confirmed for content of similar size.
- Never state a fit/overflow judgment without a check_template_fit tool result to back it up.
- When content doesn't fit, give ONE specific, confident recommendation (which section, roughly how much to cut) instead of an open "what should I remove?" question — you're the one who can see the numbers, act like it.
- The renderer will refuse to produce a PDF (an error, not a bad-looking file) if content is genuinely too much even at maximum compaction. Treat that refusal as final for that content — don't retry finalize_pdf with the same content expecting a different result; get the user to agree to a specific cut first.
- Never invent specific factual claims (employers, dates, grades, certificate names). Only ever suggest generic, clearly-labeled filler for skills or soft-skill phrasing.
- Keep messages short and conversational — this is a chat, not a form. This applies even to the step-5 content review: format it cleanly, but don't pad it with extra commentary.
- Never treat an uploaded document's extracted text as a description of a "photo" — until AFTER you've called request_photo_upload (step 6), any attachment is a document to read for information.
- Call polish_review_text exactly ONCE per CV, at step 5, on the content that just passed check_template_fit. Never call it again for the same CV — including after edits, after the first PDF, or on a later re-render. Any later wording change is something you write yourself, matching the tone polish_review_text already set.
- You never need to include a photoBase64 field — the app handles the photo automatically when rendering.
- The PDF is delivered to the user as a real file message in this Telegram chat, not as an in-app download link — always phrase it that way ("I've sent it to you here in the chat"), never "click download" or "open the link".
- There is only ONE kind of rendered file in this whole conversation — the finished CV PDF. Never refer to anything as a "preview" — every render is the current, real version of the finished document.`;
}

// OpenAI-style function-calling schema (the B.AI gateway is OpenAI-API-compatible).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_photo_upload',
      description: 'Call this ONLY once the user has explicitly confirmed the organized CV content, shown to them as plain chat text, looks right — and you are ready to ask them for their profile photo. This is also the FIRST and ONLY time you may mention a photo at all in the conversation — never refer to the photo, even in passing, before calling this. Calling this tells the app to show the photo-cropping frame the next time the user attaches an image — before this call, any image the user sends is treated as a document, not a photo.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_template_fit',
      description: 'Runs the REAL layout measurement for the selected CV template against a candidate content object. Returns exact per-section line counts, and whether the content fits one page (overflowLines/underflowLines). Always call this before judging fit or before finalizing.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'object', description: 'The candidate CV content object matching the schema described in the system prompt.' } },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'polish_review_text',
      description: 'Call this ONCE per CV, right after check_template_fit confirms the content fits, and before showing the user the step-5 content review. Sends the content object to a separate writing pass that turns it into warm, natural, human-sounding review text (not a robotic section dump), and returns that text for you to relay to the user VERBATIM. Never call this a second time for the same CV — later edits are written by you directly, matching the tone this call establishes.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'object', description: 'The same content object that just passed check_template_fit.' } },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_pdf',
      description: 'Renders the CV into an actual, finished PDF and delivers it to the user as a file message in this Telegram chat (not an in-app download link). This is the only rendering tool — there is no separate preview step. Only call this after the user has reviewed and confirmed the plain-text content and you have asked about their photo (on the first render); on later edits, call it again once the requested change has been made to the content object.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'object' } },
        required: ['content']
      }
    }
  }
];

// Tools offered to the model. Templates with no photo never get the photo
// tool, so the model has no way to start a photo step for them.
function toolsFor(template) {
  if (template.mod.noPhoto) return TOOLS.filter(t => t.function.name !== 'request_photo_upload');
  return TOOLS;
}

// ── Document/photo text extraction via Gemini 3 Flash (images) + pdf-parse (PDFs) ──
// The conversation loop is text-only, so every attachment is turned into
// plain text before the model ever sees it. See the MODEL note at the
// top of this file for why PDFs and images take different paths.
//
// NOTE: cv.html now reads most files BEFORE calling this function (see the
// "files are now read BEFORE this function is called" note at the top). The
// code below is the fallback for files that arrive in the old shape
// (base64 / pages) — it is unchanged except that vision calls now retry once
// and failures give a clearer reason, AND the time budgets below leave real
// room for the chat loop afterward inside the function's real 60s streaming
// ceiling (see HANDLER_DEADLINE_MS above and EXTRACTION_TIME_BUDGET_MS
// below).
//
// ── LIMITS (why they exist) ──────────────────────────────────────────────
// Extracted text is pasted into the conversation, and the WHOLE conversation
// is re-sent to the AI (and billed as prompt tokens) on every later turn.
// So a huge PDF doesn't just cost once — it makes every following message
// more expensive, and can overflow the model's context. These caps keep that
// bounded. Raise/lower them here; nothing else needs to change.
const MAX_FILES_PER_TURN   = 5;            // keep in step with MAX_FILES_PER_MESSAGE in cv.html; extra files are not read (user gets a Retry box)
const MAX_SCANNED_PAGES    = 4;            // keep in step with MAX_SCANNED_PAGES in cv.html
const MAX_PDF_PAGES        = 10;           // pdf-parse only reads this many pages
const MAX_CHARS_PER_FILE   = 15000;        // ~4k tokens per file
const MAX_CHARS_TOTAL      = 30000;        // across all files in one message
const MAX_FILE_BASE64_CHARS = 5.5 * 1024 * 1024; // skip absurdly large single files

// This is now ONLY a budget for the old-shape fallback path (files that
// arrive as base64/pages instead of already-extracted text), AND it has to
// leave real room for the chat loop afterward inside the function's real
// 60s streaming ceiling (HANDLER_DEADLINE_MS = 50000). This path should
// rarely run at all in normal operation (see the note above), so 15s is
// generous without starving the chat loop that follows it.
const EXTRACTION_TIME_BUDGET_MS = 15000;
// Cap on any single vision call made from inside this fallback path — large
// enough for one slow image/page without eating the whole extraction budget
// by itself (several pages can still be read within EXTRACTION_TIME_BUDGET_MS).
const MAX_SINGLE_VISION_CALL_MS = 12000;

const EXTRACT_PROMPT = 'Extract all readable text from this document/image (certificate, transcript, CV, ID, etc). Reply with the plain extracted text only — no commentary, no markdown formatting, no summary. If it is a certificate or award, include the recipient name, the title/subject, the issuing body, and any date exactly as written. TRANSCRIBE LITERALLY: this applies above all to names of people, schools, and organizations. Do not "clean up", autocorrect, or substitute a name for a more common/familiar-looking one, even if a word looks unusual or you suspect it is probably a well-known name spelled differently. Copy exactly the characters you can make out. If part of a word or name is genuinely illegible, write it as-is with [?] immediately after the unclear part rather than guessing a plausible replacement — never silently swap in a different, more common name.';

const UNREADABLE_FILE_MSG = '[Could not read this file.]';

// Result for a file that could NOT be read. `reason` is a short label shown
// to the user in cv.html's "couldn't be read" box; `retryable` says whether
// pressing Retry could plausibly succeed (false for things like "too large"
// or "no text inside", where reading it again would fail the same way).
function unread(text, reason, retryable) {
  return { text, usage: null, cost: 0, failed: true, reason, retryable };
}

// Cuts text to `limit` characters and tells the model (and so the user) it
// was cut, instead of silently dropping the rest.
function clipText(text, limit, label) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n[...${label} was cut short: only the first ${limit} characters were kept.]`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One Gemini 3 Flash vision call on one image, via the B.AI gateway.
// Returns { text, usage, cost } — cost is already in CT, at Gemini's real
// rate (lib/ai-billing.js's costFromUsage).
// Errors are tagged `transient` when trying again could plausibly work
// (rate limit, server error, timeout, network) so callers can tell a busy
// service apart from a bad file.
async function visionRead(base64, mime, timeoutMs) {
  try {
    const result = await callAI({
      model: FEATURE_MODELS.CV_EXTRACTION,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: EXTRACT_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ]
      }],
      maxTokens: 1500,
      timeoutMs: timeoutMs || MAX_SINGLE_VISION_CALL_MS,
      attempts: 1 // no in-function retry here — see visionReadWithRetry
    });
    return { text: (result.text || '').trim(), usage: result.usage, cost: result.cost };
  } catch (e) {
    const err = new Error('B.AI gateway request failed: ' + e.message);
    err.transient = true; // timeout, network problem, or a retryable gateway error
    throw err;
  }
}

// A single attempt only (no in-function retry) — the overall extraction
// budget is now too tight on the free plan to afford both a retry AND
// leaving the chat loop enough time to run. A transient failure here just
// gets reported as "retryable" so the user's existing Retry-box flow (see
// cv.html) handles it on the next turn instead.
async function visionReadWithRetry(base64, mime, timeoutMs) {
  return await visionRead(base64, mime, Math.min(timeoutMs || MAX_SINGLE_VISION_CALL_MS, MAX_SINGLE_VISION_CALL_MS));
}

// Returns { text, usage, cost } — usage/cost are the gateway's reported
// token usage and its real CT cost for this file (null/0 when no API call
// was made, e.g. text PDFs and Word files, which are read locally for free).
// When the file could not be read the result also has failed:true, a short
// `reason` and `retryable` (see unread() above).
// `timeoutMs` is the time left in this turn's extraction budget.
async function extractDocumentText(file, timeoutMs) {
  const started = Date.now();
  const budget = timeoutMs || MAX_SINGLE_VISION_CALL_MS;
  try {
    if (!file) return unread(UNREADABLE_FILE_MSG, "Couldn't be read", true);
    const mime = file.mediaType || '';
    const name = file.filename || '';

    // Scanned PDF — cv.html already drew its first pages to JPEG images.
    if (Array.isArray(file.pages) && file.pages.length) {
      const totalChars = file.pages.reduce((n, pg) => n + (pg ? pg.length : 0), 0);
      if (totalChars > MAX_FILE_BASE64_CHARS) {
        return unread('[This scanned PDF is too large to read. Please upload a smaller version, or describe its contents in your message.]', 'Too large', false);
      }
      const pages = file.pages.slice(0, MAX_SCANNED_PAGES);
      const parts = [];
      let pt = 0, ct = 0, costTotal = 0;
      let okPages = 0; // pages that were actually read
      for (let i = 0; i < pages.length; i++) {
        const left = budget - (Date.now() - started);
        if (left <= 1200) {
          parts.push(`[Pages ${i + 1}-${pages.length} were not read: ran out of time.]`);
          break;
        }
        try {
          const r = await visionReadWithRetry(pages[i], 'image/jpeg', Math.min(MAX_SINGLE_VISION_CALL_MS, left));
          parts.push(`--- Page ${i + 1} ---\n${r.text || '[No readable text on this page.]'}`);
          if (r.text) okPages++;
          if (r.usage) { pt += r.usage.prompt_tokens || 0; ct += r.usage.completion_tokens || 0; }
          costTotal += r.cost || 0;
        } catch (e) {
          console.error('extractDocumentText scanned page error:', e.message);
          parts.push(`--- Page ${i + 1} ---\n[Could not read this page.]`);
        }
      }
      if (file.pageCount && file.pageCount > pages.length) {
        parts.push(`[Only the first ${pages.length} of ${file.pageCount} pages were read.]`);
      }
      const usage = { prompt_tokens: pt, completion_tokens: ct };
      // Nothing at all could be read from any page → treat the whole file as unread.
      // (If at least one page was read, the file counts as read; the text notes which pages were missed.)
      if (okPages === 0) {
        const res = unread(parts.join('\n\n'), "Pages couldn't be read", true);
        res.usage = usage; res.cost = costTotal; // tokens were still spent
        return res;
      }
      return { text: parts.join('\n\n'), usage, cost: costTotal };
    }

    if (!file.base64) return unread(UNREADABLE_FILE_MSG, "Couldn't be read", true);
    if (file.base64.length > MAX_FILE_BASE64_CHARS) {
      return unread('[This file is too large to read. Please upload a smaller or lower-resolution version, or describe its contents in your message.]', 'Too large', false);
    }

    // Word (.docx) — read the text with mammoth.
    if (mime.includes('wordprocessingml') || /\.docx$/i.test(name)) {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(file.base64, 'base64') });
      const text = (result.value || '').trim();
      if (!text) {
        return unread('[This Word file has no readable text (it may contain only images). Please describe its contents in your message instead.]', 'No readable text', false);
      }
      return { text, usage: null, cost: 0 };
    }

    // Text PDFs: the chat model can't take a PDF as input, so read the text layer directly.
    if (mime.includes('pdf') || /\.pdf$/i.test(name)) {
      const data = await pdfParse(Buffer.from(file.base64, 'base64'), { max: MAX_PDF_PAGES });
      let text = (data.text || '').trim();
      if (!text) {
        // Backup only: cv.html normally catches scanned PDFs before sending.
        return unread('[This PDF looks scanned (no text inside). Please upload it as photos/screenshots of each page instead, or describe its contents in your message.]', 'No readable text', false);
      }
      if (data.numpages && data.numpages > MAX_PDF_PAGES) {
        text += `\n[Only the first ${MAX_PDF_PAGES} of ${data.numpages} pages were read.]`;
      }
      return { text, usage: null, cost: 0 };
    }

    // Images: Gemini 3 Flash vision
    if (mime.startsWith('image/')) {
      const r = await visionReadWithRetry(file.base64, mime, Math.min(MAX_SINGLE_VISION_CALL_MS, budget));
      if (!r.text) {
        const res = unread(UNREADABLE_FILE_MSG, "Couldn't be read", true);
        res.usage = r.usage; res.cost = r.cost; // tokens were still spent
        return res;
      }
      return { text: r.text, usage: r.usage, cost: r.cost };
    }

    return unread(UNREADABLE_FILE_MSG, 'Unsupported file type', false);
  } catch (e) {
    console.error('extractDocumentText error:', e.message);
    // A busy/slow service is worth a Retry; a file that failed to parse would
    // fail the same way again, so it is not offered one.
    if (e && e.transient) return unread(UNREADABLE_FILE_MSG, 'Service busy — press Retry', true);
    return unread(UNREADABLE_FILE_MSG, "Couldn't be read", false);
  }
}

// Merges the server-known photo into a content object right before
// rendering/measuring — see the FIX note at the top of this file.
function withPhoto(content, latestPhotoBase64) {
  const merged = Object.assign({}, content || {});
  if (latestPhotoBase64) merged.photoBase64 = latestPhotoBase64;
  return merged;
}

// [First]_[Second]_cv.pdf when there's a second given name, or
// [First]_cv.pdf when there isn't — first two words of the name as written
// (e.g. "John Michael Smith" → John_Michael_cv.pdf), not first+last. Mirrors
// cvFilenameFor() in cv.html so the file name shown in-app and the one
// delivered to Telegram always match. Falls back to 'CV_Final.pdf' only if
// no usable name is present at all.
function cvFilenameForContent(content) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  const fullName = content && content.name ? String(content.name).trim() : '';
  if (!fullName) return 'CV_Final.pdf';
  const parts = fullName.split(/\s+/).filter(Boolean);
  const first  = clean(parts[0] || '');
  const second = parts.length > 1 ? clean(parts[1]) : '';
  const nameBase = first ? (second ? (first + '_' + second) : first) : '';
  return nameBase ? (nameBase + '_cv.pdf') : 'CV_Final.pdf';
}

// Turns a content object into the step-5 review text, in a warm, natural,
// human voice — this is the ONE place in the whole conversation that calls
// Claude 5.5 Sonnet (FEATURE_MODELS.CV_POLISH), as a single "final human
// polish" pass on top of what DeepSeek Pro already built. See TOOLS above
// (polish_review_text) and step 5 of the system prompt for how the model is
// told to use this — call it once, relay the result verbatim, and never
// call it again for the same CV.
function buildPolishPrompt(content) {
  return [
    'You are doing a light editorial pass on a CV that has already been fully drafted by another assistant. Your job is NOT to invent or change any facts — only to present the existing content as warm, natural, human-sounding review text instead of a flat section dump.',
    '',
    'Write it out section by section (whichever of these the content actually has — skip any that are missing or empty, same as the content object): a short intro line with the name/subtitle, Profile, Experience (with employer, role, dates, bullets), Education, Skills, Languages, Achievements, Certifications, References, and any customSections.',
    '',
    'Rules:',
    '- Never change, invent, or omit a fact: names, dates, employers, schools, grades, contact details, and every bullet\'s actual content must come through exactly as given. You are only touching phrasing and flow, never substance.',
    '- Keep each section genuinely easy to scan — short lines/paragraphs, not a wall of text — while sounding like a person wrote it, not a template.',
    '- Do not add a greeting, a closing line, or a confirmation question ("does this look right?") — the calling app adds that separately. Reply with the review text itself only, no markdown fences, no commentary before or after it.',
    '- Write in English, exactly as the content object\'s own fields are written (this mirrors the app\'s existing rule that CV content is always English regardless of the chat language).',
    '',
    'Content object (JSON):',
    JSON.stringify(content)
  ].join('\n');
}

async function callTool(name, args, latestPhotoBase64, templateId, userId) {
  try {
    const template = resolveTemplate(templateId).mod;
    if (name === 'request_photo_upload') {
      return { ok: true, message: 'The app will now show the photo-cropping frame the next time the user attaches an image.' };
    }
    if (name === 'check_template_fit') {
      const result = template.measure(withPhoto(args.content, latestPhotoBase64));
      return { ok: true, result };
    }
    if (name === 'polish_review_text') {
      const polished = await callAI({
        model: FEATURE_MODELS.CV_POLISH,
        messages: [{ role: 'user', content: buildPolishPrompt(args.content) }],
        maxTokens: 1200,
        temperature: 0.6
      });
      return {
        ok: true,
        text: polished.text,
        usage: polished.usage,
        cost: polished.cost
      };
    }
    if (name === 'finalize_pdf') {
      const buf = await template.render(withPhoto(args.content, latestPhotoBase64));
      const filename = cvFilenameForContent(args.content);
      const caption = 'Your CV 🎉';

      // The actual delivery path — see the FIX note at the top of this file.
      const tgResult = await sendPdfDocument({ userId, fileBuffer: buf, filename, caption });
      if (!tgResult.ok) console.error('cv-chat: failed to deliver PDF via Telegram:', tgResult.error);

      return { ok: true, pdfBase64: buf.toString('base64'), kind: 'final', telegramDelivered: tgResult.ok };
    }
    return { ok: false, error: 'Unknown tool: ' + name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── UI-chrome translation ─────────────────────────────────────────────────
// See the "FEATURE: translating static UI chrome" note near the top of the
// file for why this exists. Triggered by { action: 'translateUI', userId,
// sessionToken, messages, uiStrings }, where `uiStrings` is a flat
// { key: englishText } object cv.html wants translated, and `messages` is
// (a slice of) the real OpenAI-format conversation history, used only to
// detect what language the user has actually been writing in — nothing here
// ever touches or re-renders the CV content itself.
//
// Kept deliberately tiny and defensive: one short AI call, no tools, and
// ANY failure (bad JSON back, auth/balance problem, network error) falls
// back to returning the original English strings unchanged rather than
// surfacing an error — a UI label staying in English is a cosmetic miss,
// never worth interrupting the user's session over.
// cv.html auto-fills this exact text as the "user" message whenever someone
// attaches their profile photo (see sendPhotoTurn() there) — it's an
// app-injected placeholder standing in for a photo upload, never something
// the user actually typed, so it must never be read as a language sample.
const PHOTO_PLACEHOLDER_USER_TEXT = "Here's my photo.";

function englishStringsResult(uiStrings, tokenBalance) {
  return { success: true, lang: 'English', strings: uiStrings, tokensUsed: 0, tokenBalance: tokenBalance ?? null };
}

// Finds the single most recent message the user actually typed themselves —
// never the assistant's own replies, never a tool/system message, and never
// the "Here's my photo." placeholder cv.html sends on the user's behalf when
// a photo is attached (see PHOTO_PLACEHOLDER_USER_TEXT above). Walks
// backward from the end of the conversation so a photo-upload turn (or any
// other turn with nothing the user actually wrote) is skipped in favor of
// the real message before it. Returns null if there's no such message yet
// (e.g. right at the very start of a session).
function lastRealUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    // Strip the "[Attached file: ...]" extracted-text block cv-chat.js
    // appends to a user turn — that's OCR/document text, not something the
    // user typed, and would just confuse detection.
    const typed = m.content.split(/\n\n\[Attached file:/)[0].trim();
    if (!typed || typed === PHOTO_PLACEHOLDER_USER_TEXT) continue;
    return typed;
  }
  return null;
}

async function handleTranslateUI(body, db) {
  const uiStrings = (body.uiStrings && typeof body.uiStrings === 'object') ? body.uiStrings : null;
  if (!uiStrings || !Object.keys(uiStrings).length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'uiStrings is required' }) };
  }

  let user;
  try {
    user = await authenticate(db, body.userId, body.sessionToken);
  } catch (e) {
    // Translation is a nice-to-have, not core functionality — on an auth
    // hiccup just hand back English rather than forcing cv.html to handle
    // yet another error path for something this small.
    return { statusCode: 200, body: JSON.stringify(englishStringsResult(uiStrings)) };
  }

  const lastMessage = lastRealUserText(body.messages);
  // Not enough signal yet (e.g. the very first message of a session, or
  // every user turn so far was just a photo upload) — nothing real to judge
  // a language from, so don't guess; stay in English.
  if (!lastMessage) {
    return { statusCode: 200, body: JSON.stringify(englishStringsResult(uiStrings)) };
  }

  const prompt = [
    'Here is the single most recent message a chat user typed themselves, just before a UI notice box is about to be shown to them:',
    '',
    JSON.stringify(lastMessage),
    '',
    'Task: tell me what language THAT message is written in, then translate a short list of fixed app UI strings into that same language.',
    '',
    'Rules:',
    '- Judge the language from that one message alone — don\'t assume it matches any earlier part of the conversation you don\'t have here.',
    '- If that message is written in English (or you genuinely cannot tell — e.g. it\'s just a name, a number, an emoji, or otherwise has no real language content), return every string completely UNCHANGED and set "lang" to "English".',
    '- Otherwise, translate each given string naturally and concisely into that language, in a friendly tone consistent with a chat app. Keep translations short — these are UI labels and short notices, not prose.',
    '- Never translate the product name "CVcase Bot" — keep it exactly as written, in Latin letters, inside whichever string it appears in.',
    '- Respond with RAW JSON ONLY — no markdown fences, no commentary, no extra keys — in exactly this shape:',
    '{"lang":"<language name in English, e.g. \\"Amharic\\">","strings":{<same keys you were given, each mapped to its (possibly unchanged) translated text>}}',
    '',
    'Strings to translate (JSON):',
    JSON.stringify(uiStrings)
  ].join('\n');

  // Same 0-balance gate as the main chat loop — a translation nicety is
  // never worth attempting for a user with nothing left, since it would
  // just silently fall back to English anyway.
  try {
    assertCanStart(user);
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify(englishStringsResult(uiStrings)) };
  }

  try {
    const result = await callAI({ model: FEATURE_MODELS.CV_CHAT, messages: [{ role: 'user', content: prompt }], maxTokens: 600, attempts: 2 });
    const raw = result.text || '';
    const clean = raw.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(clean);

    const translated = parsed && parsed.strings && typeof parsed.strings === 'object' ? parsed.strings : null;
    // Only trust the result if every original key came back — a partial or
    // malformed response is treated as a failure, not patched together.
    const complete = translated && Object.keys(uiStrings).every(k => typeof translated[k] === 'string' && translated[k].trim());

    const promptTokens     = (result.usage && result.usage.prompt_tokens)     || 0;
    const completionTokens = (result.usage && result.usage.completion_tokens) || 0;
    const tokenBalance = await deductTokens(db, body.userId, result.cost, { feature: 'CV_CHAT', model: FEATURE_MODELS.CV_CHAT, promptTokens, completionTokens });

    if (!complete) {
      return { statusCode: 200, body: JSON.stringify({ success: true, lang: 'English', strings: uiStrings, tokensUsed: result.cost, tokenBalance }) };
    }

    const lang = (typeof parsed.lang === 'string' && parsed.lang.trim()) ? parsed.lang.trim() : 'Unknown';
    return { statusCode: 200, body: JSON.stringify({ success: true, lang, strings: translated, tokensUsed: result.cost, tokenBalance }) };
  } catch (e) {
    console.error('handleTranslateUI error:', e.message);
    return { statusCode: 200, body: JSON.stringify(englishStringsResult(uiStrings)) };
  }
}

// The original body of this function is completely unchanged from the old
// `exports.handler` version — same auth, same billing, same tool loop, same
// time budgets. The only additions are the `emitPhase` calls at a handful of
// real checkpoints (reading files, calling the chat model, running
// check_template_fit/polish_review_text/finalize_pdf), each firing a live
// SSE event to the browser. `emitPhase` is a no-op if the caller doesn't
// want streaming (see runTurn's default below), so this function behaves
// identically either way.
async function runTurn(event, emitPhase) {
  if (typeof emitPhase !== 'function') emitPhase = () => {}; // default no-op, as promised above
  const handlerStarted = Date.now(); // wall-clock anchor for HANDLER_DEADLINE_MS — see note at top of file

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!BAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'BAI_API_KEY is not configured on the server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Real enforcement — see the CV_DEV_ALLOWED_USER_ID comment above.
  if (body.userId !== CV_DEV_ALLOWED_USER_ID) {
    return { statusCode: 403, body: JSON.stringify({ error: 'CV Builder is not available yet.' }) };
  }

  // ── Small side-channel: translate static UI chrome, not the CV/chat ──────
  // See handleTranslateUI() above. Handled and returned before any of the
  // CV-building/system-prompt/billing-for-a-full-turn logic below, since
  // this is a much smaller, separate kind of request.
  if (body.action === 'translateUI') {
    let db;
    try { db = await getDb(); }
    catch (e) { return { statusCode: 200, body: JSON.stringify(englishStringsResult(body.uiStrings || {})) }; }
    return await handleTranslateUI(body, db);
  }

  let { messages, newUserText, newUserFiles, photoBase64, templateId, sessionToken, uiLanguage, uiLanguageName } = body;
  const template = resolveTemplate(templateId);
  messages = Array.isArray(messages) ? messages.slice() : [];
  if (!messages.length || messages[0].role !== 'system') {
    // uiLanguageName (e.g. "አማርኛ (Amharic)") comes from cv.html's own i18n
    // dictionary — see CVI18n.NAMES there — so the model gets a real language
    // name, not a bare two-letter code. Falls back to English if the client
    // didn't send one (older cached page, or uiLanguage === 'en').
    const convLanguage = (uiLanguage && uiLanguage !== 'en' && uiLanguageName) ? uiLanguageName : 'English';
    messages.unshift({ role: 'system', content: buildSystemPrompt(template.name, convLanguage, !!template.mod.noPhoto) });
  }

  // ── Log-in + "can they even start this turn?" — BEFORE any file is read
  // or anything is sent to the AI gateway. Per the product rule, this is a
  // 0-balance gate only (any balance above 0 may start a turn) — see the
  // BILLING note at the top of this file for why this feature can't hold
  // results back the way the single-call AI functions do.
  let db, user;
  try {
    db = await getDb();
    user = await authenticate(db, body.userId, sessionToken);
    assertCanStart(user);
  } catch (e) {
    return errorResponse(e, 'Something went wrong. Please try again.');
  }

  // Running totals of what the AI gateway used during this turn.
  let usedCost = 0, usedPrompt = 0, usedCompletion = 0;
  let charged = false;
  async function chargeOnce() {
    if (charged) return null;
    charged = true;
    return deductTokens(db, body.userId, usedCost, { feature: 'CV_CHAT', model: FEATURE_MODELS.CV_CHAT, promptTokens: usedPrompt, completionTokens: usedCompletion });
  }

  // Files that couldn't be read this turn — sent back to cv.html, which shows
  // them in a box with a Retry button. `index` is the position in newUserFiles
  // (so the client can find the original file data again).
  const unreadFiles = [];

  // Any attached file is turned into text FIRST (the chat loop itself is
  // text-only) and folded into the user's message as clearly-labelled
  // extracted text.
  //  - Files cv.html already read arrive as extractedText (or as a readError
  //    if the browser tried and failed) — nothing more to do for those.
  //  - Files in the old shape (base64 / pages) are still read here, ONE AT A
  //    TIME (avoids hitting the gateway with several simultaneous requests),
  //    under a total time budget so a slow batch can't use up the function's
  //    whole time limit before the chat model runs. This budget is now
  //    small and shares the same wall-clock deadline as the chat loop below
  //    (see HANDLER_DEADLINE_MS) — see the note at the top of the file.
  //  - At most MAX_FILES_PER_TURN files are read; the rest are flagged so the
  //    user can retry them.
  //  - Text is capped per file and in total (see LIMITS above).
  //  - Vision token usage/cost is added to this turn's billing totals.
  if (newUserText || (newUserFiles && newUserFiles.length)) {
    let combinedText = newUserText || '';
    const allFiles = Array.isArray(newUserFiles) ? newUserFiles : [];
    const toRead  = allFiles.slice(0, MAX_FILES_PER_TURN);
    const skipped = allFiles.slice(MAX_FILES_PER_TURN);

    // In the order attached. Stops starting new files once EITHER the local
    // extraction budget OR the whole-handler deadline is spent, whichever is
    // tighter — the chat loop still needs real time left after this.
    const results = [];
    const extractStart = Date.now();
    // Real phase, not a guess: only fires when at least one file genuinely
    // still needs server-side reading (most arrive already extracted by
    // cv.html — see the FIX note near the top of this file).
    if (toRead.some(f => !(f && (typeof f.extractedText === 'string' || f.readError)))) {
      emitPhase('reading_files');
    }
    for (const f of toRead) {
      // Already read in the browser — use it as is.
      if (f && typeof f.extractedText === 'string') {
        const t = f.extractedText.trim();
        results.push(t
          ? { text: t, usage: null, cost: 0 }
          : unread('[This file has no readable text. Please describe its contents in your message instead.]', 'No readable text', false));
        continue;
      }
      // The browser tried to read it and failed — list it as not read so the user gets the Retry box.
      if (f && f.readError) {
        results.push(unread('[NOT READ: ' + f.readError + ']', f.readError, f.readRetryable !== false));
        continue;
      }

      const localLeft  = EXTRACTION_TIME_BUDGET_MS - (Date.now() - extractStart);
      // Keep enough of the whole-handler deadline free for the chat loop —
      // never let file extraction eat into that reserve.
      const globalLeft = timeLeft(handlerStarted) - MIN_TIME_TO_START_CHAT_CALL_MS;
      const left = Math.min(localLeft, globalLeft);
      if (left <= 1200) {
        results.push(unread('[NOT READ: ran out of time reading the earlier files.]', 'Ran out of time', true));
        continue;
      }
      results.push(await extractDocumentText(f, Math.min(MAX_SINGLE_VISION_CALL_MS, left)));
    }

    let charsLeft = MAX_CHARS_TOTAL;
    results.forEach((r, i) => {
      const f = toRead[i];
      if (r.usage) {
        const pt = r.usage.prompt_tokens || 0, ct = r.usage.completion_tokens || 0;
        usedPrompt     += pt;
        usedCompletion += ct;
      }
      usedCost += r.cost || 0;
      let text;
      if (charsLeft <= 0) {
        text = '[NOT READ: the files above already used up the text limit for this message.]';
        unreadFiles.push({ index: i, filename: f.filename || 'File', reason: 'Message size limit', retryable: true });
      } else {
        if (r.failed) {
          unreadFiles.push({ index: i, filename: f.filename || 'File', reason: r.reason || "Couldn't be read", retryable: !!r.retryable });
        }
        text = clipText(r.text, Math.min(MAX_CHARS_PER_FILE, charsLeft), f.filename || 'This file');
        charsLeft -= text.length;
      }
      combinedText += `\n\n[Attached file: ${f.filename}]\n${text}`;
    });

    skipped.forEach((f, k) => {
      combinedText += `\n\n[Attached file: ${f.filename}]\n[NOT READ: only the first ${MAX_FILES_PER_TURN} files per message are read.]`;
      unreadFiles.push({ index: MAX_FILES_PER_TURN + k, filename: f.filename || 'File', reason: 'Over the file limit', retryable: true });
    });

    // Tell the model which files were missed and how to advise the user. This
    // note is part of the conversation, so it also works for sessions that
    // started with an older system prompt.
    if (unreadFiles.length) {
      const names = unreadFiles.map(u => u.filename).join(', ');
      const canRetry = unreadFiles.some(u => u.retryable);
      const cannotRetry = unreadFiles.filter(u => !u.retryable).map(u => u.filename);
      combinedText += `\n\n[System note, not from the user: these files could NOT be read: ${names}.` +
        (canRetry ? ` The app shows the user a box with a Retry button under your next reply; it reads only the unread files and keeps everything already read, so never ask the user to re-upload or resend them.` : '') +
        ` Say plainly which file names were not read. Then judge: if what WAS read already gives enough to build a good CV, say the missing files probably aren't essential and suggest continuing with what you have (Retry stays available if they change their mind). If the missing files likely hold key information (e.g. the only transcript or an old CV), recommend pressing Retry first.` +
        (cannotRetry.length ? ` These cannot be read even on retry (${cannotRetry.join(', ')}): ask the user to describe what's in them if it matters.` : '') +
        ` Keep this to one or two sentences and never guess what an unread file contains.]`;
    }

    messages.push({ role: 'user', content: combinedText.trim() || '(no message)' });
  }

  let finalPdfBase64 = null;
  let telegramDelivered = null; // null = no PDF rendered this turn; true/false once one is
  let awaitingPhoto = false;

  // If extraction alone already ate almost the whole deadline, don't even
  // attempt an AI chat call — the function would very likely run out of its
  // 60s execution ceiling mid-call, which is worse than returning a clean
  // "try again" reply now. This is the main safeguard for HANDLER_DEADLINE_MS.
  // NOTE: the two needsContinue `reply` strings below (here and further down
  // in the tool loop) are deliberately fixed, plain English — they're not
  // generated by the model, so they can't naturally pick up the user's
  // language the way a normal assistant reply does. cv.html translates them
  // client-side (same 'translateUI' mechanism as the Telegram notice box)
  // before showing the Continue box, so don't bake another language into
  // them here.
  if (timeLeft(handlerStarted) < MIN_TIME_TO_START_CHAT_CALL_MS) {
    const tokenBalance = await chargeOnce();
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        reply: "That took a bit long to process on this end — nothing was lost.",
        needsContinue: true, // tells cv.html to show a "Continue" button instead of treating this as a normal finished reply
        messages, finalPdfBase64, telegramDelivered, awaitingPhoto,
        tokensUsed: usedCost, tokenBalance, unreadFiles
      })
    };
  }

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // Wall-clock check before every AI call — this is what actually keeps
      // the whole handler under its 60s execution ceiling (HANDLER_DEADLINE_MS).
      // This check stops a NEW call from starting; it cannot interrupt one
      // already in flight.
      const timeLeftForCall = timeLeft(handlerStarted);
      if (timeLeftForCall < MIN_TIME_TO_START_CHAT_CALL_MS) {
        const tokenBalance = await chargeOnce();
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            reply: "I've made some progress, but didn't finish this step.",
            needsContinue: true, // tells cv.html to show a "Continue" button instead of treating this as a normal finished reply
            messages, finalPdfBase64, telegramDelivered, awaitingPhoto,
            tokensUsed: usedCost, tokenBalance, unreadFiles
          })
        };
      }

      emitPhase('thinking'); // real: about to call the chat model itself
      const result = await callAI({
        model: FEATURE_MODELS.CV_CHAT,
        messages, maxTokens: 2000, tools: toolsFor(template), toolChoice: 'auto',
        timeoutMs: Math.max(3000, timeLeftForCall - 500),
        attempts: 2
      });
      usedCost       += result.cost;
      usedPrompt     += (result.usage && result.usage.prompt_tokens)     || 0;
      usedCompletion += (result.usage && result.usage.completion_tokens) || 0;

      const msg = result.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.some(tc => tc.function.name === 'request_photo_upload')) awaitingPhoto = true;

      if (toolCalls.length === 0) {
        // The model can legitimately come back with NO text and NO tool call
        // — most often after it's just been handed a file with no question
        // attached, where it has nothing obvious to say or do next. That's a
        // real, if uncommon, model response shape, not a bug in this code —
        // but forwarding an empty string as the "reply" left the user
        // staring at a blank message (cv.html showed it as the placeholder
        // "(no reply)"), which looks broken and gives no next step. Substitute
        // one clear, honest fallback whenever that happens, here at the
        // source, so every surface that reads this response (cv.html, the
        // Telegram bot) gets something a user can act on instead of silence.
        // Deliberately NOT an open question like "what would you like me to
        // do next?" — that puts the decision back on a user who often has no
        // idea what comes next in building a CV, which is the opposite of
        // the "you're the expert, drive this forward" instruction given in
        // the system prompt above. This just nudges the conversation along.
        const replyText = (msg.content && msg.content.trim())
          ? msg.content
          : "Got it, thanks — let's keep going with your CV.";
        const tokenBalance = await chargeOnce();
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, reply: replyText, messages, finalPdfBase64, telegramDelivered, awaitingPhoto, tokensUsed: usedCost, tokenBalance, unreadFiles })
        };
      }

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave as {} */ }

        // Real, per-tool phase signal — emitted right before the tool that
        // actually does that work runs, not a guess. check_template_fit is
        // the real layout/organizing pass, polish_review_text is a separate
        // billed AI call that rewrites the content into final review text,
        // and finalize_pdf is the real render-and-deliver step. Any other
        // tool (e.g. request_photo_upload) doesn't match one of the shown
        // phases, so it's left alone — the indicator just stays on
        // whatever real phase was last shown.
        if (tc.function.name === 'check_template_fit') emitPhase('organizing');
        else if (tc.function.name === 'polish_review_text') emitPhase('polishing');
        else if (tc.function.name === 'finalize_pdf') emitPhase('presenting_file');

        const toolResult = await callTool(tc.function.name, args, template.mod.noPhoto ? null : photoBase64, templateId, body.userId);

        // polish_review_text makes its own billed AI call (Claude 5.5 Sonnet)
        // — add its real cost/usage to this turn's running totals, same as
        // the main chat-loop call above.
        if (tc.function.name === 'polish_review_text' && toolResult && toolResult.ok) {
          usedCost       += toolResult.cost || 0;
          usedPrompt     += (toolResult.usage && toolResult.usage.prompt_tokens)     || 0;
          usedCompletion += (toolResult.usage && toolResult.usage.completion_tokens) || 0;
        }

        let toolContent;
        if (toolResult && toolResult.pdfBase64) {
          finalPdfBase64 = toolResult.pdfBase64;
          telegramDelivered = !!toolResult.telegramDelivered;
          // Don't send the full PDF back into the model's context — just
          // confirm success, to avoid burning tokens on binary data.
          const deliveryNote = toolResult.telegramDelivered
            ? "It has already been sent to the user as a file in this Telegram chat — do not re-describe the raw PDF, just comment on it conversationally and tell them to check the chat for the file."
            : "The file could NOT be delivered to the user's Telegram chat automatically (Telegram may not be linked yet). Let the user know their CV was generated but couldn't be delivered, and suggest they link their Telegram account with the bot, then ask you to render again.";
          toolContent = JSON.stringify({ ok: toolResult.ok, kind: toolResult.kind, message: toolResult.ok ? deliveryNote : toolResult.error });
        } else {
          toolContent = JSON.stringify(toolResult);
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
      }
    }

    const tokenBalance = await chargeOnce();
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, reply: "I've done several steps in a row — let me know if you'd like me to continue.", messages, finalPdfBase64, telegramDelivered, awaitingPhoto, tokensUsed: usedCost, tokenBalance, unreadFiles })
    };

  } catch (error) {
    console.error('cv-chat error:', error);
    // Whatever the AI gateway already used before the failure was real work —
    // charge for it (a failed call itself is never charged, because it
    // returned no usage).
    let tokenBalance = null;
    try { tokenBalance = await chargeOnce(); } catch (e) { console.error('cv-chat: charge after error failed:', e.message); }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Something went wrong while building your CV. Please try again.', tokenBalance })
    };
  }
}

// ── LIVE PHASE STREAMING ───────────────────────────────────────────────────
// cv.html shows a small "... Thinking / Organizing / Polishing / Presenting
// file" indicator while a turn is in flight. This used to be a client-side
// timer cycling through those labels on a guess — now it's a real readout:
// runTurn() above calls emitPhase() at the actual moments each of those
// things happens (see the calls inside the file-reading loop and the tool
// loop), and this wrapper turns each call into one Server-Sent Event the
// browser reads live, before the turn has finished.
//
// The SSE stream carries two kinds of events:
//   event: phase   data: {"phase":"thinking"}          — zero or more, live
//   event: result  data: {"status":200,"body":"..."}    — always exactly one,
//                                                          last, then closes
// `body` in the result event is the EXACT SAME JSON string runTurn() always
// returned — nothing about the response shape changed, only how/when the
// browser learns about it. cv.html reads the stream and parses that same
// JSON once the result event arrives (see performTurn() there).
function sseEncode(eventName, dataObj) {
  return `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

// ── Heartbeat ──────────────────────────────────────────────────────────────
// Real phase events only fire at a handful of specific moments (reading a
// file, starting the chat model, calling a tool) — between them, especially
// during one single slow AI call, this connection can sit with NO bytes
// flowing for 10-30+ seconds. Mobile networks, NAT routers, and in-app
// browsers (Telegram's WebView included) commonly treat a connection that's
// gone quiet that long as dead and silently drop it — this is a routine,
// expected failure mode for any long-held streaming connection, not a sign
// of a bad connection on the user's end. A heartbeat line keeps real bytes
// moving the whole time so nothing in between ever sees "idle" long enough
// to kill it. ": " starts an SSE *comment* line — valid per the SSE spec,
// completely ignored by any correct parser (including fetchCvChatStream in
// cv.html, which only reacts to lines starting with "event:"/"data:") — so
// this is invisible to the app and exists purely to keep the pipe open.
const HEARTBEAT_INTERVAL_MS = 8000;

export default async (req, context) => {
  const encoder = new TextEncoder();
  // Adapts the Web standard Request into the same {httpMethod, body} shape
  // runTurn() has always read — so runTurn()'s own body never had to change.
  const event = { httpMethod: req.method, body: await req.text() };

  const stream = new ReadableStream({
    async start(controller) {
      const emitPhase = (phase) => {
        try { controller.enqueue(encoder.encode(sseEncode('phase', { phase }))); }
        catch (e) { /* stream already closed (client navigated away) — nothing to do */ }
      };

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')); }
        catch (e) { /* stream already closed — stop trying */ clearInterval(heartbeat); }
      }, HEARTBEAT_INTERVAL_MS);

      let result;
      try {
        result = await runTurn(event, emitPhase);
      } catch (e) {
        // runTurn() already catches everything itself and returns a 500 —
        // this is only a last-resort net in case something throws before
        // that try/catch is even reached (e.g. the Request body read above).
        console.error('cv-chat streaming wrapper: unexpected error:', e);
        result = { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
      } finally {
        clearInterval(heartbeat);
      }
      try {
        controller.enqueue(encoder.encode(sseEncode('result', { status: result.statusCode, body: result.body })));
      } catch (e) { /* stream already closed — nothing to do */ }
      controller.close();
    }
  });

  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
};