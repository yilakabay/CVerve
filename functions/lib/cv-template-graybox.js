// functions/lib/cv-template-graybox.js
//
// "Gray Box" CV template — a rounded light-gray header box with the name and
// "(Job Title)" on the left and contact details right-aligned in the same box.
// Each section is introduced by a centered rounded gray band. Education, Work
// Experience, Skills and Languages lay out in 2-column grids. Single column,
// NO photo.
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
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name, subtitle,                                    // subtitle is shown as "(Job Title)"
//   contact: { phone, email, location, linkedin },      // right-aligned in the header box
//   profile,                                             // "Professional Summary"
//   education: { degree, school, dateRange, extra } | [...],   // 2-column
//   experience: [{ org, role, dateRange, bullets: string[] }], // 2-column
//   skills: string[],                                    // 2-column bullets
//   languages: [{ name, level }],                        // 2-column bullets
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
const INK = '#1B1C1E';
const BODY = '#34373B';
const MUTED = '#6B6F74';
const BOX_BG = '#E4E4E4';   // header box and section bands — change to retheme

// ---------- Layout ----------
const MARGIN_L = 44.0;
const MARGIN_R = PAGE_W - 44.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 30;
const COL_GAP = 22.0;
const COL_W = (CONTENT_W - COL_GAP) / 2;
const COL2_X = MARGIN_L + COL_W + COL_GAP;
const BAND_PAD_Y = 8.0;

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

  // ── Header: rounded gray box, name + "(title)" left, contact right ────
  const HEADER_TOP = 36.0;
  const HEADER_PAD_X = 22.0, HEADER_PAD_Y = 20.0;
  const CONTACT_COL_W = 190.0;
  const NAME_COL_W = CONTENT_W - HEADER_PAD_X * 2 - CONTACT_COL_W - 16;

  const NAME_SIZE = 19;
  const nameLines = wrapLines(doc, content.name || '', 'Helvetica-Bold', NAME_SIZE, NAME_COL_W);
  const nameLH = NAME_SIZE * 1.2;

  const SUB_SIZE = 11.5, SUB_LH = 15;
  const subtitleText = content.subtitle ? `(${content.subtitle})` : '';
  const subtitleLines = subtitleText ? wrapLines(doc, subtitleText, 'Helvetica', SUB_SIZE, NAME_COL_W) : [];

  const contactParts = [content.contact?.phone, content.contact?.email, content.contact?.location, content.contact?.linkedin].filter(Boolean);
  const CONTACT_SIZE = 9.6, CONTACT_LH = 14;
  // Contact lines wrap within their column, so long values never run left into the name.
  const contactLines = [];
  contactParts.forEach(part => {
    wrapLines(doc, part, 'Helvetica', CONTACT_SIZE, CONTACT_COL_W).forEach(ln => contactLines.push(ln));
  });

  const leftBlockH = nameLines.length * nameLH + (subtitleLines.length ? subtitleLines.length * SUB_LH + 6 : 0);
  const rightBlockH = contactLines.length * CONTACT_LH;
  const headerInnerH = Math.max(leftBlockH, rightBlockH);
  const headerBoxH = headerInnerH + HEADER_PAD_Y * 2;

  if (draw) {
    doc.roundedRect(MARGIN_L, HEADER_TOP, CONTENT_W, headerBoxH, 6).fill(BOX_BG);
    let ly = HEADER_TOP + HEADER_PAD_Y + (headerInnerH - leftBlockH) / 2;
    ly = block(doc, nameLines, MARGIN_L + HEADER_PAD_X, ly, { font: 'Helvetica-Bold', size: NAME_SIZE, color: INK, leading: nameLH, draw });
    if (subtitleLines.length) {
      block(doc, subtitleLines, MARGIN_L + HEADER_PAD_X, ly + 6, { font: 'Helvetica', size: SUB_SIZE, color: BODY, leading: SUB_LH, draw });
    }
    let ry = HEADER_TOP + HEADER_PAD_Y + (headerInnerH - rightBlockH) / 2;
    doc.font('Helvetica').fontSize(CONTACT_SIZE).fillColor(BODY);
    contactLines.forEach(ln => {
      const w = doc.widthOfString(ln);
      doc.text(ln, MARGIN_R - HEADER_PAD_X - w, ry, { lineBreak: false });
      ry += CONTACT_LH;
    });
  }

  let y = HEADER_TOP + headerBoxH + gapPx(22) + GS;

  // ── Section band: centered rounded gray pill, bold label (wrapped if long)
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || ''), 'Helvetica-Bold', 11.5, CONTENT_W - 24);
    const bandH = lines.length * 14 + BAND_PAD_Y * 2;
    if (draw) {
      doc.roundedRect(MARGIN_L, yTop, CONTENT_W, bandH, 5).fill(BOX_BG);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK);
      lines.forEach((ln, i) => {
        const w = doc.widthOfString(ln);
        doc.text(ln, MARGIN_L + (CONTENT_W - w) / 2, yTop + BAND_PAD_Y + i * 14, { lineBreak: false });
      });
    }
    return yTop + bandH + gapPx(14);
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.6, leading = tighten(opts.leading || 13.8, size);
    const width = opts.width ?? CONTENT_W, x = opts.x ?? MARGIN_L;
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, width);
    const y2 = block(doc, lines, x, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = tighten(opts.leading || 13, size);
    const indent = opts.indent ?? 12;
    const x = opts.x ?? MARGIN_L, width = opts.width ?? CONTENT_W;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, width - indent);
      if (draw) doc.font('Helvetica').fontSize(size).fillColor(INK).text('•', x, cy, { lineBreak: false });
      cy = block(doc, lines, x + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1.5 : 3;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  // Lays items into two columns: first half left, second half right.
  // Each column flows at its own height; the grid ends at the taller one.
  function twoColEntries(items, yTop, renderCell) {
    const half = Math.ceil(items.length / 2);
    const colItems = [items.slice(0, half), items.slice(half)];
    const colX = [MARGIN_L, COL2_X];
    let maxY = yTop, totalLines = 0;
    colItems.forEach((list, col) => {
      let cy = yTop;
      list.forEach((item, idx) => {
        const r = renderCell(colX[col], cy, COL_W, item);
        cy = r.y + (idx < list.length - 1 ? gapPx(10) : 0);
        totalLines += r.lines;
      });
      maxY = Math.max(maxY, cy);
    });
    return { y: maxY, lines: totalLines };
  }

  // ── Professional Summary ────────────────────────────────────────────
  if (content.profile) {
    y = heading('Professional Summary', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + gapPx(18) + GS;
  } else track('profile', 0, false);

  // ── Education (2-column) ────────────────────────────────────────────
  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = heading('Education', y);
    const r = twoColEntries(eduList, y, (x, yy, w, edu) => {
      let cy = yy, lines = 0;
      const degreeText = [edu.degree || edu.level, edu.school ? `at ${edu.school}` : ''].filter(Boolean).join(' ') || edu.school || '';
      const br = bullets([degreeText], cy, { x, width: w, size: 9.3, leading: 13 });
      cy = br.y; lines += br.lines;
      if (edu.dateRange) {
        const dl = wrapLines(doc, `( ${edu.dateRange} )`, 'Helvetica-Oblique', 8.8, w - 12);
        cy = block(doc, dl, x + 12, cy, { font: 'Helvetica-Oblique', size: 8.8, color: MUTED, leading: 12, draw });
        lines += dl.length;
      }
      if (edu.extra) {
        const el = wrapLines(doc, edu.extra, 'Helvetica', 8.8, w - 12);
        cy = block(doc, el, x + 12, cy + 1, { font: 'Helvetica', size: 8.8, color: MUTED, leading: 12, draw });
        lines += el.length;
      }
      return { y: cy, lines };
    });
    track('education', r.lines, true);
    y = r.y + gapPx(18) + GS;
  } else track('education', 0, false);

  // ── Work Experience (2-column) ──────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = heading('Work Experience', y);
    const r = twoColEntries(content.experience, y, (x, yy, w, exp) => {
      let cy = yy, lines = 0;
      const roleLines = wrapLines(doc, exp.role || '', 'Helvetica-Bold', 9.8, w);
      cy = block(doc, roleLines, x, cy, { font: 'Helvetica-Bold', size: 9.8, color: INK, leading: 12.5, draw });
      lines += roleLines.length;
      const metaLine = [exp.org, exp.dateRange].filter(Boolean).join(' | ');
      if (metaLine) {
        const metaLines = wrapLines(doc, metaLine, 'Helvetica-Oblique', 8.6, w);
        cy = block(doc, metaLines, x, cy, { font: 'Helvetica-Oblique', size: 8.6, color: MUTED, leading: 11, draw });
        lines += metaLines.length;
      }
      const br = bullets(exp.bullets || [], cy + 2, { x, width: w, size: 8.9, leading: 12.4 });
      cy = br.y; lines += br.lines;
      return { y: cy, lines };
    });
    track('experience', r.lines, true);
    y = r.y + gapPx(18) + GS;
  } else track('experience', 0, false);

  // Helper for simple two-column bullet lists (skills, languages, custom items).
  function twoColBullets(items, yTop) {
    const half = Math.ceil(items.length / 2);
    const colLists = [items.slice(0, half), items.slice(half)];
    let maxY = yTop, totalLines = 0;
    colLists.forEach((list, col) => {
      const x = col === 0 ? MARGIN_L : COL2_X;
      const r = bullets(list, yTop, { x, width: COL_W, size: 9.2, leading: 13 });
      maxY = Math.max(maxY, r.y); totalLines += r.lines;
    });
    return { y: maxY, lines: totalLines };
  }

  // ── Skills (2-column bullet grid) ───────────────────────────────────
  if (content.skills && content.skills.length) {
    y = heading('Skills', y);
    const r = twoColBullets(content.skills, y);
    track('skills', r.lines, true);
    y = r.y + gapPx(18) + GS;
  } else track('skills', 0, false);

  // ── Languages (2-column bullet grid) ────────────────────────────────
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    y = heading('Languages', y);
    const r = twoColBullets(langItems, y);
    track('languages', r.lines, true);
    y = r.y + gapPx(18) + GS;
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
    y += gapPx(18) + GS;
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  // ── Custom sections (2-column bullets if items, else paragraph) ─────
  (content.customSections || []).forEach(cs => {
    y = heading(cs.title || 'Section', y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = twoColBullets(cs.items, y); y = r.y; linesUsed = r.lines;
    } else if (cs.text) {
      const r = para(cs.text, y); y = r.y; linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += gapPx(18) + GS;
  });

  // ── References (2-column, every reference kept) ─────────────────────
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = heading(refList.length > 1 ? 'References' : 'Reference', y);
    const r = twoColEntries(refList, y, (x, yy, w, ref) => {
      let cy = yy, lines = 0;
      const nl = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 9.8, w);
      cy = block(doc, nl, x, cy, { font: 'Helvetica-Bold', size: 9.8, color: INK, leading: 12.5, draw });
      lines += nl.length;
      if (ref.role) {
        const rl = wrapLines(doc, ref.role, 'Helvetica', 8.8, w);
        cy = block(doc, rl, x, cy, { font: 'Helvetica', size: 8.8, color: MUTED, leading: 11, draw });
        lines += rl.length;
      }
      [['Phone', ref.phone], ['Email', ref.email]].forEach(([label, val]) => {
        if (!val) return;
        const vl = wrapLines(doc, String(val), 'Helvetica', 8.4, w - 34);
        if (draw) doc.font('Helvetica-Bold').fontSize(8.4).fillColor(INK).text(label + ':', x, cy, { lineBreak: false });
        cy = block(doc, vl, x + 34, cy, { font: 'Helvetica', size: 8.4, color: BODY, leading: 11, draw });
        lines += vl.length;
      });
      return { y: cy, lines };
    });
    track('references', r.lines, true);
    y = r.y;
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