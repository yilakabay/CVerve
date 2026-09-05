const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http  = require('http');

// ── Fetch plain text from a URL ───────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVerveBot/1.0)' } }, res => {
      // Follow one redirect
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

// ── Strip HTML tags and collapse whitespace ───────────────────────────────────
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

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { fullName, phone, email, address, appDate, cvText, jdText, jdUrl, targetPosition, extraPrompt } = JSON.parse(event.body);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Gemini API key' }) };
  }

  if (!targetPosition || targetPosition.trim().length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please specify the position you are applying for.' }) };
  }

  try {
    if (!cvText || cvText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'CV text is required and must contain sufficient content' }) };
    }

    // ── Resolve JD text ───────────────────────────────────────────────────────
    let resolvedJdText = jdText || '';

    if (jdUrl && (!jdText || jdText.length < 20)) {
      console.log('Fetching JD from URL:', jdUrl);
      try {
        const rawHtml = await fetchUrl(jdUrl);
        resolvedJdText = htmlToText(rawHtml);
        console.log(`Fetched ${resolvedJdText.length} chars from URL`);
      } catch (fetchErr) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Could not fetch the job description URL: ${fetchErr.message}` })
        };
      }
    }

    if (!resolvedJdText || resolvedJdText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Job description text is required and must contain sufficient content' }) };
    }

    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", resolvedJdText.length);
    console.log("Target Position:", targetPosition);
    console.log("Extra Prompt Provided:", !!(extraPrompt && extraPrompt.trim()));

    const MAX_TEXT_LENGTH = 50000;
    const truncatedJdText = resolvedJdText.length > MAX_TEXT_LENGTH
      ? resolvedJdText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : resolvedJdText;
    const truncatedCvText = cvText.length > MAX_TEXT_LENGTH
      ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : cvText;

    // Extra, user-supplied instructions are optional and bounded in length so a
    // very long paste can't blow out the prompt or override the core structure.
    const MAX_EXTRA_PROMPT_LENGTH = 1500;
    let sanitizedExtraPrompt = '';
    if (extraPrompt && typeof extraPrompt === 'string' && extraPrompt.trim()) {
      sanitizedExtraPrompt = extraPrompt.trim().substring(0, MAX_EXTRA_PROMPT_LENGTH);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    // generationConfig controls HOW the model samples words, on top of what
    // the prompt asks for — this is what actually produces natural,
    // non-repetitive phrasing rather than the same safe wording every time:
    //   - temperature: randomness in word choice. Default is lower/more
    //     deterministic; bumping it up gives more natural variation between
    //     letters without going incoherent.
    //   - topP: nucleus sampling — only samples from the smallest set of
    //     words whose combined probability crosses this threshold, so it
    //     stays coherent even with a higher temperature.
    //   - frequencyPenalty: discourages reusing the SAME words/phrases
    //     within one letter — directly targets the repetitive, templated
    //     phrasing that reads as AI-written.
    //   - presencePenalty: discourages circling back to ideas already
    //     covered, pushing the model to keep moving forward rather than
    //     padding with restatements.
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature:      1.1,
        topP:             0.95,
        frequencyPenalty: 0.4,
        presencePenalty:  0.3
      }
    }, { apiVersion: "v1beta" });

    const prompt = `
      TARGET POSITION: "${targetPosition}"

      JOB DESCRIPTION SOURCE:
      ${truncatedJdText}

      APPLICANT'S CV:
      ${truncatedCvText}

      APPLICANT INFORMATION:
      - Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Date: ${appDate}

      INSTRUCTIONS:
      Write a short, genuine application letter for the EXACT position: "${targetPosition}".

      CRITICAL — POSITION FILTERING:
      The job description source above may contain multiple job openings or positions. You MUST focus ONLY on the role titled "${targetPosition}" and its associated requirements, responsibilities, and company context. Completely ignore any other job postings, roles, or positions mentioned in the text. If the exact title is not found, use the closest matching role and any general company/department information provided. Do NOT write a letter for any other position.

      STRICT GUIDELINES:
      1. Total body length: exactly 3 paragraphs. Each paragraph is 3-4 sentences maximum. The entire letter body must fit in roughly two thirds of an A4 page — no more.
      2. Header block (no labels): Name, Phone, Email, Address, Date — each on its own line. This is the ONLY place phone and email should appear in the entire letter.
      3. Then a subject line naming the exact position ("${targetPosition}") and company.
      4. Then "Dear Hiring Manager" (or recipient name if given in the JD).
      5. Paragraph 1: State the position you are applying for and one or two specific reasons you are a strong fit, drawn directly from the CV and the requirements for "${targetPosition}" only. Be factual and concrete, not generic.
      6. Paragraph 2: Highlight one or two concrete skills or experiences from the CV that directly match the job requirements. Be specific about what you did and how it relates to this role.
      7. Paragraph 3: Express genuine interest in the company/role in one sentence, then close with availability for interview in one sentence. Do NOT include phone number or email here — they are already in the header.
      8. Close with "Sincerely," then the applicant's name.
      9. No bullet points, no bold text, no em dashes, no placeholders.
      10. Only mention GPA if it is 3.0 or above; omit the "/4.0" scale.
      11. Do not mention attaching documents.
      12. CRITICAL: Phone number and email must appear ONLY in the header block (item 2 above). Do NOT repeat them anywhere in the body paragraphs or closing. The closing sentence should only mention availability for an interview, NOT contact details.

      VOICE — SOUND LIKE A REAL PERSON, NOT AN AI OR AN HR TEMPLATE:
      Act like a seasoned, empathetic ghostwriter, not an HR bot or a LinkedIn-influencer voice. Write in a warm, confident, first-person voice — like a thoughtful professional explaining themselves over coffee, not a keyword list.
      - Vary sentence length on purpose within each paragraph: mix one short, punchy sentence with one longer, more detailed one. It's fine, occasionally, to start a sentence with "And," "But," or "So" if it reads naturally — don't force it into every paragraph.
      - Use natural connective phrases where they fit honestly, e.g. "What drew me to this role is...", "I found myself drawn to...", rather than starting every sentence the same structural way.
      - Don't just list the CV — narrate it in miniature: what you did, why it mattered, what the result was. One concrete detail beats three vague claims.
      - Never use stock opening/closing lines like "I am writing to apply," "I am a hard-working team player," or "In my previous role, I was responsible for." Also avoid other AI-sounding buzzwords and filler — "I am confident," "leverage my skills," "dynamic team," "excited to apply" — for the same reason. Prefer specific, active verbs (led, untangled, rebuilt, championed) over generic ones (managed, did, worked, handled) — but don't force an unusual verb where a plain one is clearer; it should still sound like something a person would actually say, not a thesaurus.
      - The result should read as if a sharp, slightly informal professional wrote it in one sitting: polished enough to send, natural enough that no two letters sound alike.
      - None of the above overrides the STRICT GUIDELINES above — the paragraph count, header format, and phone/email placement rules always win over stylistic choices.
      ${sanitizedExtraPrompt ? `
      ADDITIONAL APPLICANT INSTRUCTIONS (apply these on top of the rules above; if anything here conflicts with the STRICT GUIDELINES or the header/body structure, the STRICT GUIDELINES win):
      "${sanitizedExtraPrompt}"
      ` : ''}

      Generate the letter now:
    `;

    // Retry logic: up to 3 attempts with 3-second delay between each
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Sending request to Gemini 2.5 Flash (attempt ${attempt} of ${MAX_ATTEMPTS})...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const letterText = response.text();
        console.log("Letter generated successfully on attempt", attempt);
        return {
          statusCode: 200,
          body: JSON.stringify({ letterText })
        };
      } catch (err) {
        lastError = err;
        console.error(`Gemini attempt ${attempt} failed:`, err.message);

        const isRetryable = err.message.includes('503') || err.message.includes('503 Service Unavailable') ||
                            err.message.includes('high demand') || err.message.includes('429') ||
                            err.message.includes('quota');

        if (!isRetryable || attempt === MAX_ATTEMPTS) break;

        console.log(`Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    throw lastError;

  } catch (error) {
    console.error('Letter generation error:', error);
    let errorMessage = 'We are unable to generate your letter right now. ';
    if (error.message && (error.message.includes('503') || error.message.includes('high demand'))) {
      errorMessage += 'The AI service is currently busy. Please wait a moment and try again.';
    } else if (error.message && error.message.includes('timeout')) {
      errorMessage += 'The request took too long. Please try again.';
    } else {
      // Never forward the raw error (e.g. a Gemini API quota/rate-limit
      // message) to the client — it's technical, unhelpful to the person
      // using the app, and can leak implementation details. The real error
      // is still logged above for debugging.
      errorMessage += 'Please try again in a moment.';
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};