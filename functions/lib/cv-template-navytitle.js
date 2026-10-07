// functions/lib/cv-template-navytitle.js
//
// "Navy Title" CV template — a bold centered name in navy, a bold centered
// job title, a centered contact line, and a thick navy rule closing the
// header. Each section has a bold navy label with no rule under it; a thin
// gray hairline closes the section instead. Experience puts the role bold-left
// and "Company | Dates" bold-right on one line. Skills are labeled groups of
// comma-separated text, not bullets. Single column, NO photo.
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
//   name, subtitle,
//   contact: { phone, email, location, linkedin },
//   profile,
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
//   skillGroups: [{ label, items: string[] }],   // optional labeled groups
//   skills: string[],                             // used if skillGroups is absent
//   achievements: string[],
//   certifications: [{ title, issuer }],
//   languages: [{ name, level }],
//   references: [{ name, role, email, phone }],
//   customSections: [{ title, items, text }]
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const NAVY = '#1F3A5F';     // change this one value to retheme
const INK = '#1C1E21';
const BODY = '#34373C';
const MUTED = '#6B6F75';
const RULE = '#AEB2B8';

// ---------- Layout ----------
const MARGIN_L = 48.0;
const MARGIN_R = PAGE_W - 48.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 32;

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

  // ── Header: centered navy name, bold title, contact line, thick rule ──
  const NAME_TOP = 34.0;
  const NAME_SIZES = [26, 23, 20, 18];
  const nameText = (content.name || '').toUpperCase();
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, CONTENT_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, CONTENT_W);
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, {
    font: 'Helvetica-Bold', size: nameSize, color: NAVY, leading: nameSize * 1.12, draw, align: 'center'
  });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle.toUpperCase(), 'Helvetica-Bold', 12.5, CONTENT_W);
    cur = block(doc, subLines, MARGIN_L, cur + 3, {
      font: 'Helvetica-Bold', size: 12.5, color: NAVY, leading: 16, draw, align: 'center'
    }) + 3;
  }

  const contactParts = [content.contact?.location, content.contact?.phone, content.contact?.email, content.contact?.linkedin].filter(Boolean);
  let contactBottom = cur + 8;
  if (contactParts.length) {
    const SEP = '    |    ';
    const full = contactParts.join(SEP);
    const CONTACT_SIZE = 9.8;
    const cLines = wrapLines(doc, full, 'Helvetica', CONTACT_SIZE, CONTENT_W);
    contactBottom = block(doc, cLines, MARGIN_L, contactBottom, {
      font: 'Helvetica', size: CONTACT_SIZE, color: BODY, leading: 13, draw, align: 'center'
    });
  }

  const thickRuleY = contactBottom + 10;
  if (draw) doc.strokeColor(NAVY).lineWidth(3).moveTo(MARGIN_L, thickRuleY).lineTo(MARGIN_R, thickRuleY).stroke();

  let y = thickRuleY + 22;

  // ── Section heading: bold navy label (wrapped if long), no rule under it
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 12.5, CONTENT_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(NAVY);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 15, { characterSpacing: 0.4, lineBreak: false }));
    }
    return yTop + lines.length * 15 + 4;
  }
  // Thin gray hairline that closes a section.
  function closingRule(yTop) {
    if (draw) doc.strokeColor(RULE).lineWidth(0.8).moveTo(MARGIN_L, yTop).lineTo(MARGIN_R, yTop).stroke();
    return yTop + 13;
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

  // ── Profile Summary ─────────────────────────────────────────────────
  if (content.profile) {
    y = heading('Profile Summary', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = closingRule(r.y + gapPx(6) + GS);
  } else track('profile', 0, false);

  // ── Experience ──────────────────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Experience', y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const metaLine = [exp.org, exp.dateRange].filter(Boolean).join(' | ');
      const headerR = expTitleDateRow(doc, { org: exp.role || '', date: metaLine }, MARGIN_L, y, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.2, titleColor: INK,
        dateFont: 'Helvetica-Bold', dateSize: 9.4, dateColor: NAVY,
        lineH: 13, gap: 10, draw
      });
      const br = bullets(exp.bullets || [], headerR.y + 2);
      linesUsed += headerR.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(10) : 0);
    });
    track('experience', linesUsed, true);
    y = closingRule(y + gapPx(6) + GS);
  } else track('experience', 0, false);

  // ── Education ───────────────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const degreeLines = wrapLines(doc, edu.degree || edu.level || '', 'Helvetica-Bold', 10, CONTENT_W);
      y = block(doc, degreeLines, MARGIN_L, y, { font: 'Helvetica-Bold', size: 10, color: INK, leading: 13, draw });
      linesUsed += degreeLines.length;
      const metaLine = [edu.school, edu.dateRange].filter(Boolean).join(', ');
      if (metaLine) { const r = para(metaLine, y, { size: 9.4, leading: 12.8 }); y = r.y; linesUsed += r.lines; }
      if (edu.extra) { const r = para(edu.extra, y, { size: 9.2, leading: 12.6, color: MUTED }); y = r.y; linesUsed += r.lines; }
      y += idx < eduList.length - 1 ? gapPx(8) : 0;
    });
    track('education', linesUsed, true);
    y = closingRule(y + gapPx(6) + GS);
  } else track('education', 0, false);

  // ── Skills: bold category label, then a plain comma-separated line ──
  const skillGroups = (content.skillGroups && content.skillGroups.length)
    ? content.skillGroups
    : (content.skills && content.skills.length ? [{ label: null, items: content.skills }] : []);
  if (skillGroups.length) {
    y = heading('Skills', y);
    let linesUsed = 0;
    skillGroups.forEach((grp, idx) => {
      if (grp.label) {
        const ll = wrapLines(doc, grp.label, 'Helvetica-Bold', 9.6, CONTENT_W);
        y = block(doc, ll, MARGIN_L, y, { font: 'Helvetica-Bold', size: 9.6, color: INK, leading: 13, draw });
        linesUsed += ll.length;
      }
      const r = para((grp.items || []).join(', '), y, { size: 9.4, leading: 13 });
      y = r.y; linesUsed += r.lines;
      y += idx < skillGroups.length - 1 ? gapPx(6) : 0;
    });
    track('skills', linesUsed, true);
    y = closingRule(y + gapPx(6) + GS);
  } else track('skills', 0, false);

  // ── Languages ───────────────────────────────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = para(langItems.join(', '), y, { size: 9.4, leading: 13 });
    track('languages', r.lines, true);
    y = closingRule(r.y + gapPx(6) + GS);
  } else track('languages', 0, false);

  // ── Achievements (+ structured certifications) ──────────────────────
  const hasAchievements = content.achievements && content.achievements.length;
  const hasCerts = content.certifications && content.certifications.length;
  if (hasAchievements || hasCerts) {
    y = heading('Achievements', y);
    let linesUsed = 0;
    if (hasAchievements) { const r = bullets(content.achievements, y); y = r.y; linesUsed += r.lines; }
    if (hasCerts) {
      const certLines = content.certifications.map(c => [c.title, c.issuer].filter(Boolean).join(' — '));
      const r = bullets(certLines, y); y = r.y; linesUsed += r.lines;
    }
    track('certifications', linesUsed, true);
    y = closingRule(y + gapPx(6) + GS);
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  // ── Custom sections ─────────────────────────────────────────────────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = bullets(cs.items, y); y = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = para(cs.text, y); y = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y = closingRule(y + gapPx(6) + GS);
  });

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
    y = Math.max(...colY);
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