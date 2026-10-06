// functions/lib/cv-template-banded.js
//
// "Banded Gray" CV template — centered name, job title and contact line
// under a thin rule, then each section introduced by a full-width light
// gray band. Bold entry titles with the date right-aligned, plain bullets,
// and skills in a 3-column grid. Single column, NO photo.
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
// • Section bands grow to fit a wrapped heading instead of cutting it.
// • Custom sections render in the main flow with the same band style.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name, subtitle,
//   contact: { phone, email, location, linkedin },   // any field may be omitted
//   profile,
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
//   skills: string[],
//   languages: [{ name, level }],
//   achievements: string[],
//   certifications: [{ title, issuer }],
//   references: [{ name, role, email, phone }],
//   customSections: [{ title, items, text }]
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const INK = '#1A1C1F';
const BODY = '#34373C';
const MUTED = '#6C7076';
const BAND_BG = '#D8DEE4';   // light gray-blue section band — change to retheme
const RULE = '#C7CBD1';

// ---------- Layout ----------
const MARGIN_L = 44.0;
const MARGIN_R = PAGE_W - 44.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 30;
const BAND_LINE_H = 16.0;
const BAND_PAD_Y = 6.0;
const BAND_PAD_X = 16.0;

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

  // ── Header: centered name, job title, rule, centered contact line ─────
  const NAME_TOP = 46.0;
  const NAME_SIZES = [25, 22, 20, 18];
  const nameText = (content.name || '').toUpperCase();
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, CONTENT_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, CONTENT_W);
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, {
    font: 'Helvetica-Bold', size: nameSize, color: INK, leading: nameSize * 1.14, draw, align: 'center'
  });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle, 'Helvetica-Bold', 11.5, CONTENT_W);
    cur = block(doc, subLines, MARGIN_L, cur + 2, {
      font: 'Helvetica-Bold', size: 11.5, color: INK, leading: 15, draw, align: 'center'
    }) + 2;
  }

  const ruleY = cur + 8;
  if (draw) doc.strokeColor(RULE).lineWidth(0.8).moveTo(MARGIN_L, ruleY).lineTo(MARGIN_R, ruleY).stroke();

  // Contact line, centered. Parts are packed onto as many centered lines as needed.
  const contactParts = [
    content.contact?.email,
    content.contact?.phone,
    content.contact?.location,
    content.contact?.linkedin,
  ].filter(Boolean);
  let contactBottom = ruleY + 8;
  if (contactParts.length) {
    const SEP = '   |   ';
    const CONTACT_SIZE = 9.6;
    doc.font('Helvetica').fontSize(CONTACT_SIZE);
    const full = contactParts.join(SEP);
    let contactLines;
    if (doc.widthOfString(full) <= CONTENT_W) {
      contactLines = [full];
    } else {
      contactLines = [];
      let lineParts = [];
      contactParts.forEach(part => {
        const candidate = lineParts.concat(part).join(SEP);
        if (lineParts.length && doc.widthOfString(candidate) > CONTENT_W) {
          contactLines.push(lineParts.join(SEP));
          lineParts = [part];
        } else {
          lineParts.push(part);
        }
      });
      if (lineParts.length) contactLines.push(lineParts.join(SEP));
    }
    contactBottom = block(doc, contactLines, MARGIN_L, contactBottom, {
      font: 'Helvetica', size: CONTACT_SIZE, color: BODY, leading: 13, draw, align: 'center'
    });
  }

  let y = contactBottom + 18;

  // ── Section band: full-width gray rectangle sized to its wrapped label ─
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 10.5, CONTENT_W - BAND_PAD_X * 2);
    const bandH = lines.length * BAND_LINE_H + BAND_PAD_Y * 2;
    if (draw) {
      doc.rect(MARGIN_L - BAND_PAD_X, yTop, CONTENT_W + BAND_PAD_X * 2, bandH).fill(BAND_BG);
      block(doc, lines, MARGIN_L, yTop + BAND_PAD_Y + 2, { font: 'Helvetica-Bold', size: 10.5, color: INK, leading: BAND_LINE_H, draw });
    }
    return yTop + bandH + 10;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 13.0, size);
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, CONTENT_W);
    const y2 = block(doc, lines, MARGIN_L, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = tighten(opts.leading || 12.6, size);
    const indent = 13;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, CONTENT_W - indent);
      if (draw) {
        doc.font('Helvetica').fontSize(size).fillColor(INK);
        doc.text('•', MARGIN_L, cy, { lineBreak: false });
      }
      cy = block(doc, lines, MARGIN_L + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1 : 2.5;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // Three-column grid for skills and languages.
  function grid(items, yTop, cols = 3) {
    const size = 9.2, leading = tighten(13, size);
    const colW = CONTENT_W / cols;
    let cy = yTop, totalLines = 0;
    for (let row = 0; row * cols < items.length; row++) {
      let maxLines = 1;
      const rowLines = [];
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        if (i >= items.length) { rowLines.push(null); continue; }
        const lines = wrapLines(doc, String(items[i]), 'Helvetica', size, colW - 16);
        rowLines.push(lines);
        maxLines = Math.max(maxLines, lines.length);
      }
      if (draw) {
        rowLines.forEach((lines, col) => {
          if (!lines) return;
          const cx = MARGIN_L + col * colW;
          doc.font('Helvetica').fontSize(size).fillColor(INK);
          doc.text('•', cx, cy, { lineBreak: false });
          block(doc, lines, cx + 10, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
        });
      }
      cy += maxLines * leading + (tightLeading ? 1 : 3);
      totalLines += maxLines;
    }
    return { y: cy, lines: totalLines };
  }

  // ── Summary ─────────────────────────────────────────────────────────
  if (content.profile) {
    y = heading('Summary', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + gapPx(13) + GS;
  } else track('profile', 0, false);

  // ── Work Experience ─────────────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Work Experience', y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const titleLine = [exp.role, exp.org].filter(Boolean).join(', ');
      const headerR = expTitleDateRow(doc, { org: titleLine, date: exp.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10, titleColor: INK,
        dateFont: 'Helvetica-Bold', dateSize: 9.4, dateColor: INK,
        lineH: 13, gap: 10, draw
      });
      const br = bullets(exp.bullets || [], headerR.y + 3);
      linesUsed += headerR.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(8) : 0);
    });
    track('experience', linesUsed, true);
    y += gapPx(13) + GS;
  } else track('experience', 0, false);

  // ── Education ───────────────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const headerR = expTitleDateRow(doc, { org: edu.degree || edu.level || '', date: edu.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10, titleColor: INK,
        dateFont: 'Helvetica-Bold', dateSize: 9.4, dateColor: INK,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y + 1;
      linesUsed += headerR.lines;
      if (edu.school) { const r = para(edu.school, yy, { size: 9.4, leading: 12.8 }); yy = r.y; linesUsed += r.lines; }
      if (edu.extra) {
        const items = String(edu.extra).split(/\.\s*(?=[A-Z])|\n/).map(s => s.trim()).filter(Boolean);
        const r = bullets(items.length > 1 ? items : [edu.extra], yy + 2, { size: 9.2, leading: 12.6 });
        yy = r.y; linesUsed += r.lines;
      }
      y = yy + (idx < eduList.length - 1 ? gapPx(8) : 0);
    });
    track('education', linesUsed, true);
    y += gapPx(13) + GS;
  } else track('education', 0, false);

  // ── Key Skills (3-column grid) ───────────────────────────────────────
  if (content.skills && content.skills.length) {
    y = heading('Key Skills', y);
    const r = grid(content.skills, y);
    track('skills', r.lines, true);
    y = r.y + gapPx(13) + GS;
  } else track('skills', 0, false);

  // ── Languages (same grid) ───────────────────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = grid(langItems, y, Math.min(3, langItems.length));
    track('languages', r.lines, true);
    y = r.y + gapPx(13) + GS;
  } else track('languages', 0, false);

  // ── Certifications & Awards ─────────────────────────────────────────
  const hasAchievements = content.achievements && content.achievements.length;
  const hasCerts = content.certifications && content.certifications.length;
  if (hasAchievements || hasCerts) {
    y = heading('Certifications & Awards', y);
    let linesUsed = 0;
    if (hasAchievements) { const r = bullets(content.achievements, y); y = r.y; linesUsed += r.lines; }
    if (hasCerts) {
      const certLines = content.certifications.map(c => [c.title, c.issuer].filter(Boolean).join(' — '));
      const r = bullets(certLines, y); y = r.y; linesUsed += r.lines;
    }
    track('certifications', linesUsed, true);
    y += gapPx(13) + GS;
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  // ── Custom sections ─────────────────────────────────────────────────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = bullets(cs.items, y); y = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = para(cs.text, y); y = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(13) + GS;
  });

  // ── References (side by side for 2+, stacked for one) ─────────────────
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
        if (draw) {
          doc.font('Helvetica-Bold').fontSize(8.8).fillColor(INK);
          doc.text(label + ':', bx, by, { lineBreak: false });
        }
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