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
//   render_preview(content) / finalize_pdf(content) → produce the actual
//     PDF (same renderer, no separate "preview-only" logic yet in v1) and
//     return it as base64 so the client can show/download it.
//
// ── FIX: the user's photo is now actually forwarded ──────────────────────
// Previously, photoBase64 was accepted from the client but never inserted
// anywhere — the model had no way to "pass it through" as the old system
// prompt claimed, since it never actually saw the value. The model should
// never have to carry a giant base64 string through its own context anyway
// (wasteful, and error-prone if it got copied wrong). Instead, the server
// now tracks the most recently supplied photoBase64 and silently injects
// it into content.photoBase64 itself, every time check_template_fit,
// render_preview, or finalize_pdf is called — the model just needs to
// build the rest of the content object; the photo is handled for it.

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
     languages: [{name,level}],
     profile, skills: [string], 
     experience: [{org,role,dateRange,bullets:[string]}],
     achievements: [string], certifications: [{title,issuer}],
     reference: {name,role,email,phone} | null
   }
3. If a section is thin or missing (e.g. no experience, no skills), do NOT just leave it empty and do NOT interrogate the user with a long form. Ask ONE short, friendly question at a time, offering an easy way out — e.g. "Have you done any internship, volunteer work, or class project? If not, no worries, I can suggest some based on your field." If they still have nothing, propose 3-5 common, reasonable skills/achievements for their field of study as SUGGESTIONS ONLY, clearly labeled as suggestions, and ask them to confirm/edit before including them. NEVER silently invent facts (like a specific employer, degree, or grade) — only suggest generic, clearly-labeled filler for skills/soft-skills, never for verifiable facts.
4. Before you EVER tell the user their CV "fits" or "is too long", call check_template_fit with your current best content object. Trust ONLY its numbers — never estimate this yourself.
   - If it reports overflow: summarize what's over budget in plain terms, propose a SPECIFIC trim (what you'd cut/shorten and why), show the user a quick before/after, and only apply it after they're OK with it (or say "go ahead, you decide" — in which case proceed).
   - If it reports large underflow after all real content is gathered: that's fine, the renderer automatically spaces things out — you don't need to pad content just to fill space. Do not invent extra content purely to fill space.
5. Once the user explicitly confirms the ORGANIZED CONTENT looks right (text/sections, not the visual PDF yet), call request_photo_upload and ask them to attach their photo. Do NOT ask for a photo any earlier than this step — the app only shows the photo-cropping frame after you call this tool, so asking sooner would confuse the user. If the user has no photo or doesn't want one, that's fine — proceed without it.
6. Once the user has attached a photo (or said to skip it), call render_preview with the final content object and tell the user a preview is ready. You do NOT need to include a photo field yourself — the app attaches the user's photo automatically whenever you render; just build the rest of the content.
7. If the user asks for one change after seeing the preview, update just that field and call render_preview again (call check_template_fit again first if the edit could plausibly cause overflow, e.g. adding a paragraph).
8. When the user is happy, call finalize_pdf with the final content object and let them know their CV is ready to download.

## Hard rules
- Never call render_preview or finalize_pdf without having called check_template_fit at least once on that same content first, unless the content is trivially short (e.g. a one-field edit unrelated to length).
- Never state a fit/overflow judgment without a check_template_fit tool result to back it up.
- Never invent specific factual claims (employers, dates, grades, certificate names). Only ever suggest generic, clearly-labeled filler for skills or soft-skill phrasing.
- Keep messages short and conversational — this is a chat, not a form.
- Never ask the user for their photo, and never treat an uploaded document's extracted text as a description of a "photo" — until AFTER you've called request_photo_upload (step 5), any attachment is a document to read for information.
- You never need to include a photoBase64 field — the app handles the photo automatically when rendering.`;
}

// OpenAI-style function-calling schema (DeepSeek is OpenAI-API-compatible).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_photo_upload',
      description: 'Call this ONLY once the user has explicitly confirmed the organized CV content (sections/text) looks right, and you are ready to ask them for their profile photo. Calling this tells the app to show the photo-cropping frame the next time the user attaches an image — before this call, any image the user sends is treated as a document, not a photo.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_template_fit',
      description: 'Runs the REAL layout measurement for the Minimal CV template against a candidate content object. Returns exact per-section line counts, and whether the content fits one page (overflowLines/underflowLines). Always call this before judging fit or before rendering.',
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
      name: 'render_preview',
      description: 'Renders the current content object into an actual PDF for the user to look at (not yet final). The app shows this to the user directly — you do not need to include a photo field.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'object' } },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_pdf',
      description: 'Renders the FINAL, user-approved CV as a downloadable PDF. Only call this after the user has confirmed they are happy with a preview.',
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

async function callTool(name, args, latestPhotoBase64, templateId) {
  try {
    const template = resolveTemplate(templateId).mod;
    if (name === 'request_photo_upload') {
      return { ok: true, message: 'The app will now show the photo-cropping frame the next time the user attaches an image.' };
    }
    if (name === 'check_template_fit') {
      const result = template.measure(withPhoto(args.content, latestPhotoBase64));
      return { ok: true, result };
    }
    if (name === 'render_preview' || name === 'finalize_pdf') {
      const buf = await template.render(withPhoto(args.content, latestPhotoBase64));
      return { ok: true, pdfBase64: buf.toString('base64'), kind: name === 'finalize_pdf' ? 'final' : 'preview' };
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

  let previewPdfBase64 = null;
  let finalPdfBase64 = null;
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
          body: JSON.stringify({ success: true, reply: msg.content || '', messages, previewPdfBase64, finalPdfBase64, awaitingPhoto })
        };
      }

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave as {} */ }

        const result = await callTool(tc.function.name, args, photoBase64, templateId);
        let toolContent;
        if (result && result.pdfBase64) {
          if (result.kind === 'final') finalPdfBase64 = result.pdfBase64;
          else previewPdfBase64 = result.pdfBase64;
          // Don't send the full PDF back into the model's context — just
          // confirm success, to avoid burning tokens on binary data.
          toolContent = JSON.stringify({ ok: result.ok, kind: result.kind, message: result.ok ? 'Rendered successfully. It has been shown to the user already — do not re-describe the raw PDF, just comment on it conversationally.' : result.error });
        } else {
          toolContent = JSON.stringify(result);
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, reply: "I've done several steps in a row — let me know if you'd like me to continue.", messages, previewPdfBase64, finalPdfBase64, awaitingPhoto })
    };

  } catch (error) {
    console.error('cv-chat error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'Internal server error' }) };
  }
};