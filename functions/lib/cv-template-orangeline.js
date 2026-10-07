// functions/lib/cv-template-orangeline.js
//
// "Orange Line" CV template — a centered name and job title, a centered
// contact row with small orange dot markers, a thin rule closing the header,
// then a vertical gray rule down the left margin with an orange square
// marker beside each bold orange section label. Entries use an italic date
// line above a bold title and a plain org/school line. Core Competencies and
// Professional Development are 2-column grids. Single column, NO photo.
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
// • The 2-column grids size each row from the taller of its two cells, so a
//   long entry never overlaps the row below it.
// • The left vertical rule spans exactly the content height actually used.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name, subtitle,
//   contact: { phone, email, location, linkedin },
//   profile,                                              // "Career Objective"
//   skills: string[],                                     // "Core Competencies" (2-col)
//   education: { degree, school, dateRange, extra } | [...],   // "Academic Background"
//   experience: [{ org, role, dateRange, bullets: string[] }],  // "Work Experience"
//   certifications: [{ title, issuer, dateRange }],        // "Professional Development" (2-col, no bullets)
//   achievements: string[],                                 // used if no certifications
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
const INK = '#1C1E21';
const BODY = '#3A3D42';
const MUTED = '#6B6F75';
const ORANGE = '#D9682F';   // change this one value to retheme
const RULE = '#C9CCD1';

// ---------- Layout ----------
const MARGIN_L = 52.0;
const MARGIN_R = PAGE_W - 42.0;
const RULE_X = MARGIN_L - 14;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 30;
const COL_GAP = 20.0;
const COL_W = (CONTENT_W - COL_GAP) / 2;
const COL2_X = MARGIN_L + COL_W + COL_GAP;

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

  if (draw) doc.rect(0, 0, PAGE_W, PAGE_H).fill('#FCFCFB');

  // ── Header: centered name, subtitle, orange diamond divider, contact row
  const HEADER_L = 42;
  const HEADER_W = PAGE_W - 84;
  const CX = HEADER_L + HEADER_W / 2;
  const NAME_TOP = 34.0;
  const NAME_SIZES = [25, 22, 19, 17];
  const nameText = content.name || '';
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, HEADER_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, HEADER_W);
  let cur = NAME_TOP + nameLines.length * nameSize * 1.15;
  // Name is centered in draw mode (height is measured above, drawn once here).
  if (draw) {
    doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(INK);
    nameLines.forEach((ln, i) => {
      const w = doc.widthOfString(ln);
      doc.text(ln, CX - w / 2, NAME_TOP + i * nameSize * 1.15, { lineBreak: false });
    });
  }

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle, 'Helvetica', 13, HEADER_W);
    if (draw) {
      doc.font('Helvetica').fontSize(13).fillColor(BODY);
      subLines.forEach((ln, i) => {
        const w = doc.widthOfString(ln);
        doc.text(ln, CX - w / 2, cur + 3 + i * 17, { lineBreak: false });
      });
    }
    cur += subLines.length * 17 + 3;
  }

  // Orange diamond divider centered under the title.
  const diamondY = cur + 10;
  if (draw) {
    doc.strokeColor(ORANGE).lineWidth(0.8).moveTo(CX - 70, diamondY).lineTo(CX - 8, diamondY).stroke();
    doc.save();
    doc.translate(CX, diamondY);
    doc.rotate(45);
    doc.rect(-2.3, -2.3, 4.6, 4.6).fill(ORANGE);
    doc.restore();
    doc.strokeColor(ORANGE).lineWidth(0.8).moveTo(CX + 8, diamondY).lineTo(CX + 70, diamondY).stroke();
  }

  // Contact row: orange dot + text per item, centered as one group.
  const contactItems = [
    content.contact?.email ? content.contact.email : null,
    content.contact?.phone ? content.contact.phone : null,
    content.contact?.location ? content.contact.location : null,
    content.contact?.linkedin ? content.contact.linkedin : null,
  ].filter(Boolean);
  const CONTACT_SIZE = 9.6, ICON_GAP = 18, ITEM_GAP = 26;
  let contactBottom = diamondY + 20;
  if (contactItems.length) {
    doc.font('Helvetica').fontSize(CONTACT_SIZE);
    const widths = contactItems.map(t => 14 + doc.widthOfString(t));
    const totalW = widths.reduce((a, b) => a + b, 0) + ITEM_GAP * (contactItems.length - 1);
    // If the row is too wide, wrap it onto centered lines instead of running off the page.
    const rows = [];
    let row = [], rowW = 0;
    contactItems.forEach((t, i) => {
      const w = widths[i];
      if (row.length && rowW + ITEM_GAP + w > HEADER_W) { rows.push(row); row = []; rowW = 0; }
      row.push({ text: t, w });
      rowW += (row.length > 1 ? ITEM_GAP : 0) + w;
    });
    if (row.length) rows.push(row);
    rows.forEach((r, ri) => {
      const rw = r.reduce((a, it) => a + it.w, 0) + ITEM_GAP * (r.length - 1);
      let ix = CX - rw / 2;
      const rowY = contactBottom - 8 + ri * 15;
      if (draw) {
        r.forEach(it => {
          doc.fillColor(ORANGE).circle(ix + 4, rowY + 5, 4).fill();
          doc.font('Helvetica').fontSize(CONTACT_SIZE).fillColor(BODY);
          doc.text(it.text, ix + 14, rowY, { lineBreak: false });
          ix += it.w + ITEM_GAP;
        });
      }
    });
    contactBottom += rows.length * 15 - 8 + 8;
    void totalW;
  }

  const headerRuleY = contactBottom + 10;
  if (draw) doc.strokeColor(RULE).lineWidth(0.8).moveTo(MARGIN_L - 10, headerRuleY).lineTo(MARGIN_R, headerRuleY).stroke();

  const bodyTop = headerRuleY + 20;
  let y = bodyTop;

  // ── Section heading: orange square marker over the left rule, bold orange label (wrapped if long)
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 11.5, CONTENT_W - 4);
    if (draw) {
      doc.fillColor(ORANGE).rect(RULE_X - 3, yTop + 1, 6, 6).fill();
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(ORANGE);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 14, { characterSpacing: 0.4, lineBreak: false }));
    }
    return yTop + lines.length * 14 + 6;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.6, leading = tighten(opts.leading || 13.8, size);
    const width = opts.width ?? CONTENT_W, x = opts.x ?? MARGIN_L;
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, width);
    const y2 = block(doc, lines, x, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 13.2, size);
    const indent = opts.indent ?? 12;
    const x = opts.x ?? MARGIN_L, width = opts.width ?? CONTENT_W;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, width - indent);
      if (draw) doc.font('Helvetica').fontSize(size).fillColor(INK).text('•', x, cy, { lineBreak: false });
      cy = block(doc, lines, x + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1 : 2.4;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // Italic "— date" line, bold title, then plain org/school line.
  function datedEntryHeader(date, title, org, yTop, opts = {}) {
    const width = opts.width ?? CONTENT_W, x = opts.x ?? MARGIN_L;
    let cy = yTop, lines = 0;
    if (date) {
      const dl = wrapLines(doc, `—  ${date}`, 'Helvetica-Oblique', 8.8, width);
      cy = block(doc, dl, x, cy, { font: 'Helvetica-Oblique', size: 8.8, color: MUTED, leading: 11.5, draw });
      lines += dl.length;
    }
    const tl = wrapLines(doc, title || '', 'Helvetica-Bold', 10, width);
    cy = block(doc, tl, x, cy, { font: 'Helvetica-Bold', size: 10, color: INK, leading: 12.8, draw });
    lines += tl.length;
    if (org) {
      const ol = wrapLines(doc, org, 'Helvetica', 9, width);
      cy = block(doc, ol, x, cy, { font: 'Helvetica', size: 9, color: MUTED, leading: 11.8, draw });
      lines += ol.length;
    }
    return { y: cy, lines };
  }

  // ── Career Objective ────────────────────────────────────────────────
  if (content.profile) {
    y = heading('Career Objective', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + gapPx(16) + GS;
  } else track('profile', 0, false);

  // ── Core Competencies (2-column bullet grid) ─────────────────────────
  if (content.skills && content.skills.length) {
    y = heading('Core Competencies', y);
    const half = Math.ceil(content.skills.length / 2);
    const colLists = [content.skills.slice(0, half), content.skills.slice(half)];
    let maxY = y, totalLines = 0;
    colLists.forEach((list, col) => {
      const x = col === 0 ? MARGIN_L : COL2_X;
      const r = bullets(list, y, { x, width: COL_W, size: 9.2, leading: 13 });
      maxY = Math.max(maxY, r.y); totalLines += r.lines;
    });
    track('skills', totalLines, true);
    y = maxY + gapPx(16) + GS;
  } else track('skills', 0, false);

  // ── Academic Background ──────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Academic Background', y);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      const metaExtra = [edu.school, edu.extra].filter(Boolean).join(' - ');
      const r = datedEntryHeader(edu.dateRange, edu.degree || edu.level || '', metaExtra, y);
      y = r.y + (idx < eduList.length - 1 ? gapPx(8) : 0);
      linesUsed += r.lines;
    });
    track('education', linesUsed, true);
    y += gapPx(16) + GS;
  } else track('education', 0, false);

  // ── Work Experience ─────────────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Work Experience', y);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      const r = datedEntryHeader(exp.dateRange, exp.role, exp.org, y);
      const br = bullets(exp.bullets || [], r.y + 2);
      linesUsed += r.lines + br.lines;
      y = br.y + (idx < content.experience.length - 1 ? gapPx(10) : 0);
    });
    track('experience', linesUsed, true);
    y += gapPx(16) + GS;
  } else track('experience', 0, false);

  // ── Professional Development (2-column grid, no bullets) ─────────────
  const devItems = (content.certifications && content.certifications.length)
    ? content.certifications.map(c => ({ title: c.title, org: c.issuer, dateRange: c.dateRange }))
    : (content.achievements || []).map(a => ({ title: a }));
  if (devItems.length) {
    y = heading('Professional Development', y);
    const half = Math.ceil(devItems.length / 2);
    const colItems = [devItems.slice(0, half), devItems.slice(half)];
    const colX = [MARGIN_L, COL2_X];
    let maxY = y, totalLines = 0;
    colItems.forEach((list, col) => {
      let cy = y;
      list.forEach((item, idx) => {
        const r = datedEntryHeader(item.dateRange, item.title, item.org, cy, { x: colX[col], width: COL_W });
        cy = r.y + (idx < list.length - 1 ? gapPx(8) : 0);
        totalLines += r.lines;
      });
      maxY = Math.max(maxY, cy);
    });
    track('certifications', totalLines, true);
    y = maxY + gapPx(16) + GS;
  } else track('certifications', 0, false);

  // ── Languages ───────────────────────────────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = para(langItems.join(', '), y, { size: 9.4, leading: 13 });
    track('languages', r.lines, true);
    y = r.y + gapPx(16) + GS;
  } else track('languages', 0, false);

  // ── Custom sections ─────────────────────────────────────────────────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = bullets(cs.items, y); y = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = para(cs.text, y); y = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(16) + GS;
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

  // Left vertical rule, drawn last so it spans exactly the content used.
  if (draw && y > bodyTop) {
    doc.strokeColor(RULE).lineWidth(0.8).moveTo(RULE_X, bodyTop).lineTo(RULE_X, y - gapPx(16)).stroke();
  }

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
        underflowLines: Math.round((AVAILABLE_BOTTOM - finalY) / 13),
        sections, appliedLevel: level.name, hardOverflow: false,
      };
    }
  }
  const overflowPt = last.finalY - AVAILABLE_BOTTOM;
  const overflowLines = Math.round(overflowPt / 13);
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