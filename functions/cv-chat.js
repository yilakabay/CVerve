// functions/cv-chat.js
//
// POST body: { userId, messages: [...], newUserText?: string,
//              newUserFiles?: [{filename, mediaType, base64}], photoBase64?: string }
//
// This is the backend for "CVCase" — a conversational AI that builds a CV
// with the user, one message at a time. The client keeps the full message
// history and re-sends it every turn (this function is stateless).
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
//   2. DeepSeek's chat API is TEXT-ONLY — it cannot read an image or a PDF
//      directly the way Claude could. So any uploaded document or
//      certificate photo is first run through Gemini (already used
//      elsewhere in this app, e.g. receive-sms.js) to extract its text,
//      and DeepSeek only ever sees that extracted text, never the raw
//      file. See extractDocumentText() below.
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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { sendPdfDocument } = require('./lib/telegram-send');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat'; // DeepSeek-V3, general-purpose, supports function calling
const MAX_TOOL_ITERATIONS = 6; // safety cap on the internal tool loop

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

// ── Document/photo text extraction via Gemini (DeepSeek can't read files) ──
async function extractDocumentText(file) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });
    const result = await model.generateContent([
      { inlineData: { mimeType: file.mediaType, data: file.base64 } },
      { text: 'Extract all readable text from this document/image (certificate, transcript, CV, ID, etc). Reply with the plain extracted text only — no commentary, no markdown formatting, no summary. If it is a certificate or award, include the recipient name, the title/subject, the issuing body, and any date exactly as written.' }
    ]);
    return result.response.text().trim();
  } catch (e) {
    console.error('extractDocumentText error:', e.message);
    return '[Could not read this file — please describe its contents in your message instead.]';
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

async function callDeepSeek(messages) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages,
      tools: TOOLS,
      tool_choice: 'auto'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'DeepSeek API error');
  return data;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
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

  let { messages, newUserText, newUserFiles, photoBase64, templateId } = body;
  const template = resolveTemplate(templateId);
  messages = Array.isArray(messages) ? messages.slice() : [];
  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: buildSystemPrompt(template.name) });
  }

  // Any attached file is read via Gemini FIRST (DeepSeek is text-only) and
  // folded into the user's message as clearly-labelled extracted text.
  if (newUserText || (newUserFiles && newUserFiles.length)) {
    let combinedText = newUserText || '';
    for (const f of (newUserFiles || [])) {
      const extracted = await extractDocumentText(f);
      combinedText += `\n\n[Attached file: ${f.filename}]\n${extracted}`;
    }
    messages.push({ role: 'user', content: combinedText.trim() || '(no message)' });
  }

  let finalPdfBase64 = null;
  let telegramDelivered = null; // null = no PDF rendered this turn; true/false once one is
  let awaitingPhoto = false;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const data = await callDeepSeek(messages);
      const choice = data.choices[0];
      const msg = choice.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.some(tc => tc.function.name === 'request_photo_upload')) awaitingPhoto = true;

      if (toolCalls.length === 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, reply: msg.content || '', messages, finalPdfBase64, telegramDelivered, awaitingPhoto })
        };
      }

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave as {} */ }

        const result = await callTool(tc.function.name, args, photoBase64, templateId, body.userId);
        let toolContent;
        if (result && result.pdfBase64) {
          finalPdfBase64 = result.pdfBase64;
          telegramDelivered = !!result.telegramDelivered;
          // Don't send the full PDF back into the model's context — just
          // confirm success, to avoid burning tokens on binary data.
          const deliveryNote = result.telegramDelivered
            ? "It has already been sent to the user as a file in this Telegram chat — do not re-describe the raw PDF, just comment on it conversationally and tell them to check the chat for the file."
            : "The file could NOT be delivered to the user's Telegram chat automatically (Telegram may not be linked yet). Let the user know their CV was generated but couldn't be delivered, and suggest they link their Telegram account with the bot, then ask you to render again.";
          toolContent = JSON.stringify({ ok: result.ok, kind: result.kind, message: result.ok ? deliveryNote : result.error });
        } else {
          toolContent = JSON.stringify(result);
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, reply: "I've done several steps in a row — let me know if you'd like me to continue.", messages, finalPdfBase64, telegramDelivered, awaitingPhoto })
    };

  } catch (error) {
    console.error('cv-chat error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Internal server error' }) };
  }
};