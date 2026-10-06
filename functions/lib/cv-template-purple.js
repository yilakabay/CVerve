// functions/lib/cv-template-purple.js
//
// "Purple Executive" CV template — a large centered name in one accent
// color, a centered contact block, a thin accent rule under the header, and
// accent-colored section labels each followed by a full-width thin rule.
// Entry titles are bold with the date right-aligned on the same line.
// "Additional Information" renders as labeled bullets ("Technical Skills: ...",
// "Languages: ..."), built from skills, languages, certifications and
// achievements. Single column, NO photo.
//
// This template never uses a profile photo. `noPhoto = true` below tells
// cv-chat.js to skip the photo step and ignore any attached photo.
//
// Same measure()/render() contract as every other template.
//
// ── Safety rules (shared, from cv-shared.js) ──────────────────────────────
// • Every text run is wrapped to its real box width (wrapLines). Nothing is
//   cut with "..." and no line or reference is silently dropped.
// • Vertical positions come from the lines actually drawn, never fixed
//   offsets, so longer content pushes the rest down instead of colliding.
// • Experience and education title/date rows use expTitleDateRow().
// • Custom sections render in the main flow.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name,
//   contact: { phone, email, location, linkedin },
//   profile,
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
//   skills: string[],
//   languages: [{ name, level }],
//   certifications: [{ title, issuer }],
//   achievements: string[],
//   references: [{ name, role, email, phone }],
//   customSections: [{ title, items, text }]
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const INK = '#232326';
const BODY = '#34363A';
const MUTED = '#6E7177';
const ACCENT = '#6E4FA0';   // the one purple used throughout — change to retheme

// ---------- Layout ----------
const MARGIN_L = 50.0;
const MARGIN_R = PAGE_W - 50.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 34;

// Draws (or just measures) an already-wrapped block of lines. Returns new y.
function block(doc, lines, x, y, { font, size, color, leading, draw, align }) {
  if (draw) {
    doc.font(font).fontSize(size).fillColor(color);
    lines.forEach((ln, i) => {
      let lx = x;
      if (align === 'center') lx = x + (CONTENT_W - doc.widthOfString(ln)) / 2;
      doc.text(ln, lx, y + i * leading, { lineBreak: false });
    });
  }
  return y + lines.length * leading;
}

function layout(doc, content, { draw, stretchPerGap = 0, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    return Math.max(size + 2.2, Math.round(leading * 0.86 * 10) / 10);
  };
  const gapPx = (g) => (tightLeading ? Math.round(g * 0.62) : g);
  const GS = stretchPerGap;

  if (draw) doc.rect(0, 0, PAGE_W, PAGE_H).fill('#FFFFFF');

  // ── Header: large centered accent name, centered contact lines ────────
  const NAME_TOP = 44.0;
  const NAME_SIZES = [27, 24, 21, 18];
  const nameText = (content.name || '').toUpperCase();
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, CONTENT_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, CONTENT_W);
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, {
    font: 'Helvetica-Bold', size: nameSize, color: ACCENT, leading: nameSize * 1.15, draw, align: 'center'
  });

  // Line 1: location • phone • email. Line 2: LinkedIn, on its own line.
  const CONTACT_SIZE = 9.8, CONTACT_LH = 13.5;
  const line1Parts = [content.contact?.location, content.contact?.phone, content.contact?.email].filter(Boolean);
  if (line1Parts.length) {
    const l1 = wrapLines(doc, line1Parts.join('   •   '), 'Helvetica', CONTACT_SIZE, CONTENT_W);
    cur = block(doc, l1, MARGIN_L, cur + 6, { font: 'Helvetica', size: CONTACT_SIZE, color: BODY, leading: CONTACT_LH, draw, align: 'center' });
  }
  if (content.contact?.linkedin) {
    const l2 = wrapLines(doc, content.contact.linkedin, 'Helvetica', CONTACT_SIZE, CONTENT_W);
    cur = block(doc, l2, MARGIN_L, cur, { font: 'Helvetica', size: CONTACT_SIZE, color: BODY, leading: CONTACT_LH, draw, align: 'center' });
  }

  const headerRuleY = cur + 8;
  if (draw) doc.strokeColor(ACCENT).lineWidth(0.9).moveTo(MARGIN_L, headerRuleY).lineTo(MARGIN_R, headerRuleY).stroke();

  let y = headerRuleY + 22;

  // ── Section heading: accent label (wrapped if long), full-width rule under it
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 12.5, CONTENT_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(ACCENT);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 15, { characterSpacing: 0.5, lineBreak: false }));
    }
    return yTop + lines.length * 15 + 4;
  }
  function sectionRule(yTop) {
    if (draw) doc.strokeColor(ACCENT).lineWidth(0.8).moveTo(MARGIN_L, yTop).lineTo(MARGIN_R, yTop).stroke();
    return yTop + 16;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.7, leading = tighten(opts.leading || 14, size);
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, CONTENT_W);
    const y2 = block(doc, lines, MARGIN_L, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.4, leading = tighten(opts.leading || 13.4, size);
    const indent = opts.indent ?? 13;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, CONTENT_W - indent);
      if (draw) doc.font('Helvetica').fontSize(size).fillColor(INK).text('•', MARGIN_L, cy, { lineBreak: false });
      cy = block(doc, lines, MARGIN_L + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1 : 2.5;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // Bold "Label: " followed by plain text, wrapped with the first line
  // starting after the label and continuation lines at full indent.
  function labeledBullet(label, text, yTop) {
    const size = 9.4, leading = tighten(13.6, size), indent = 13;
    const labelText = label + ': ';
    doc.font('Helvetica-Bold').fontSize(size);
    const labelW = doc.widthOfString(labelText);
    const firstW = CONTENT_W - indent - labelW;
    const words = String(text).split(/\s+/).filter(Boolean);
    const allLines = [];
    let line = '', firstLine = true;
    words.forEach(word => {
      doc.font('Helvetica').fontSize(size);
      const avail = firstLine ? firstW : CONTENT_W - indent;
      const candidate = line ? line + ' ' + word : word;
      if (doc.widthOfString(candidate) <= avail || !line) {
        line = candidate;
      } else {
        allLines.push(line);
        line = word;
        firstLine = false;
      }
    });
    if (line) allLines.push(line);

    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(INK).text('•', MARGIN_L, yTop, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(labelText, MARGIN_L + indent, yTop, { lineBreak: false });
      doc.font('Helvetica').fontSize(size).fillColor(BODY).text(allLines[0] || '', MARGIN_L + indent + labelW, yTop, { lineBreak: false });
      let ly = yTop + leading;
      allLines.slice(1).forEach(ln => { doc.text(ln, MARGIN_L + indent, ly, { lineBreak: false }); ly += leading; });
    }
    return { y: yTop + allLines.length * leading + (tightLeading ? 1 : 2.5), lines: allLines.length };
  }

  // ── Summary ─────────────────────────────────────────────────────────
  if (content.profile) {
    y = heading('Summary', y);
    y = sectionRule(y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + gapPx(22) + GS;
  } else track('profile', 0, false);

  // ── Work Experience ─────────────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Work Experience', y);
    y = sectionRule(y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const titleLine = [exp.role, exp.org].filter(Boolean).join(' , ');
      const headerR = expTitleDateRow(doc, { org: titleLine, date: exp.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.2, titleColor: INK,
        dateFont: 'Helvetica-Bold', dateSize: 9.4, dateColor: INK,
        lineH: 13, gap: 10, draw
      });
      const br = bullets(exp.bullets || [], headerR.y + 2);
      linesUsed += headerR.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(10) : 0);
    });
    track('experience', linesUsed, true);
    y += gapPx(22) + GS;
  } else track('experience', 0, false);

  // ── Education ───────────────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    y = sectionRule(y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const headerR = expTitleDateRow(doc, { org: edu.degree || edu.level || '', date: edu.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.2, titleColor: INK,
        dateFont: 'Helvetica-Bold', dateSize: 9.4, dateColor: INK,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y + 1;
      linesUsed += headerR.lines;
      if (edu.school) { const r = para(edu.school, yy, { size: 9.5, leading: 13 }); yy = r.y; linesUsed += r.lines; }
      if (edu.extra) {
        const items = String(edu.extra).split(/\.\s*(?=[A-Z])|\n/).map(s => s.trim()).filter(Boolean);
        const r = bullets(items.length > 1 ? items : [edu.extra], yy + 1, { size: 9.3, leading: 13 });
        yy = r.y; linesUsed += r.lines;
      }
      y = yy + (idx < eduList.length - 1 ? gapPx(10) : 0);
    });
    track('education', linesUsed, true);
    y += gapPx(22) + GS;
  } else track('education', 0, false);

  // ── Additional Information: labeled bullets ───────────────────────────
  const addlRows = [];
  if (content.skills && content.skills.length) addlRows.push(['Technical Skills', content.skills.join(', ')]);
  const langStr = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).join(', ');
  if (langStr) addlRows.push(['Languages', langStr]);
  const certStr = (content.certifications || []).map(c => [c.title, c.issuer].filter(Boolean).join(' — ')).join(', ');
  if (certStr) addlRows.push(['Certifications', certStr]);
  if (content.achievements && content.achievements.length) addlRows.push(['Awards/Activities', content.achievements.join('; ')]);

  if (addlRows.length) {
    y = heading('Additional Information', y);
    y = sectionRule(y);
    let linesUsed = 0;
    addlRows.forEach(([label, text]) => {
      const r = labeledBullet(label, text, y);
      y = r.y; linesUsed += r.lines;
    });
    track('additional', linesUsed, true);
    y += gapPx(22) + GS;
  } else track('additional', 0, false);

  // ── Custom sections ─────────────────────────────────────────────────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    y = sectionRule(y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = bullets(cs.items, y); y = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = para(cs.text, y); y = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(22) + GS;
  });

  // ── References (every reference kept; side by side for 2+) ──────────
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = heading(refList.length > 1 ? 'References' : 'Reference', y);
    y = sectionRule(y);
    const cols = refList.length > 1 ? 2 : 1;
    const gap = 24;
    const colW = (CONTENT_W - gap * (cols - 1)) / cols;
    const colY = new Array(cols).fill(y);
    let linesUsed = 0;

    refList.forEach((ref, i) => {
      const col = i % cols;
      const bx = MARGIN_L + col * (colW + gap);
      let by = colY[col];

      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 10, colW);
      by = block(doc, nameLines, bx, by, { font: 'Helvetica-Bold', size: 10, color: INK, leading: 13, draw });
      linesUsed += nameLines.length;

      if (ref.role) {
        const roleLines = wrapLines(doc, ref.role, 'Helvetica', 9, colW);
        by = block(doc, roleLines, bx, by, { font: 'Helvetica', size: 9, color: MUTED, leading: 12, draw });
        linesUsed += roleLines.length;
      }

      [['Email', ref.email], ['Phone', ref.phone]].forEach(([label, val]) => {
        if (!val) return;
        const labelW = 36;
        const valLines = wrapLines(doc, String(val), 'Helvetica', 8.8, colW - labelW);
        if (draw) doc.font('Helvetica-Bold').fontSize(8.8).fillColor(INK).text(label + ':', bx, by, { lineBreak: false });
        by = block(doc, valLines, bx + labelW, by, { font: 'Helvetica', size: 8.8, color: BODY, leading: 12, draw });
        linesUsed += valLines.length;
      });

      colY[col] = by + 14;
    });

    track('references', linesUsed, true);
    y = Math.max(...colY) - 14;
  } else track('references', 0, false);

  return { finalY: y, sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { tightLeading: false } },
  { name: 'tight-leading', opts: { tightLeading: true } },
];
const HARD_OVERFLOW_LINE_THRESHOLD = 3;

function measure(content) {
  let last = null;
  for (const level of FIT_LEVELS) {
    const doc = measureDoc();
    const { finalY, sections } = layout(doc, content, { draw: false, ...level.opts });
    last = { finalY, sections, level: level.name };
    if (finalY <= AVAILABLE_BOTTOM) {
      return {
        fits: true, finalY, availableHeight: AVAILABLE_BOTTOM,
        overflowPoints: 0, overflowLines: 0,
        underflowPoints: Math.round(AVAILABLE_BOTTOM - finalY),
        underflowLines: Math.round((AVAILABLE_BOTTOM - finalY) / 14),
        sections, appliedLevel: level.name, hardOverflow: false,
      };
    }
  }
  const overflowPt = last.finalY - AVAILABLE_BOTTOM;
  const overflowLines = Math.round(overflowPt / 14);
  return {
    fits: false, finalY: last.finalY, availableHeight: AVAILABLE_BOTTOM,
    overflowPoints: Math.round(overflowPt), overflowLines,
    underflowPoints: 0, underflowLines: 0,
    sections: last.sections, appliedLevel: last.level,
    hardOverflow: overflowLines > HARD_OVERFLOW_LINE_THRESHOLD,
    recommendation: buildFitRecommendation(last.sections, overflowLines),
  };
}

function render(content) {
  const m = measure(content);
  if (m.hardOverflow) {
    const err = new Error(
      `Content is too long to render legibly on this template even at maximum compaction ` +
      `(about ${m.overflowLines} line(s) over one page). ${m.recommendation}`
    );
    err.hardOverflow = true;
    err.recommendation = m.recommendation;
    throw err;
  }
  const level = FIT_LEVELS.find(l => l.name === m.appliedLevel) || FIT_LEVELS[0];
  const presentSections = m.sections.filter(s => s.present).length;
  const numGaps = Math.max(1, presentSections);
  const stretchPerGap = (!m.fits || presentSections === 0) ? 0 : m.underflowPoints / numGaps;

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  layout(doc, content, { draw: true, stretchPerGap, ...level.opts });
  doc.end();
  return done;
}

// No photo in this template. cv-chat.js reads this flag to skip the photo
// step and ignore any attached photo.
const noPhoto = true;

module.exports = { measure, render, PAGE_W, PAGE_H, noPhoto };