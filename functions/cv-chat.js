// functions/cv-chat.js
//
// POST body: { userId, sessionToken, messages: [...], newUserText?: string,
//              newUserFiles?: [{filename, mediaType, base64}], photoBase64?: string }
//
// This is the backend for "CVCase" — a conversational AI that builds a CV
// with the user, one message at a time. The client keeps the full message
// history and re-sends it every turn (this function is stateless).
//
// ── NETLIFY FREE PLAN TIME LIMIT — READ THIS FIRST ────────────────────────
// Netlify's free plan runs synchronous Functions with a HARD 10-second
// execution ceiling (the 26s+ window is Pro-only). This function does TWO
// time-hungry things in sequence — (1) a file-extraction fallback step, then
// (2) a tool-use loop that can call DeepSeek up to MAX_TOOL_ITERATIONS times,
// each one a full network round trip — and the old budgets (15s just for
// extraction, with no cap at all on the loop's own time) could never fit in
// 10s together. When Netlify killed the function mid-loop, the user lost the
// whole turn with no clean error and — worse — with no guarantee of which
// DeepSeek calls had already been billed.
//
// Two changes fix this:
//   1. EXTRACTION_TIME_BUDGET_MS is cut down a lot (see below). In normal
//      operation this fallback path barely runs anyway, because cv.html now
//      reads images/PDFs via extract-file.js BEFORE calling this function —
//      see the "FIX: files are now read BEFORE this function is called" note
//      further down. This budget only matters for the old-shape fallback.
//   2. A single HANDLER_DEADLINE_MS wall-clock budget now wraps the WHOLE
//      handler. Before extraction starts, and before every single DeepSeek
//      call inside the tool loop, the code checks how much real time is
//      left. If there isn't enough left to safely attempt another call, it
//      stops on its own — charges for whatever was actually used, and
//      returns a normal, clean reply asking the user to send another
//      message to continue — instead of letting Netlify hard-kill the
//      function mid-call.
//
// This does mean a genuinely complex turn (lots of files + several tool
// calls) may now take 2-3 user messages instead of 1 on the free plan. That
// trade-off is unavoidable on a 10s ceiling — the alternative is what you
// had before (silent failures). If you upgrade to a paid Netlify plan with a
// longer timeout, raise HANDLER_DEADLINE_MS and EXTRACTION_TIME_BUDGET_MS
// back up and most turns will go back to finishing in one shot.
//
// ⚠️ ONE THING THIS FILE CANNOT FIX ON ITS OWN: callDeepSeek() itself (in
// lib/ai-billing.js) isn't shown here, so I don't know whether its own HTTP
// call has a timeout, and if so, how long. If it has no timeout (or a long
// one, e.g. 20-30s), a single slow DeepSeek response can still blow past
// Netlify's 10s limit on its own, regardless of the deadline checks added
// below — those checks only stop a NEW call from starting, they can't
// interrupt one already in flight. If you want this fully airtight, share
// lib/ai-billing.js so callDeepSeek's own request timeout can be capped to
// fit whatever time is left (the loop below already computes that number —
// see `timeLeftForCall` — it just isn't passed anywhere yet).
//
// ── BILLING (CT tokens) ──────────────────────────────────────────────────
// The body must include `sessionToken` (issued at login by verify-otp.js or
// telegram-auth.js — see lib/session.js; this replaces the old password
// field everywhere in the app). Every DeepSeek chat call made during a turn
// reports its real token usage; they are added up and the total is deducted
// from the user's CT balance once the turn finishes (see lib/ai-billing.js).
// The reply includes `tokensUsed` and `tokenBalance` so the app can update
// the balance on screen. If the user doesn't have enough CT to start a turn,
// nothing is sent to DeepSeek and a 402 { code:'INSUFFICIENT_TOKENS' } is
// returned.
// Reading uploaded files/photos (DeepSeek vision for images, pdf-parse for
// PDFs — see extractDocumentText() below) is NOT billed in CT — only the
// DeepSeek chat-loop tokens are.
//
// ── MODEL: DeepSeek (deepseek-chat), not Claude ──────────────────────────
// This file was switched from the Anthropic API to DeepSeek's
// OpenAI-compatible chat-completions API. Two consequences that matter:
//
//   1. Message/tool format is now OpenAI-style (role/content, tool_calls,
//      role:'tool' results) instead of Anthropic's content-block format.
//      Any CV session saved in the browser BEFORE this change is in the
//      old format and will not resume correctly — start a fresh session
//      after deploying this.
//
//   2. The main conversation/tool loop (callDeepSeek) is TEXT-ONLY — it
//      never receives a raw image or PDF. Uploaded files are converted to
//      text first, in extractDocumentText():
//        - images  → DeepSeek vision (same model/endpoint shape used by
//                    extract-payment-screenshot.js)
//        - PDFs    → pdf-parse (text PDFs; DeepSeek can't take a PDF as input)
//        - scanned PDFs → cv.html detects these with PDF.js, draws the first
//                    pages to images and sends them as file.pages (no PDF);
//                    each page image is then read with DeepSeek vision
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
//      the finished PDF.
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
// contact field (phone/email/location) or reference field as simply
// absent, never drawing an orphan label for it; and (c) compute language
// proficiency bars from each language's own `level` text via
// proficiencyToFill() in cv-shared.js, instead of guessing from array
// position. The system prompt below has been updated to match — the model
// now asks about contact fields and references without assuming there's
// only ever one of the latter.

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
  'emerald-hex':    { name: 'Emerald & Gold Hexagon',  mod: require('./lib/cv-template-emerald-hex') }
};
const DEFAULT_TEMPLATE_ID = 'minimal';

function resolveTemplate(templateId) {
  return TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE_ID];
}
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { sendPdfDocument } = require('./lib/telegram-send');

const {
  callDeepSeek, getDb, authenticate, assertCanAfford, estimateTokens, estimateMessagesTokens,
  deductTokens, errorResponse
} = require('./lib/ai-billing');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MAX_TOOL_ITERATIONS = 6; // safety cap on the internal tool loop — see HANDLER_DEADLINE_MS below for the real, time-based cap

// ── Whole-handler wall-clock deadline — MUST fit inside Netlify's free-plan
// 10s cap ─────────────────────────────────────────────────────────────────
// This is the actual guard against Netlify hard-killing the function mid
// tool-loop. It is checked (a) once before the extraction fallback runs and
// (b) before every single DeepSeek call inside the tool loop. If too little
// time is left to safely start another call, the code stops itself, bills
// for whatever was genuinely used, and returns a normal reply asking the
// user to continue — instead of letting the platform kill it mid-request.
//
// 8500ms leaves ~1.5s of margin inside Netlify's 10s free-plan ceiling for
// JSON parsing, response serialization, and general runtime jitter. Raise
// this (e.g. to ~24000 on a 26s paid-plan timeout) if you upgrade.
const HANDLER_DEADLINE_MS = 8500;
// Don't even start a DeepSeek chat-loop call with less than this much time
// left — a deepseek-chat call realistically needs at least this long to
// have a chance of finishing instead of being cut off mid-stream.
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

function buildSystemPrompt(templateName) {
  return `You are "CVCase", a friendly, efficient AI that builds a professional one-page CV with the user through conversation, using the "${templateName}" template — this is the ONE template for this whole conversation; the user already picked it in the gallery before you started talking, so never ask them to choose a template again.

## Your job, step by step
1. Greet the user briefly and ask them to describe themselves OR upload documents (certificates, transcripts, old CV) — either is fine. Any document or image the user attaches has ALREADY been read for you and appears in the conversation as extracted text labelled with its filename — read that text as the source of information, you never see the raw file yourself.
   - If a file could NOT be read, it appears as "[NOT READ: ...]" (or "[Could not read this file.]") under its filename, followed by a system note. The app shows the user a box with a Retry button for those files, so never ask them to re-upload or resend them. Name the unread files, then decide: if what was read is already enough to build a good CV, say the missing files probably aren't essential and suggest continuing; if they likely hold key information, recommend pressing Retry first. Never guess what an unread file contains.
   - NEVER "correct", normalize, or substitute a person's name (or any other proper noun — a school, an organization, a place) based on what name you think it's "probably supposed to be". The extracted text is a raw, sometimes imperfect reading of a photo — treat it as exactly that: a reading, not a hint. If the same name appears to read differently across files, quote EXACTLY what the extracted text shows for each file (verbatim, including any odd characters) and simply ask the user: "Your name reads differently across these — which is your correct full name?" Do NOT propose alternate spellings or similar-sounding real names of your own (e.g. turning a garbled fragment into a common name you know) — that is inventing a fact, not reading one, and a wrong name on someone's CV is a serious, real-world mistake. The user typing their own name is always the source of truth, not your best guess at what the scan "probably" says.
2. Build a content object matching this exact schema:
   {
     name, subtitle, contact: {phone,email,location},
     education: {degree,school,extra},
     languages: [{name,level}],   // level is a free-text proficiency label — see note below
     profile, skills: [string], 
     experience: [{org,role,dateRange,bullets:[string]}],
     achievements: [string], certifications: [{title,issuer}],
     references: [{name,role,email,phone}],   // 0, 1, 2, 3+ entries — see note below
     customSections: [{title, placement, items, text}]   // extra sections the user asks for — see note below
   }
   Every field in contact and in each item of references is OPTIONAL — omit a key entirely if the user doesn't have it (e.g. contact: {email: "..."} with no phone/location is valid). Never fill a missing field with a placeholder like "N/A" or an empty string — the renderer already knows to skip a field that isn't there, so a placeholder would be the only thing that actually shows up wrong. languages[].level should be a plain proficiency word the renderer can read a fill-bar amount from (e.g. "Native", "Fluent", "Advanced", "Intermediate", "Basic") — use the label the user actually gave you, don't invent a different scale.
   - subtitle is the person's professional title (e.g. "Software Engineer", "Marketing Specialist", "Recent Graduate — Computer Science"). Several templates display this as ONE line in a fixed-width banner, so keep it genuinely short — aim for 2-4 words and well under 40 characters. If what the user describes is naturally longer (a dual title, a long specialization), pick the most important part or shorten the phrasing yourself rather than passing the long version through — the templates will shrink an oversized title as a last resort, but a title you kept short in the first place always looks better than one that had to be shrunk or, in an extreme case, cut off.
   - customSections: use this whenever the user wants a section that isn't in the fixed schema above — e.g. "Add an Academic Projects section", "Add Volunteering", "Add Interests". Each entry is { title, placement: "sidebar" | "main", items?: [string], text?: string }. Give it EITHER items (a short bullet list — use this for anything list-like: project names, tools used, hobbies) OR text (one paragraph — use this for something more narrative/descriptive), not both. Decide placement yourself based on the content and available space, the same way you'd judge any other section:
     - The sidebar (where Education/Skills/Languages live) suits short, scannable entries — a handful of one-line items, not paragraphs. Prefer placement:"sidebar" for compact lists like tools, interests, or a short project list.
     - The main column (where Experience/Achievements/Certifications live) suits longer or more detailed entries — a project with a description, multiple bullet points, or a paragraph. Prefer placement:"main" for anything with real detail.
     - Whichever you pick, ALWAYS call check_template_fit with the content object that includes the new customSections entry before telling the user it's been added — the renderer wraps everything to the real column width automatically (so long items can't run off the page or off the sidebar), but fit (whether the page still has room at all) is only ever something check_template_fit's numbers can tell you, never your own guess. If it doesn't fit, follow the same "give one specific, confident recommendation" rule as any other overflow case (see below) — a custom section is exactly the kind of thing that's reasonable to suggest trimming first, since it's an extra the user chose to add on top of the base CV.
3. If a section is thin or missing (e.g. no experience, no skills), do NOT just leave it empty and do NOT interrogate the user with a long form. Ask ONE short, friendly question at a time, offering an easy way out — e.g. "Have you done any internship, volunteer work, or class project? If not, no worries, I can suggest some based on your field." If they still have nothing, propose 3-5 common, reasonable skills/achievements for their field of study as SUGGESTIONS ONLY, clearly labeled as suggestions, and ask them to confirm/edit before including them. NEVER silently invent facts (like a specific employer, degree, or grade) — only suggest generic, clearly-labeled filler for skills/soft-skills, never for verifiable facts.
   - Contact details: ask for phone, email, and location together in one friendly question, but don't insist on all three — if the user only has one or two, that's completely fine, just leave the others out of contact rather than asking again or inventing something.
   - References: ask if they'd like to include a reference, and if so how many (most CVs list 1-3). Collect each one's name/role/email/phone the same way — one short, friendly question at a time, not a long form — and put all of them in the references array in the order given. If the user has none, use an empty array and move on without pushing back.
4. Before you EVER tell the user their CV "fits" or "is too long", call check_template_fit with your current best content object. Trust ONLY its numbers — never estimate this yourself.
   - The renderer automatically tries space-saving layout techniques (like packing skills onto fewer lines) BEFORE reporting overflow — so if check_template_fit or finalize_pdf returns fits:true, the content already fits with no changes needed from the user, even if the layout looks slightly denser than before. Never ask the user to cut anything in this case.
   - If it reports real overflow (fits:false) after those automatic techniques were already tried: do NOT ask an open-ended question like "what would you like to remove?". Instead, look at the result's "recommendation" field (or, if finalize_pdf failed with an error, its message) and give the user ONE specific, confident recommendation — name the exact section and roughly how much to cut, e.g. "Your Experience section is the longest part — I'd suggest shortening the Acme Corp bullets from 4 to 2, focusing on your biggest wins. Want me to do that?" Propose the cut, don't just describe the problem.
   - If finalize_pdf itself fails with an error whose message says content is too long even at maximum compaction (this happens when the content is genuinely too much for one page, not just a close call): treat this as a hard limit, not a suggestion. Clearly tell the user this specific template can't fit everything they've given you no matter how it's laid out, give them the same specific, confident recommendation from the error message, and don't attempt to render again until the content has actually been shortened — retrying with the same content will fail the same way.
   - If the user pushes back on your recommendation and insists on keeping everything, you can offer them one alternative (e.g. a different section to trim instead, or suggest switching to a template with more room) — but don't keep proposing vague options back and forth; make a clear call and act on it once they've responded once.
5. Once check_template_fit confirms the content fits, show the user the ORGANIZED CONTENT ITSELF as plain, readable chat text — section by section (Profile, Experience, Skills, etc.) — so they can review the actual wording before any file is ever produced. This is NOT a PDF and NOT a preview file — it is just you typing the CV's content back to them in the chat, clearly formatted, for them to read and confirm or correct. Do not call finalize_pdf yet at this point, no matter how confident you are it fits — the user reviews the text first.
6. Once the user explicitly confirms that text looks right (or finishes correcting it and confirms), call request_photo_upload and ask them to attach their photo. Do NOT ask for a photo any earlier than this step — the app only shows the photo-cropping frame after you call this tool, so asking sooner would confuse the user. If the user has no photo or doesn't want one, that's fine — proceed without it.
7. Once the user has attached a photo (or said to skip it), call finalize_pdf with the final content object. This produces the actual, finished CV and delivers it to the user as a file in this Telegram chat — there is no separate "preview" step; this IS the real document. Tell the user it's ready and to check the chat for the file.
8. The user stays in this same chat after seeing the PDF, and may ask for changes at any point afterward (e.g. "can you reword the profile" or "add another skill"). When that happens: update just the relevant field(s), call check_template_fit again first if the edit could plausibly cause overflow (e.g. adding a paragraph or another reference), then call finalize_pdf again with the updated content object to deliver the corrected PDF. You do not need to re-show the plain-text content or re-ask for a photo for a simple edit like this — just make the change and re-render.

## Hard rules
- Never call check_template_fit or finalize_pdf without a reasonably complete content object — but never call finalize_pdf before the user has reviewed the plain-text content (step 5) and confirmed it, and before you've asked about their photo (step 6), on the FIRST render. After that first PDF, later edit requests can go straight to finalize_pdf once the change is made.
- Never call finalize_pdf without having called check_template_fit at least once on that same content first, unless the content is trivially short (e.g. a one-field edit unrelated to length) or this is a re-render after the very first PDF where fit was already recently confirmed for content of similar size.
- Never state a fit/overflow judgment without a check_template_fit tool result to back it up.
- When content doesn't fit, give ONE specific, confident recommendation (which section, roughly how much to cut) instead of an open "what should I remove?" question — you're the one who can see the numbers, act like it.
- The renderer will refuse to produce a PDF (an error, not a bad-looking file) if content is genuinely too much even at maximum compaction. Treat that refusal as final for that content — don't retry finalize_pdf with the same content expecting a different result; get the user to agree to a specific cut first.
- Never invent specific factual claims (employers, dates, grades, certificate names). Only ever suggest generic, clearly-labeled filler for skills or soft-skill phrasing.
- Keep messages short and conversational — this is a chat, not a form. This applies even to the step-5 content review: format it cleanly, but don't pad it with extra commentary.
- Never ask the user for their photo, and never treat an uploaded document's extracted text as a description of a "photo" — until AFTER you've called request_photo_upload (step 6), any attachment is a document to read for information.
- You never need to include a photoBase64 field — the app handles the photo automatically when rendering.
- The PDF is delivered to the user as a real file message in this Telegram chat, not as an in-app download link — always phrase it that way ("I've sent it to you here in the chat"), never "click download" or "open the link".
- There is only ONE kind of rendered file in this whole conversation — the finished CV PDF. Never refer to anything as a "preview" — every render is the current, real version of the finished document.`;
}

// OpenAI-style function-calling schema (DeepSeek is OpenAI-API-compatible).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_photo_upload',
      description: 'Call this ONLY once the user has explicitly confirmed the organized CV content, shown to them as plain chat text, looks right — and you are ready to ask them for their profile photo. Calling this tells the app to show the photo-cropping frame the next time the user attaches an image — before this call, any image the user sends is treated as a document, not a photo.',
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

// ── Document/photo text extraction via DeepSeek (images) + pdf-parse (PDFs) ──
// The conversation loop is text-only, so every attachment is turned into
// plain text before the model ever sees it. See the MODEL note at the
// top of this file for why PDFs and images take different paths.
//
// NOTE: cv.html now reads most files BEFORE calling this function (see the
// "files are now read BEFORE this function is called" note at the top). The
// code below is the fallback for files that arrive in the old shape
// (base64 / pages) — it is unchanged except that vision calls now retry once
// and failures give a clearer reason, AND the time budgets are now small
// enough to fit alongside the chat loop inside Netlify's free-plan 10s cap
// (see HANDLER_DEADLINE_MS above and EXTRACTION_TIME_BUDGET_MS below).
//
// ── LIMITS (why they exist) ──────────────────────────────────────────────
// Extracted text is pasted into the conversation, and the WHOLE conversation
// is re-sent to DeepSeek (and billed as prompt tokens) on every later turn.
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
// leave real room for the chat loop afterward inside the same 10s Netlify
// free-plan ceiling. 4s here + MIN_TIME_TO_START_CHAT_CALL_MS (3s) + margin
// is deliberately tight — this path should rarely run at all in normal
// operation (see the note above), so it's fine for it to be strict and fail
// fast (flagging files as "ran out of time, press Retry") rather than eat
// into the chat loop's budget.
const EXTRACTION_TIME_BUDGET_MS = 4000;
// Cap on any single vision call made from inside this fallback path —
// smaller than before so one slow image can't eat the whole extraction
// budget by itself.
const MAX_SINGLE_VISION_CALL_MS = 4000;

const DEEPSEEK_VISION_MODEL = 'deepseek-flash'; // same model extract-payment-screenshot.js uses

const EXTRACT_PROMPT = 'Extract all readable text from this document/image (certificate, transcript, CV, ID, etc). Reply with the plain extracted text only — no commentary, no markdown formatting, no summary. If it is a certificate or award, include the recipient name, the title/subject, the issuing body, and any date exactly as written. TRANSCRIBE LITERALLY: this applies above all to names of people, schools, and organizations. Do not "clean up", autocorrect, or substitute a name for a more common/familiar-looking one, even if a word looks unusual or you suspect it is probably a well-known name spelled differently. Copy exactly the characters you can make out. If part of a word or name is genuinely illegible, write it as-is with [?] immediately after the unclear part rather than guessing a plausible replacement — never silently swap in a different, more common name.';

const UNREADABLE_FILE_MSG = '[Could not read this file.]';

// Result for a file that could NOT be read. `reason` is a short label shown
// to the user in cv.html's "couldn't be read" box; `retryable` says whether
// pressing Retry could plausibly succeed (false for things like "too large"
// or "no text inside", where reading it again would fail the same way).
function unread(text, reason, retryable) {
  return { text, usage: null, failed: true, reason, retryable };
}

// Cuts text to `limit` characters and tells the model (and so the user) it
// was cut, instead of silently dropping the rest.
function clipText(text, limit, label) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n[...${label} was cut short: only the first ${limit} characters were kept.]`;
}

// Turns DeepSeek vision token usage into CT. Images are the ONLY extraction
// step that calls a paid API (pdf-parse runs locally and is free — the PDF's
// text is billed anyway, as prompt tokens, when it goes through the chat loop).
//
// >>> This must use the SAME pricing formula callDeepSeek() uses inside
// >>> lib/ai-billing.js so image reads are charged at the real rate. Replace
// >>> the body below with that formula (or a call to a helper exported from
// >>> ai-billing.js). Until then it returns 0, meaning image reads are not
// >>> yet charged — the token counts ARE still recorded in the billing log.
function extractionCostCT(usage) {
  return 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One DeepSeek vision call on one image. Returns { text, usage }.
// Errors are tagged `transient` when trying again could plausibly work
// (rate limit, server error, timeout, network) so callers can tell a busy
// service apart from a bad file.
async function visionRead(base64, mime, timeoutMs) {
  let res;
  try {
    res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      body: JSON.stringify({
        model: DEEPSEEK_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
          ]
        }]
      }),
      signal: AbortSignal.timeout(timeoutMs || MAX_SINGLE_VISION_CALL_MS)
    });
  } catch (e) {
    const err = new Error('DeepSeek request failed: ' + e.message);
    err.transient = true; // timeout or network problem
    throw err;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 200)}`);
    err.transient = res.status === 429 || res.status === 408 || res.status >= 500;
    throw err;
  }

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return { text: String(text || '').trim(), usage: data.usage || null };
}

// A single attempt only (no in-function retry) — the overall extraction
// budget is now too tight on the free plan to afford both a retry AND
// leaving the chat loop enough time to run. A transient failure here just
// gets reported as "retryable" so the user's existing Retry-box flow (see
// cv.html) handles it on the next turn instead.
async function visionReadWithRetry(base64, mime, timeoutMs) {
  return await visionRead(base64, mime, Math.min(timeoutMs || MAX_SINGLE_VISION_CALL_MS, MAX_SINGLE_VISION_CALL_MS));
}

// Returns { text, usage } — usage is DeepSeek's reported token usage for this
// file (null when no API call was made, e.g. text PDFs and Word files).
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
      let pt = 0, ct = 0;
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
        res.usage = usage; // tokens were still spent
        return res;
      }
      return { text: parts.join('\n\n'), usage };
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
      return { text, usage: null };
    }

    // Text PDFs: DeepSeek can't take a PDF as input, so read the text layer directly.
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
      return { text, usage: null };
    }

    // Images: DeepSeek vision
    if (mime.startsWith('image/')) {
      const r = await visionReadWithRetry(file.base64, mime, Math.min(MAX_SINGLE_VISION_CALL_MS, budget));
      if (!r.text) {
        const res = unread(UNREADABLE_FILE_MSG, "Couldn't be read", true);
        res.usage = r.usage; // tokens were still spent
        return res;
      }
      return { text: r.text, usage: r.usage };
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
    if (name === 'finalize_pdf') {
      const buf = await template.render(withPhoto(args.content, latestPhotoBase64));
      const filename = 'CV_Final.pdf';
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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const handlerStarted = Date.now(); // wall-clock anchor for HANDLER_DEADLINE_MS — see note at top of file

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!DEEPSEEK_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'DEEPSEEK_API_KEY is not configured on the server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Real enforcement — see the CV_DEV_ALLOWED_USER_ID comment above.
  if (body.userId !== CV_DEV_ALLOWED_USER_ID) {
    return { statusCode: 403, body: JSON.stringify({ error: 'CV Builder is not available yet.' }) };
  }

  let { messages, newUserText, newUserFiles, photoBase64, templateId, sessionToken } = body;
  const template = resolveTemplate(templateId);
  messages = Array.isArray(messages) ? messages.slice() : [];
  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: buildSystemPrompt(template.name) });
  }

  // ── Log-in + "can they afford to start this turn?" — BEFORE any file is
  // read or anything is sent to DeepSeek.
  let db, user;
  try {
    db = await getDb();
    user = await authenticate(db, body.userId, sessionToken);
    assertCanAfford(user, estimateMessagesTokens(messages) + estimateTokens(newUserText));
  } catch (e) {
    return errorResponse(e, 'Something went wrong. Please try again.');
  }

  // Running totals of what DeepSeek used during this turn.
  let usedCost = 0, usedPrompt = 0, usedCompletion = 0;
  let charged = false;
  async function chargeOnce() {
    if (charged) return null;
    charged = true;
    return deductTokens(db, body.userId, usedCost, { feature: 'cv-chat', promptTokens: usedPrompt, completionTokens: usedCompletion });
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
  //    TIME (avoids hitting DeepSeek with several simultaneous requests),
  //    under a total time budget so a slow batch can't use up the function's
  //    whole time limit before the chat model runs. This budget is now
  //    small and shares the same wall-clock deadline as the chat loop below
  //    (see HANDLER_DEADLINE_MS) — see the note at the top of the file.
  //  - At most MAX_FILES_PER_TURN files are read; the rest are flagged so the
  //    user can retry them.
  //  - Text is capped per file and in total (see LIMITS above).
  //  - Vision token usage is added to this turn's billing totals.
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
    for (const f of toRead) {
      // Already read in the browser — use it as is.
      if (f && typeof f.extractedText === 'string') {
        const t = f.extractedText.trim();
        results.push(t
          ? { text: t, usage: null }
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
        usedCost       += extractionCostCT(r.usage);
      }
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

    // The affordability check at the start only saw the typed text. Now that
    // the real extracted text is in the conversation, check again — and if the
    // user can't cover it, charge only what extraction already used and stop
    // BEFORE the (much bigger) chat-loop calls.
    try {
      assertCanAfford(user, estimateMessagesTokens(messages));
    } catch (e) {
      try { await chargeOnce(); } catch (chargeErr) { console.error('cv-chat: charge after affordability failure:', chargeErr.message); }
      return errorResponse(e, 'Something went wrong. Please try again.');
    }
  }

  let finalPdfBase64 = null;
  let telegramDelivered = null; // null = no PDF rendered this turn; true/false once one is
  let awaitingPhoto = false;

  // If extraction alone already ate almost the whole deadline, don't even
  // attempt a DeepSeek chat call — Netlify would very likely kill the
  // function mid-call, which is worse than returning a clean "try again"
  // reply now. This is the main new safeguard for the free-plan 10s cap.
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
      // Wall-clock check before every DeepSeek call — this is what actually
      // keeps the whole handler under Netlify's free-plan 10s ceiling. See
      // the note at the top of this file about callDeepSeek's own timeout
      // not being visible here; this check stops a NEW call from starting,
      // it cannot interrupt one already in flight.
      const timeLeftForCall = timeLeft(handlerStarted);
      if (timeLeftForCall < MIN_TIME_TO_START_CHAT_CALL_MS) {
        const tokenBalance = await chargeOnce();
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            reply: "I've made some progress.",
            needsContinue: true, // tells cv.html to show a "Continue" button instead of treating this as a normal finished reply
            messages, finalPdfBase64, telegramDelivered, awaitingPhoto,
            tokensUsed: usedCost, tokenBalance, unreadFiles
          })
        };
      }

      const result = await callDeepSeek({ messages, maxTokens: 2000, tools: TOOLS, toolChoice: 'auto', attempts: 2 });
      usedCost       += result.cost;
      usedPrompt     += (result.usage && result.usage.prompt_tokens)     || 0;
      usedCompletion += (result.usage && result.usage.completion_tokens) || 0;

      const msg = result.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.some(tc => tc.function.name === 'request_photo_upload')) awaitingPhoto = true;

      if (toolCalls.length === 0) {
        const tokenBalance = await chargeOnce();
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, reply: msg.content || '', messages, finalPdfBase64, telegramDelivered, awaitingPhoto, tokensUsed: usedCost, tokenBalance, unreadFiles })
        };
      }

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave as {} */ }

        const toolResult = await callTool(tc.function.name, args, photoBase64, templateId, body.userId);
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
    // Whatever DeepSeek already used before the failure was real work — charge
    // for it (a failed call itself is never charged, because it returned no usage).
    let tokenBalance = null;
    try { tokenBalance = await chargeOnce(); } catch (e) { console.error('cv-chat: charge after error failed:', e.message); }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Something went wrong while building your CV. Please try again.', tokenBalance })
    };
  }
};