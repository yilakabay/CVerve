// functions/lib/cv-template-minimal.js
//
// "Minimal / Scandinavian" CV template, ported from the original ReportLab
// (Python) script to JS/pdfkit so it can run inside this project's Node.js
// backend (Netlify Functions) without needing a second language runtime.
//
// This module is the ONLY place that knows how this specific template is
// laid out. It exposes two functions that share the exact same measurement
// logic, so "will this fit?" and "how it actually renders" can never
// disagree with each other:
//
//   measure(content)  → no PDF produced. Returns, per section, how many
//     lines the content needs vs. how much room is available, plus a
//     verdict on whether the whole thing fits one page. This is what
//     cv-chat.js calls BEFORE generating anything, so the AI is reasoning
//     from real numbers instead of guessing whether something is "too long".
//
//   render(content)   → produces the actual PDF (Buffer). If the content is
//     shorter than the page, it automatically stretches the gaps between
//     sections so the page doesn't end up looking top-heavy/half-blank.
//     Any section with no data (empty array / missing) is skipped
//     entirely — the next section naturally moves up to fill the gap,
//     since every section function returns the y-position the next one
//     should start at (same "chaining" approach as the original Python).
//
// ── CONTENT SCHEMA ─────────────────────────────────────────────────────
// {
//   name: string,
//   subtitle: string,                          // e.g. "MANAGEMENT GRADUATE"
//   photoBase64: string | null,                 // raw base64, no data: prefix
//   contact: { phone, email, location },        // any field may be omitted
//   education: { degree, school, years, extra },// extra e.g. "CGPA 3.41 | Exit Exam 82%"
//   languages: [{ name, level }],
//   profile: string,
//   skills: string[],
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   achievements: string[],
//   certifications: [{ title, issuer }],
//   references: [{ name, role, email, phone }] | []   // 0, 1, or many
// }
// Any array can be empty ([]) or omitted — that section is simply skipped.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences } = require('./cv-shared');

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;

const MARGIN_L = 56;
const MARGIN_R = 56;
const CONTENT_LEFT = MARGIN_L;
const CONTENT_RIGHT = PAGE_W - MARGIN_R;
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;

const LABEL_COL_W = 108;
const TEXT_COL_X = CONTENT_LEFT + LABEL_COL_W;
const TEXT_COL_W = CONTENT_RIGHT - TEXT_COL_X;

// ---------- Colors ----------
const INK      = '#232326';
const BODY_GRY = '#5A5C62';
const MUTED    = '#96989E';
const HAIRLINE = '#DADBDE';
const ACCENT   = '#B08456';

// Runs the FULL layout using only measurement calls (no drawing) and
// records per-section line counts + final y. Both measure() and render()
// call this with a flag controlling whether drawing actually happens.
function layout(doc, content, { draw, stretchPerGap = 0 } = {}) {
  const sections = []; // { name, linesUsed, present }
  let y = 0;

  function track(name, linesUsed, present) {
    sections.push({ name, linesUsed, present });
  }

  // ---- Header ----
  const TOP = 58;
  if (draw) {
    doc.font('Helvetica').fontSize(30).fillColor(INK);
    doc.text(content.name || '', CONTENT_LEFT, TOP, { lineBreak: false });
    doc.strokeColor(ACCENT).lineWidth(1.4)
      .moveTo(CONTENT_LEFT, TOP + 35).lineTo(CONTENT_LEFT + 46, TOP + 35).stroke();
    doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
    doc.text((content.subtitle || '').toUpperCase(), CONTENT_LEFT, TOP + 44, { lineBreak: false });
  }

  // ---- Photo (small circle, top-right) ----
  const PHOTO_R = 32;
  const photoCx = CONTENT_RIGHT - PHOTO_R;
  const photoCy = TOP + 14 + PHOTO_R;
  if (draw && content.photoBase64) {
    try {
      const buf = Buffer.from(content.photoBase64, 'base64');
      doc.save();
      doc.circle(photoCx, photoCy, PHOTO_R).clip();
      doc.image(buf, photoCx - PHOTO_R, photoCy - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
      doc.restore();
    } catch (e) {
      console.error('cv-template-minimal photo error:', e.message);
    }
  }
  if (draw) {
    doc.strokeColor(HAIRLINE).lineWidth(0.9).circle(photoCx, photoCy, PHOTO_R).stroke();
  }

  const HEAD_BOTTOM = TOP + 70;
  if (draw) {
    const ruleEndX = (photoCx - PHOTO_R) - 14;
    doc.strokeColor(HAIRLINE).lineWidth(0.75)
      .moveTo(CONTENT_LEFT, HEAD_BOTTOM).lineTo(ruleEndX, HEAD_BOTTOM).stroke();
  }

  // ---- Meta row: contact / education / languages ----
  const META_TOP = HEAD_BOTTOM + 20;
  const colW = CONTENT_W / 3;
  const col1 = CONTENT_LEFT, col2 = CONTENT_LEFT + colW, col3 = CONTENT_LEFT + 2 * colW;

  function metaLabel(label, x, yTop) {
    if (!draw) return;
    doc.font('Helvetica').fontSize(8).fillColor(ACCENT);
    doc.text(label.toUpperCase(), x, yTop, { lineBreak: false });
  }
  function metaLine(text, x, yTop, opts = {}) {
    if (!draw) return;
    doc.font(opts.font || 'Helvetica').fontSize(opts.size || 9.3).fillColor(opts.color || INK);
    doc.text(text, x, yTop, { lineBreak: false });
    if (opts.link) doc.link(x, yTop - 2, doc.widthOfString(text), 11, opts.link);
  }

  // Contact: any missing field (phone/email/location) is simply skipped —
  // the remaining ones stack up from the top of the column instead of
  // leaving a blank line where the missing one would have been.
  metaLabel('Contact', col1, META_TOP);
  const contactRows = [
    content.contact?.phone ? { text: content.contact.phone, link: `tel:${content.contact.phone.replace(/\s+/g, '')}` } : null,
    content.contact?.email ? { text: content.contact.email, link: `mailto:${content.contact.email}` } : null,
    content.contact?.location ? { text: content.contact.location, color: BODY_GRY } : null
  ].filter(Boolean);
  contactRows.forEach((row, i) => metaLine(row.text, col1, META_TOP + 15 + i * 13, { link: row.link, color: row.color }));

  metaLabel('Education', col2, META_TOP);
  const eduList = normalizeEducation(content.education);
  const edu0 = eduList[0] || {};
  metaLine(edu0.degree || '', col2, META_TOP + 15);
  metaLine(edu0.school || '', col2, META_TOP + 28, { color: BODY_GRY });
  metaLine(edu0.extra || '', col2, META_TOP + 41, { color: BODY_GRY });

  metaLabel('Languages', col3, META_TOP);
  (content.languages || []).slice(0, 2).forEach((l, i) => {
    metaLine(`${l.name} — ${l.level}`, col3, META_TOP + 15 + i * 13, { color: BODY_GRY });
  });

  const META_BOTTOM = META_TOP + 58;
  if (draw) {
    doc.strokeColor(HAIRLINE).lineWidth(0.75)
      .moveTo(CONTENT_LEFT, META_BOTTOM).lineTo(CONTENT_RIGHT, META_BOTTOM).stroke();
  }

  y = META_BOTTOM + 16 + stretchPerGap * 0.6; // a little breathing room before section 1 too

  let sectionNum = 0;
  function sectionHeading(label, yTop) {
    sectionNum += 1;
    if (draw) {
      doc.font('Helvetica').fontSize(8.3).fillColor(ACCENT);
      doc.text(String(sectionNum).padStart(2, '0'), CONTENT_LEFT, yTop + 1, { lineBreak: false });
      doc.font('Helvetica').fontSize(11.5).fillColor(INK);
      doc.text(label.toUpperCase(), CONTENT_LEFT + 22, yTop + 1, { lineBreak: false });
    }
    return yTop + 24;
  }

  function bodyParagraph(text, yTop, opts = {}) {
    const size = opts.size || 9.7, leading = opts.leading || 13.8;
    const width = opts.width || TEXT_COL_W, x = opts.x ?? TEXT_COL_X;
    const lines = wrapLines(doc, text, 'Helvetica', size, width);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY_GRY);
      let cur = yTop;
      for (const ln of lines) { doc.text(ln, x, cur, { lineBreak: false }); cur += leading; }
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }

  function bodyBullets(items, yTop, opts = {}) {
    const size = opts.size || 9.7, leading = opts.leading || 13.8;
    const width = opts.width || TEXT_COL_W, x = opts.x ?? TEXT_COL_X;
    let cur = yTop, totalLines = 0;
    for (const item of (items || [])) {
      const lines = wrapLines(doc, item, 'Helvetica', size, width - 12);
      if (draw) {
        doc.fillColor(ACCENT).circle(x + 1.5, cur + size * 0.7, 1.2).fill();
        doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY_GRY);
        let ly = cur;
        for (const ln of lines) { doc.text(ln, x + 10, ly, { lineBreak: false }); ly += leading; }
      }
      cur += lines.length * leading + 2.2;
      totalLines += lines.length;
    }
    return { y: cur, lines: totalLines };
  }

  const GAP = 14 + stretchPerGap;

  // ---- 01 Profile ----
  if (content.profile) {
    y = sectionHeading('Profile', y);
    const r = bodyParagraph(content.profile, y);
    track('profile', r.lines, true);
    y = r.y;
  } else track('profile', 0, false);

  // ---- 02 Skills ----
  if (content.skills && content.skills.length) {
    y = sectionHeading('Skills', y + GAP);
    const r = bodyParagraph(content.skills.join('   ·   '), y, { leading: 15.5 });
    track('skills', r.lines, true);
    y = r.y;
  } else track('skills', 0, false);

  // ---- 03 Experience ----
  if (content.experience && content.experience.length) {
    y = sectionHeading('Experience', y + GAP);
    let linesUsed = 0;
    for (const exp of content.experience) {
      if (draw) {
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        doc.text(exp.org || '', TEXT_COL_X, y + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(8.8).fillColor(MUTED);
        doc.text(`${exp.role || ''} — ${exp.dateRange || ''}`, TEXT_COL_X, y + 14, { lineBreak: false });
      }
      const r = bodyBullets(exp.bullets || [], y + 26);
      linesUsed += 3 + r.lines; // org line + role line + bullets
      y = r.y;
    }
    track('experience', linesUsed, true);
  } else track('experience', 0, false);

  // ---- 04 Achievements ----
  if (content.achievements && content.achievements.length) {
    y = sectionHeading('Achievements', y + GAP);
    const r = bodyBullets(content.achievements, y);
    track('achievements', r.lines, true);
    y = r.y;
  } else track('achievements', 0, false);

  // ---- 05 Certifications ----
  if (content.certifications && content.certifications.length) {
    y = sectionHeading('Certifications', y + GAP);
    let linesUsed = 0;
    for (const cert of content.certifications) {
      const r = bodyParagraph(`${cert.title} — ${cert.issuer}`, y, { leading: 13.8 });
      linesUsed += r.lines;
      y = r.y + 4;
    }
    track('certifications', linesUsed, true);
  } else track('certifications', 0, false);

  // ---- 06 Reference(s) ----
  // content.references is now a flexible array (0, 1, 2, 3+ entries) —
  // stacked one after another, each only showing the fields it actually
  // has (a reference given without a phone number just skips that line
  // instead of printing "PHONE" next to nothing).
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = sectionHeading(refList.length > 1 ? 'References' : 'Reference', y + GAP);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      if (draw) {
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        doc.text(ref.name, TEXT_COL_X, y + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(BODY_GRY);
        doc.text(ref.role || '', TEXT_COL_X, y + 15, { lineBreak: false, width: TEXT_COL_W, align: 'right' });
        let lineY = y + 32;
        if (ref.email) {
          doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
          doc.text('EMAIL', TEXT_COL_X, lineY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(ref.email, TEXT_COL_X + 40, lineY, { lineBreak: false });
        }
        if (ref.phone) {
          doc.fillColor(MUTED);
          doc.text('PHONE', TEXT_COL_X + 230, lineY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(ref.phone, TEXT_COL_X + 272, lineY, { lineBreak: false });
        }
      }
      y += 46;
      linesUsed += 3;
      if (i < refList.length - 1) y += 6;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: y, sections };
}

// Usable page height below the meta row, before things start overflowing
// onto a second page (this template is designed to always be one page).
const AVAILABLE_BOTTOM = PAGE_H - 40; // small bottom margin

function measure(content) {
  const doc = measureDoc();
  const { finalY, sections } = layout(doc, content, { draw: false });
  const available = AVAILABLE_BOTTOM;
  const overflowPt = Math.max(0, finalY - available);
  const underflowPt = Math.max(0, available - finalY);
  // ~13.8pt average leading → rough line-count equivalent, useful for the AI
  // to reason about "how much to trim" in familiar terms.
  const overflowLines = Math.round(overflowPt / 13.8);
  const underflowLines = Math.round(underflowPt / 13.8);
  return {
    fits: overflowPt === 0,
    finalY,
    availableHeight: available,
    overflowPoints: Math.round(overflowPt),
    overflowLines,
    underflowPoints: Math.round(underflowPt),
    underflowLines,
    sections
  };
}

function render(content) {
  const m = measure(content);
  // If content is shorter than the page, spread the extra space across the
  // gaps BETWEEN sections instead of leaving it all blank at the bottom.
  const presentSections = m.sections.filter(s => s.present).length;
  const numGaps = Math.max(1, presentSections); // includes the gap before section 1
  const stretchPerGap = (!m.fits || presentSections === 0) ? 0 : m.underflowPoints / numGaps;

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  layout(doc, content, { draw: true, stretchPerGap });
  doc.end();
  return done;
}

module.exports = { measure, render, PAGE_W, PAGE_H };