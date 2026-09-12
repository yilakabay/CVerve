// functions/cv-chat.js
//
// POST body: { messages: [...], newUserText?: string, newUserFiles?: [{filename, mediaType, base64}] }
//
// This is the backend for "CVCase" — a conversational AI that builds a CV
// with the user, one message at a time. The client keeps the full message
// history and re-sends it every turn (this function is stateless, same
// pattern noted for Claude-in-artifacts elsewhere in this app).
//
// ── WHY A TOOL-USE LOOP, NOT JUST A CHAT ────────────────────────────────
// Claude is good at conversation, judgment, and writing — but bad at
// reliably estimating whether a block of text fits a fixed-size PDF
// section, and it must never "eyeball" that. So it's given tools that call
// into REAL code (lib/cv-template-minimal.js) for anything that has to be
// exact:
//
//   check_template_fit(content) → runs the actual PDFKit measurement used
//     by the real renderer and returns real line counts / overflow /
//     underflow numbers, per section. Claude must call this before ever
//     telling the user "this fits" or deciding to trim something, and must
//     act on the numbers it gets back, not its own guess.
//
//   render_preview(content) / finalize_pdf(content) → produce the actual
//     PDF (same renderer, no separate "preview-only" logic yet in v1) and
//     return it as base64 so the client can show/download it. Claude must
//     never describe a CV as final without calling one of these.
//
// The system prompt below is the actual guardrail — it tells Claude
// exactly when it's allowed to call which tool, and forbids it from
// inventing fit/overflow judgments on its own.

const cvTemplate = require('./lib/cv-template-minimal');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ITERATIONS = 6; // safety cap on the internal tool loop

// ── DEV ACCESS GATE ──────────────────────────────────────────────────────
// While the CV feature is being built and tested, only this one account may
// use it, no matter how the request reaches this function. cv.html also has
// a client-side gate for a clean "coming soon" screen, but THIS check is
// the one that actually matters — client-side checks can always be
// bypassed, so the server must independently refuse everyone else here.
// When the feature is ready for everyone, delete this block (and the
// matching one in cv.html) and nothing else needs to change.
const CV_DEV_ALLOWED_USER_ID = '0985576139';

const SYSTEM_PROMPT = `You are "CVCase", a friendly, efficient AI that builds a professional one-page CV with the user through conversation, using the "Minimal / Scandinavian" template.

## Your job, step by step
1. Greet the user briefly and ask them to describe themselves OR upload documents (certificates, transcripts, old CV) — either is fine. If they upload documents (including image files — certificate photos, transcript scans, etc.), you'll receive their extracted text/content as part of the conversation already. IMPORTANT: any image the user sends BEFORE you've called request_photo_upload is a DOCUMENT to read for information, never a profile photo — do not treat it as one, and do not comment on it as if it were a photo.
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
5. Once the user explicitly confirms the ORGANIZED CONTENT looks right (text/sections, not the visual PDF yet), call request_photo_upload and ask them to attach their photo. Do NOT ask for a photo any earlier than this step — the app only shows the photo-cropping frame after you call this tool, so asking sooner would confuse the user (they'd attach an image and nothing special would happen). If the user has no photo or doesn't want one, that's fine — proceed without it.
6. Once you have the photo (or the user said to skip it), call render_preview with the final content object and tell the user a preview is ready.
7. If the user asks for one change after seeing the preview, update just that field and call render_preview again (call check_template_fit again first if the edit could plausibly cause overflow, e.g. adding a paragraph).
8. When the user is happy, call finalize_pdf with the final content object and let them know their CV is ready to download.

## Hard rules
- Never call render_preview or finalize_pdf without having called check_template_fit at least once on that same content first, unless the content is trivially short (e.g. a one-field edit unrelated to length).
- Never state a fit/overflow judgment without a check_template_fit tool result to back it up.
- Never invent specific factual claims (employers, dates, grades, certificate names). Only ever suggest generic, clearly-labeled filler for skills or soft-skill phrasing.
- Keep messages short and conversational — this is a chat, not a form.
- Never ask the user for their photo, and never assume an uploaded image is a photo, until AFTER you've called request_photo_upload (step 5). Before that point, treat every image as a document to read. The app's photo-cropping frame ONLY appears right after that tool call — asking earlier or treating an earlier image as a photo will not work as the user expects.
- If photoBase64 is present in context, just pass it through in the content object unchanged — you never process or edit the photo yourself.`;

const TOOLS = [
  {
    name: 'request_photo_upload',
    description: 'Call this ONLY once the user has explicitly confirmed the organized CV content (sections/text) looks right, and you are ready to ask them for their profile photo. Calling this tells the app to show the photo-cropping frame the next time the user attaches an image — before this call, any image the user sends is treated as a document, not a photo. Takes no meaningful input.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'check_template_fit',
    description: 'Runs the REAL layout measurement for the Minimal CV template against a candidate content object. Returns exact per-section line counts, and whether the content fits one page (overflowLines/underflowLines). Always call this before judging fit or before rendering.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'object', description: 'The candidate CV content object matching the schema described in the system prompt.' } },
      required: ['content']
    }
  },
  {
    name: 'render_preview',
    description: 'Renders the current content object into an actual PDF for the user to look at (not yet final). Returns a base64 PDF the app will display inline.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'object' } },
      required: ['content']
    }
  },
  {
    name: 'finalize_pdf',
    description: 'Renders the FINAL, user-approved CV as a downloadable PDF. Only call this after the user has confirmed they are happy with a preview.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'object' } },
      required: ['content']
    }
  }
];

function executeTool(name, input) {
  try {
    if (name === 'request_photo_upload') {
      // No real work to do — this tool exists purely as a signal. Its
      // occurrence in the tool-call stream is detected in the handler
      // below and turned into `awaitingPhoto: true` for the client.
      return { ok: true, message: 'The app will now show the photo-cropping frame the next time the user attaches an image.' };
    }
    if (name === 'check_template_fit') {
      const result = cvTemplate.measure(input.content || {});
      return { ok: true, result };
    }
    if (name === 'render_preview' || name === 'finalize_pdf') {
      // handled async below (render() returns a Promise) — see callTool()
      return null;
    }
    return { ok: false, error: 'Unknown tool: ' + name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function callTool(name, input) {
  if (name === 'render_preview' || name === 'finalize_pdf') {
    try {
      const buf = await cvTemplate.render(input.content || {});
      return { ok: true, pdfBase64: buf.toString('base64'), kind: name === 'finalize_pdf' ? 'final' : 'preview' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return executeTool(name, input);
}

async function callAnthropic(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Anthropic API error');
  return data;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Real enforcement — see the CV_DEV_ALLOWED_USER_ID comment above.
  if (body.userId !== CV_DEV_ALLOWED_USER_ID) {
    return { statusCode: 403, body: JSON.stringify({ error: 'CV Builder is not available yet.' }) };
  }

  let { messages, newUserText, newUserFiles } = body;
  messages = Array.isArray(messages) ? messages.slice() : [];

  if (newUserText || (newUserFiles && newUserFiles.length)) {
    const contentBlocks = [];
    for (const f of (newUserFiles || [])) {
      if (f.mediaType && f.mediaType.startsWith('image/')) {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } });
      } else if (f.mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } });
      }
    }
    if (newUserText) contentBlocks.push({ type: 'text', text: newUserText });
    messages.push({ role: 'user', content: contentBlocks.length ? contentBlocks : (newUserText || '') });
  }

  let previewPdfBase64 = null;
  let finalPdfBase64 = null;
  let awaitingPhoto = false;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const data = await callAnthropic(messages);
      messages.push({ role: 'assistant', content: data.content });

      const toolUses = data.content.filter(b => b.type === 'tool_use');
      if (toolUses.some(tu => tu.name === 'request_photo_upload')) awaitingPhoto = true;

      if (toolUses.length === 0) {
        // Plain text turn — done for this round.
        const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, reply: text, messages, previewPdfBase64, finalPdfBase64, awaitingPhoto })
        };
      }

      const toolResults = [];
      for (const tu of toolUses) {
        const result = await callTool(tu.name, tu.input || {});
        if (result && result.pdfBase64) {
          if (result.kind === 'final') finalPdfBase64 = result.pdfBase64;
          else previewPdfBase64 = result.pdfBase64;
          // Don't send the full PDF back into the model's context — just
          // confirm success, to avoid burning tokens on binary data.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ ok: result.ok, kind: result.kind, message: result.ok ? 'Rendered successfully. It has been shown to the user already — do not re-describe the raw PDF, just comment on it conversationally.' : result.error })
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result)
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
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