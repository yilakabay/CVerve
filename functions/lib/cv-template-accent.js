// functions/lib/cv-template-accent.js
//
// "Quiet Accent" CV template — a single-column, NO-photo, ATS-friendly
// resume with a restrained color treatment. Name and job title sit left,
// contact details sit right on the same header row; one thin accent rule
// separates the header from the body; section labels are small,
// letter-spaced and colored, with a light hairline beside them.
//
// This template never uses a profile photo. `noPhoto = true` below tells
// cv-chat.js to skip the photo step and ignore any attached photo.
//
// Same measure()/render() contract as every other template.
//
// ── Safety rules (shared, from cv-shared.js) ──────────────────────────────
// • Every text run is wrapped to its real box width (wrapLines). Nothing is
//   cut with "..." and no line is silently dropped.
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
//   name, subtitle,
//   contact: { phone, email, location, linkedin },   // any field may be omitted
//   profile,
//   skills: string[],
//   languages: [{ name, level }],
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
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
// One accent color, used sparingly: subtitle, section labels, header rule,
// bullet marks, and experience/education dates. Everything else is ink/gray.
const INK = '#20242A';
const BODY = '#3C4147';
const MUTED = '#848B92';
const RULE = '#DCDFE3';
const ACCENT = '#8A5A33';   // change this one value to retheme

// ---------- Layout ----------
const MARGIN_L = 50.0;
const MARGIN_R = PAGE_W - 50.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const CONTACT_COL_W = 190.0;
const NAME_COL_W = CONTENT_W - CONTACT_COL_W - 18;
const AVAILABLE_BOTTOM = PAGE_H - 34;

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

  // ── Header: name + title on the left, contact block on the right ──────
  const NAME_TOP = 44.0;
  const NAME_SIZES = [23, 20, 18, 16];
  const nameText = content.name || '';
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, NAME_COL_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, NAME_COL_W);
  const nameLH = nameSize * 1.14;
  let leftY = block(doc, nameLines, MARGIN_L, NAME_TOP, { font: 'Helvetica-Bold', size: nameSize, color: INK, leading: nameLH, draw });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle, 'Helvetica', 11, NAME_COL_W);
    leftY = block(doc, subLines, MARGIN_L, leftY + 4, { font: 'Helvetica', size: 11, color: ACCENT, leading: 14.5, draw }) + 4;
  }

  // Contact block: right-aligned column. Long values wrap inside the column
  // instead of running left into the name.
  const contactParts = [
    content.contact?.email,
    content.contact?.phone,
    content.contact?.location,
    content.contact?.linkedin,
  ].filter(Boolean);
  const CONTACT_SIZE = 9.4, CONTACT_LH = 14;
  const contactX = MARGIN_R - CONTACT_COL_W;
  let rightY = NAME_TOP + 3;
  contactParts.forEach(part => {
    const ls = wrapLines(doc, part, 'Helvetica', CONTACT_SIZE, CONTACT_COL_W);
    if (draw) {
      doc.font('Helvetica').fontSize(CONTACT_SIZE).fillColor(BODY);
      ls.forEach((ln, i) => {
        const w = doc.widthOfString(ln);
        doc.text(ln, MARGIN_R - w, rightY + i * CONTACT_LH, { lineBreak: false });
      });
    }
    rightY += ls.length * CONTACT_LH;
  });

  const headerBottom = Math.max(leftY, rightY) + 10;
  if (draw) {
    doc.strokeColor(ACCENT).lineWidth(1.1).moveTo(MARGIN_L, headerBottom).lineTo(MARGIN_R, headerBottom).stroke();
  }
  let y = headerBottom + 20;

  // ── Section heading: small letter-spaced accent label + hairline.
  // Long titles wrap instead of running past the margin. ─────────────────
  function heading(label, yTop) {
    const text = String(label || '').toUpperCase();
    const lines = wrapLines(doc, text, 'Helvetica-Bold', 9.6, CONTENT_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9.6).fillColor(ACCENT);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 13, { characterSpacing: 1.3, lineBreak: false }));
      const last = lines[lines.length - 1];
      const tw = doc.widthOfString(last) + last.length * 1.3;
      const ruleY = yTop + (lines.length - 1) * 13 + 5;
      if (lines.length === 1) {
        doc.strokeColor(RULE).lineWidth(0.75).moveTo(MARGIN_L + tw + 10, ruleY).lineTo(MARGIN_R, ruleY).stroke();
      } else {
        doc.strokeColor(RULE).lineWidth(0.75).moveTo(MARGIN_L, yTop + lines.length * 13 + 1).lineTo(MARGIN_R, yTop + lines.length * 13 + 1).stroke();
      }
    }
    return yTop + (lines.length - 1) * 13 + 18;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 13.2, size);
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, CONTENT_W);
    const y2 = block(doc, lines, MARGIN_L, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  // Flat bullet list wrapped to full width, with an accent dash marker.
  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 12.8, size);
    const indent = opts.indent ?? 12;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, CONTENT_W - indent);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(size).fillColor(ACCENT);
        doc.text('–', MARGIN_L, cy, { lineBreak: false });
      }
      cy = block(doc, lines, MARGIN_L + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1.5 : 3;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // ── Professional Summary ──────────────────────────────────────────────
  if (content.profile) {
    y = heading('Professional Summary', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + gapPx(13) + GS;
  } else track('profile', 0, false);

  // ── Core Competencies ─────────────────────────────────────────────────
  if (content.skills && content.skills.length) {
    y = heading('Core Competencies', y);
    const r = bullets(content.skills, y, { size: 9.6, leading: 13.6 });
    track('skills', r.lines, true);
    y = r.y + gapPx(11) + GS;
  } else track('skills', 0, false);

  // ── Languages ─────────────────────────────────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = bullets(langItems, y, { size: 9.6, leading: 13.6 });
    track('languages', r.lines, true);
    y = r.y + gapPx(11) + GS;
  } else track('languages', 0, false);

  // ── Professional Experience ───────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Professional Experience', y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const orgRole = [exp.org, exp.role].filter(Boolean).join(' | ');
      const headerR = expTitleDateRow(doc, { org: orgRole, date: exp.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.2, titleColor: INK,
        dateFont: 'Helvetica-Oblique', dateSize: 9, dateColor: ACCENT,
        lineH: 13, gap: 10, draw
      });
      const br = bullets(exp.bullets || [], headerR.y + 2, { size: 9.5, leading: 13.4 });
      linesUsed += headerR.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(7) : 0);
    });
    track('experience', linesUsed, true);
    y += gapPx(12) + GS;
  } else track('experience', 0, false);

  // ── Education ─────────────────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const headerR = expTitleDateRow(doc, { org: edu.school || '', date: edu.dateRange }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.2, titleColor: INK,
        dateFont: 'Helvetica-Oblique', dateSize: 9, dateColor: ACCENT,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y + 1;
      linesUsed += headerR.lines;
      if (edu.degree) { const r = para(edu.degree, yy, { size: 9.6, leading: 13 }); yy = r.y; linesUsed += r.lines; }
      if (edu.extra) { const r = para(edu.extra, yy, { size: 9.4, leading: 12.6, color: MUTED }); yy = r.y; linesUsed += r.lines; }
      y = yy + (idx < eduList.length - 1 ? gapPx(7) : 0);
    });
    track('education', linesUsed, true);
    y += gapPx(12) + GS;
  } else track('education', 0, false);

  // ── Certifications & Awards ───────────────────────────────────────────
  const hasAchievements = content.achievements && content.achievements.length;
  const hasCerts = content.certifications && content.certifications.length;
  if (hasAchievements || hasCerts) {
    y = heading('Certifications & Awards', y);
    let linesUsed = 0;
    if (hasAchievements) {
      const r = bullets(content.achievements, y, { size: 9.6, leading: 13.6 });
      y = r.y; linesUsed += r.lines;
    }
    if (hasCerts) {
      const certLines = content.certifications.map(c => [c.title, c.issuer].filter(Boolean).join(' — '));
      const r = bullets(certLines, y, { size: 9.6, leading: 13.6 });
      y = r.y; linesUsed += r.lines;
    }
    track('certifications', linesUsed, true);
    y += gapPx(12) + GS;
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  // ── Custom sections ───────────────────────────────────────────────────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = bullets(cs.items, y, { size: 9.6, leading: 13.6 });
      y = r.y; linesUsed = r.lines;
    } else if (cs.text) {
      const r = para(cs.text, y);
      y = r.y; linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(12) + GS;
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

  return { finalY: Math.max(y, rightY), sections };
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