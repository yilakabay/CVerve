// functions/lib/cv-template-classic.js
//
// "Classic / International Standard" CV template — a single-column resume
// with NO photo. Centered name and contact line at the top, then left-aligned
// sections with a rule under each heading. No sidebar, no color blocks.
//
// This template never uses a profile photo. cv-chat.js is told this via
// `noPhoto: true` below, so it never asks the user for a photo and ignores
// any photo that is attached.
//
// Same measure()/render() contract as every other template.
//
// ── Safety rules (shared, from cv-shared.js) ──────────────────────────────
// • Every text run is wrapped to its real box width (wrapLines). Nothing is
//   cut with "..." and no line is silently dropped — long names, subtitles,
//   headings and references all wrap onto more lines instead.
// • Vertical positions come from the lines actually drawn, never fixed
//   offsets, so longer content pushes the rest down instead of colliding.
// • Experience and education title/date rows use expTitleDateRow().
// • Custom sections render in the main flow.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64 — this template never draws a photo) ──
// {
//   name, subtitle,
//   contact: { phone, email, location, linkedin },   // any field may be omitted
//   profile,
//   skills: string[],                                  // "Core Competencies"
//   languages: [{ name, level }],
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
//   achievements: string[],                             // certs/awards as a flat list
//   certifications: [{ title, issuer }],
//   references: [{ name, role, email, phone }],
//   customSections: [{ title, items, text }]
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette (black / gray only) ----------
const INK = '#1C1D1F';
const BODY = '#3A3C40';
const MUTED = '#6E7177';
const RULE_STRONG = '#1C1D1F';

// ---------- Layout ----------
const MARGIN_L = 46.0;
const MARGIN_R = PAGE_W - 46.0;
const CONTENT_W = MARGIN_R - MARGIN_L;
const AVAILABLE_BOTTOM = PAGE_H - 30;

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

  // ── Header: centered name, subtitle, contact line ─────────────────────
  const NAME_TOP = 38.0;
  const NAME_SIZES = [22, 20, 18, 16];
  const nameText = (content.name || '').toUpperCase();
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, CONTENT_W);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, CONTENT_W);
  const nameLH = nameSize * 1.12;
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, {
    font: 'Helvetica-Bold', size: nameSize, color: INK, leading: nameLH, draw, align: 'center'
  });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle, 'Helvetica', 10.5, CONTENT_W);
    cur = block(doc, subLines, MARGIN_L, cur + 4, {
      font: 'Helvetica', size: 10.5, color: MUTED, leading: 13.5, draw, align: 'center'
    }) + 4;
  }

  // Contact line: "Location | Phone | Email | LinkedIn", centered. If it does
  // not fit on one line, parts are packed onto as many centered lines as needed.
  const contactParts = [
    content.contact?.location,
    content.contact?.phone,
    content.contact?.email,
    content.contact?.linkedin,
  ].filter(Boolean);
  if (contactParts.length) {
    const SEP = '   |   ';
    const CONTACT_SIZE = 9.6;
    let contactLines;
    {
      doc.font('Helvetica').fontSize(CONTACT_SIZE);
      const full = contactParts.join(SEP);
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
    }
    cur = block(doc, contactLines, MARGIN_L, cur + 8, {
      font: 'Helvetica', size: CONTACT_SIZE, color: BODY, leading: 13, draw, align: 'center'
    });
  }

  const headerRuleY = cur + 8;
  if (draw) {
    doc.strokeColor(RULE_STRONG).lineWidth(1.6).moveTo(MARGIN_L, headerRuleY).lineTo(MARGIN_R, headerRuleY).stroke();
  }

  let y = headerRuleY + 15;

  // ── Section heading: bold caps, rule under the last line. Long custom
  // titles wrap instead of running past the margin. ────────────────────
  function heading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 10.2, CONTENT_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(10.2).fillColor(INK);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 13, { lineBreak: false, characterSpacing: 0.6 }));
      const ruleY = yTop + (lines.length - 1) * 13 + 13;
      doc.strokeColor(RULE_STRONG).lineWidth(1.4).moveTo(MARGIN_L, ruleY).lineTo(MARGIN_R, ruleY).stroke();
    }
    return yTop + (lines.length - 1) * 13 + 20;
  }

  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 13.2, size);
    const lines = wrapLines(doc, String(text || ''), 'Helvetica', size, CONTENT_W);
    const y2 = block(doc, lines, MARGIN_L, yTop, { font: 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }

  // Flat bullet list, wrapped to full width. "•" bullets, no color.
  function bullets(items, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 12.8, size);
    const indent = opts.indent ?? 12;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, CONTENT_W - indent);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(size).fillColor(INK);
        doc.text('•', MARGIN_L, cy, { lineBreak: false });
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
        dateFont: 'Helvetica-Oblique', dateSize: 9, dateColor: MUTED,
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
        dateFont: 'Helvetica-Oblique', dateSize: 9, dateColor: MUTED,
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

// This template has no photo. cv-chat.js reads this flag to skip the photo
// step and ignore any photo the user attaches.
const noPhoto = true;

module.exports = { measure, render, PAGE_W, PAGE_H, noPhoto };