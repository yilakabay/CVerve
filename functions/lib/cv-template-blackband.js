// functions/lib/cv-template-blackband.js
//
// "Black Band" CV template — a bold left-aligned name, an all-caps job title,
// a small contact line, and a short decorative vertical rule at the top right.
// Each section label sits in a full-width solid black band with white text.
// Entry titles are bold with the date right-aligned on the same line. Skills
// and interests use a 2-column bullet grid. Single column, NO photo.
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
// • Section bands grow to fit a wrapped label instead of cutting it.
// • Custom sections render with the same band style.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name, subtitle,                                    // subtitle = job title
//   contact: { phone, email, location, linkedin },      // shown as one line under the title
//   experience: [{ org, role, dateRange, bullets: string[] }],   // "WORK EXPERIENCE"
//   skills: string[],                                    // "SKILLS" (2-column)
//   education: { degree, school, dateRange, extra } | [...],      // "EDUCATION"
//   achievements: string[],                              // "AWARDS"
//   certifications: [{ title, issuer }],                  // folded into AWARDS
//   languages: [{ name, level }],                         // own band, 2-column
//   references: [{ name, role, email, phone }],
//   customSections: [{ title, items, text }]              // items → 2-column, else paragraph
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const INK = '#141414';
const BODY = '#2E2E2E';
const MUTED = '#6B6B6B';
const BAND_BG = '#101010';   // change to retheme
const BAND_TEXT = '#FFFFFF';

// ---------- Layout ----------
const MARGIN_L = 44.0;
const MARGIN_R = PAGE_W - 44.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 30;
const BAND_LINE_H = 16.0;
const BAND_PAD_Y = 4.0;
const BAND_PAD_X = 16.0;

// Draws (or just measures) an already-wrapped block of lines. Returns new y.
function block(doc, lines, x, y, { font, size, color, leading, draw }) {
  if (draw) {
    doc.font(font).fontSize(size).fillColor(color);
    lines.forEach((ln, i) => doc.text(ln, x, y + i * leading, { lineBreak: false }));
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

  // ── Header: bold name, caps title, contact line, decorative rule ──────
  const NAME_TOP = 44.0;
  const RULE_W = CONTENT_W * 0.14;
  const HEADER_TEXT_W = CONTENT_W - RULE_W - 24;

  const NAME_SIZES = [30, 26, 23, 20];
  const nameText = content.name || '';
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, HEADER_TEXT_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, HEADER_TEXT_W);
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, { font: 'Helvetica-Bold', size: nameSize, color: INK, leading: nameSize * 1.1, draw });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle.toUpperCase(), 'Helvetica', 12.5, HEADER_TEXT_W);
    cur = block(doc, subLines, MARGIN_L, cur + 4, { font: 'Helvetica', size: 12.5, color: INK, leading: 16, draw }) + 4;
  }

  const contactParts = [
    content.contact?.location, content.contact?.email, content.contact?.linkedin || content.contact?.phone,
  ].filter(Boolean);
  if (contactParts.length) {
    const cl = wrapLines(doc, contactParts.join('   |   '), 'Helvetica', 9.6, HEADER_TEXT_W);
    cur = block(doc, cl, MARGIN_L, cur + 6, { font: 'Helvetica', size: 9.6, color: BODY, leading: 13, draw }) + 2;
  }

  const headerBottom = cur + 14;
  if (draw) {
    doc.strokeColor(INK).lineWidth(1.2).moveTo(MARGIN_R - RULE_W, NAME_TOP).lineTo(MARGIN_R - RULE_W, headerBottom - 14).stroke();
  }

  let y = headerBottom + 4;

  // ── Section band: solid black bar, white label (wrapped, band grows if needed)
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 11, CONTENT_W - BAND_PAD_X * 2);
    const bandH = lines.length * BAND_LINE_H + BAND_PAD_Y * 2;
    if (draw) {
      doc.rect(MARGIN_L - BAND_PAD_X, yTop, CONTENT_W + BAND_PAD_X * 2, bandH).fill(BAND_BG);
      block(doc, lines, MARGIN_L, yTop + BAND_PAD_Y + 2, { font: 'Helvetica-Bold', size: 11, color: BAND_TEXT, leading: BAND_LINE_H, draw });
    }
    return yTop + bandH + 10;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.6, leading = tighten(opts.leading || 13.8, size);
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, CONTENT_W);
    const y2 = block(doc, lines, MARGIN_L, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 13.2, size);
    const indent = opts.indent ?? 13;
    const x = opts.x ?? MARGIN_L, width = opts.width ?? CONTENT_W;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, width - indent);
      if (draw) doc.font('Helvetica').fontSize(size).fillColor(INK).text('•', x, cy, { lineBreak: false });
      cy = block(doc, lines, x + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1 : 2;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // Two-column bullet grid: first half left, second half right.
  function twoColGrid(items, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 13.6, size);
    const gap = 20, colW = (CONTENT_W - gap) / 2;
    const half = Math.ceil(items.length / 2);
    const colItems = [items.slice(0, half), items.slice(half)];
    let maxY = yTop, totalLines = 0;
    colItems.forEach((list, col) => {
      const x = MARGIN_L + col * (colW + gap);
      const r = bullets(list, yTop, { size, leading, x, width: colW, indent: 12 });
      maxY = Math.max(maxY, r.y); totalLines += r.lines;
    });
    return { y: maxY, lines: totalLines };
  }

  // ── Work Experience ─────────────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Work Experience', y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const titleLine = [exp.role, exp.org].filter(Boolean).join(' | ');
      const headerR = expTitleDateRow(doc, { org: titleLine, date: exp.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10, titleColor: INK,
        dateFont: 'Helvetica', dateSize: 9.2, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      const br = bullets(exp.bullets || [], headerR.y + 2);
      linesUsed += headerR.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(6) : 0);
    });
    track('experience', linesUsed, true);
    y += gapPx(8) + GS;
  } else track('experience', 0, false);

  // ── Skills (2-column grid) ───────────────────────────────────────────
  if (content.skills && content.skills.length) {
    y = heading('Skills', y);
    const r = twoColGrid(content.skills, y);
    track('skills', r.lines, true);
    y = r.y + gapPx(8) + GS;
  } else track('skills', 0, false);

  // ── Education ───────────────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const titleLine = [edu.degree || edu.level, edu.school].filter(Boolean).join(' | ');
      const headerR = expTitleDateRow(doc, { org: titleLine, date: edu.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10, titleColor: INK,
        dateFont: 'Helvetica', dateSize: 9.2, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y + 2;
      linesUsed += headerR.lines;
      const extraItems = edu.extra
        ? String(edu.extra).split(/\.\s*(?=[A-Z])|\n/).map(s => s.trim()).filter(Boolean)
        : [];
      if (extraItems.length) { const r = bullets(extraItems, yy); yy = r.y; linesUsed += r.lines; }
      y = yy + (idx < eduList.length - 1 ? gapPx(6) : 0);
    });
    track('education', linesUsed, true);
    y += gapPx(8) + GS;
  } else track('education', 0, false);

  // ── Custom sections (2-column grid for items, else paragraph) ───────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Interests', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = twoColGrid(cs.items, y); y = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = para(cs.text, y); y = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(8) + GS;
  });

  // ── Awards (achievements + structured certifications) ───────────────
  const hasAchievements = content.achievements && content.achievements.length;
  const hasCerts = content.certifications && content.certifications.length;
  if (hasAchievements || hasCerts) {
    y = heading('Awards', y);
    let linesUsed = 0;
    if (hasAchievements) { const r = bullets(content.achievements, y); y = r.y; linesUsed += r.lines; }
    if (hasCerts) {
      const certLines = content.certifications.map(c => [c.title, c.issuer].filter(Boolean).join(' — '));
      const r = bullets(certLines, y); y = r.y; linesUsed += r.lines;
    }
    track('certifications', linesUsed, true);
    y += gapPx(8) + GS;
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  // ── Languages (own band, 2-column grid) ─────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = twoColGrid(langItems, y);
    track('languages', r.lines, true);
    y = r.y + gapPx(8) + GS;
  } else track('languages', 0, false);

  // ── References (every reference kept) ───────────────────────────────
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = heading(refList.length > 1 ? 'References' : 'Reference', y);
    const cols = refList.length > 1 ? 2 : 1;
    const gap = 24;
    const colW = (CONTENT_W - gap * (cols - 1)) / cols;
    const colY = new Array(cols).fill(y);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      const col = i % cols;
      const bx = MARGIN_L + col * (colW + gap);
      let by = colY[col];
      const nl = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 10, colW);
      by = block(doc, nl, bx, by, { font: 'Helvetica-Bold', size: 10, color: INK, leading: 13, draw });
      linesUsed += nl.length;
      if (ref.role) {
        const rl = wrapLines(doc, ref.role, 'Helvetica', 9, colW);
        by = block(doc, rl, bx, by, { font: 'Helvetica', size: 9, color: MUTED, leading: 12, draw });
        linesUsed += rl.length;
      }
      [['Email', ref.email], ['Phone', ref.phone]].forEach(([label, val]) => {
        if (!val) return;
        const labelW = 36;
        const vl = wrapLines(doc, String(val), 'Helvetica', 8.8, colW - labelW);
        if (draw) doc.font('Helvetica-Bold').fontSize(8.8).fillColor(INK).text(label + ':', bx, by, { lineBreak: false });
        by = block(doc, vl, bx + labelW, by, { font: 'Helvetica', size: 8.8, color: BODY, leading: 12, draw });
        linesUsed += vl.length;
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
        underflowLines: Math.round((AVAILABLE_BOTTOM - finalY) / 13.5),
        sections, appliedLevel: level.name, hardOverflow: false,
      };
    }
  }
  const overflowPt = last.finalY - AVAILABLE_BOTTOM;
  const overflowLines = Math.round(overflowPt / 13.5);
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