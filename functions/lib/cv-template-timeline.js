// functions/lib/cv-template-timeline.js
//
// "Timeline Sidebar" CV template — bold name and letter-spaced job title at
// the top with a thin accent rule, then two columns: a narrow left sidebar
// (Contact, Skills, Languages, Reference) and a wide right column where
// Profile, Work Experience, Education and Certifications run down a vertical
// timeline with icon markers per section and dot markers per entry.
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
//   offsets. The timeline line and markers use those same positions, so
//   they always line up with the content next to them.
// • Experience and education title/date rows use expTitleDateRow().
// • Custom sections render in the sidebar (placement "sidebar") or in the
//   timeline column (any other placement).
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.
//
// ── CONTENT SCHEMA (no photoBase64) ───────────────────────────────────────
// {
//   name, subtitle,
//   contact: { phone, email, location, linkedin },
//   skills: string[],
//   languages: [{ name, level }],
//   references: [{ name, role, email, phone }],
//   profile,
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   education: { degree, school, dateRange, extra } | [...],
//   achievements: string[],
//   certifications: [{ title, issuer }],
//   customSections: [{ title, items, text, placement: 'sidebar' | undefined }]
// }

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const INK = '#1B1F23';
const BODY = '#3A3F45';
const MUTED = '#787F87';
const ACCENT = '#1F3A4D';   // dark slate-teal — change to retheme
const RULE = '#D8DCE0';
const WHITE = '#FFFFFF';

// ---------- Layout ----------
const MARGIN_L = 40.0;
const MARGIN_R = PAGE_W - 40.0;
const SIDEBAR_W = 150.0;
const GUTTER = 26.0;
const COL_X = MARGIN_L + SIDEBAR_W + GUTTER;
const COL_R = MARGIN_R;
const COL_W = COL_R - COL_X;
const TIMELINE_X = COL_X - 16;
const ICON_R = 10.5;
const AVAILABLE_BOTTOM = PAGE_H - 30;

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

  if (draw) doc.rect(0, 0, PAGE_W, PAGE_H).fill(WHITE);

  // ── Header: name, letter-spaced title, accent rule ────────────────────
  const NAME_TOP = 40.0;
  const NAME_SIZES = [26, 23, 20, 18];
  const nameText = (content.name || '').toUpperCase();
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, COL_R - MARGIN_L);
    if (ls.length === 1) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, COL_R - MARGIN_L);
  let cur = block(doc, nameLines, MARGIN_L, NAME_TOP, { font: 'Helvetica-Bold', size: nameSize, color: INK, leading: nameSize * 1.1, draw });

  if (content.subtitle) {
    const subLines = wrapLines(doc, content.subtitle.toUpperCase(), 'Helvetica', 12, COL_R - MARGIN_L);
    if (draw) {
      doc.font('Helvetica').fontSize(12).fillColor(MUTED);
      subLines.forEach((ln, i) => doc.text(ln, MARGIN_L, cur + 3 + i * 16, { characterSpacing: 1.6, lineBreak: false }));
    }
    cur += subLines.length * 16 + 3;
  }

  const headerRuleY = cur + 10;
  if (draw) doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(MARGIN_L, headerRuleY).lineTo(COL_R, headerRuleY).stroke();

  const BODY_TOP = headerRuleY + 24;

  // ═════════════════ LEFT SIDEBAR ═════════════════
  function sideHeading(label, yTop) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 10.5, SIDEBAR_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ACCENT);
      lines.forEach((ln, i) => doc.text(ln, MARGIN_L, yTop + i * 13, { characterSpacing: 1, lineBreak: false }));
      const ruleY = yTop + lines.length * 13 + 1;
      doc.strokeColor(ACCENT).lineWidth(1).moveTo(MARGIN_L, ruleY).lineTo(MARGIN_L + SIDEBAR_W, ruleY).stroke();
    }
    return yTop + lines.length * 13 + 9;
  }
  function sideBullets(items, yTop, opts = {}) {
    const size = opts.size || 9.1, leading = tighten(opts.leading || 13, size);
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, SIDEBAR_W - 10);
      if (draw) doc.fillColor(ACCENT).circle(MARGIN_L + 2, cy + size * 0.55, 1.4).fill();
      cy = block(doc, lines, MARGIN_L + 9, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += 2;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  let sy = BODY_TOP;
  sy = sideHeading('Contact', sy);
  const contactRows = [content.contact?.phone, content.contact?.email, content.contact?.location, content.contact?.linkedin].filter(Boolean);
  contactRows.forEach(txt => {
    const lines = wrapLines(doc, txt, 'Helvetica', 8.8, SIDEBAR_W - 14);
    if (draw) {
      doc.fillColor(ACCENT).circle(MARGIN_L + 3.5, sy + 3.5, 3.5).fill();
    }
    sy = block(doc, lines, MARGIN_L + 13, sy, { font: 'Helvetica', size: 8.8, color: BODY, leading: 11.5, draw }) + 4;
  });
  sy += gapPx(10) + GS;

  if (content.skills && content.skills.length) {
    sy = sideHeading('Skills', sy);
    const r = sideBullets(content.skills, sy);
    sy = r.y;
    track('skills', r.lines, true);
    sy += gapPx(10) + GS;
  } else track('skills', 0, false);

  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} (${l.level})` : l.name)).filter(Boolean);
  if (langItems.length) {
    sy = sideHeading('Languages', sy);
    const r = sideBullets(langItems, sy);
    sy = r.y;
    track('languages', r.lines, true);
    sy += gapPx(10) + GS;
  } else track('languages', 0, false);

  (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar').forEach(cs => {
    sy = sideHeading(cs.title || 'Section', sy);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = sideBullets(cs.items, sy);
      sy = r.y; linesUsed = r.lines;
    } else if (cs.text) {
      const lines = wrapLines(doc, cs.text, 'Helvetica', 8.8, SIDEBAR_W);
      sy = block(doc, lines, MARGIN_L, sy, { font: 'Helvetica', size: 8.8, color: BODY, leading: 11.8, draw });
      linesUsed = lines.length;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    sy += gapPx(10) + GS;
  });

  // References: every reference is kept, stacked in the sidebar.
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    sy = sideHeading(refList.length > 1 ? 'References' : 'Reference', sy);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 9.4, SIDEBAR_W);
      sy = block(doc, nameLines, MARGIN_L, sy, { font: 'Helvetica-Bold', size: 9.4, color: INK, leading: 12, draw });
      linesUsed += nameLines.length;
      if (ref.role) {
        const roleLines = wrapLines(doc, ref.role, 'Helvetica', 8.6, SIDEBAR_W);
        sy = block(doc, roleLines, MARGIN_L, sy, { font: 'Helvetica', size: 8.6, color: MUTED, leading: 11, draw });
        linesUsed += roleLines.length;
      }
      [['Phone', ref.phone], ['Email', ref.email]].forEach(([label, val]) => {
        if (!val) return;
        const valLines = wrapLines(doc, String(val), 'Helvetica', 8.3, SIDEBAR_W - 2);
        if (draw) doc.font('Helvetica-Bold').fontSize(8.3).fillColor(INK).text(label + ':', MARGIN_L, sy, { lineBreak: false });
        sy = block(doc, valLines, MARGIN_L, sy + 10.5, { font: 'Helvetica', size: 8.3, color: BODY, leading: 10.5, draw });
        linesUsed += 1 + valLines.length;
      });
      if (i < refList.length - 1) sy += 8;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  const sidebarBottom = sy;

  // ═════════════════ RIGHT COLUMN (timeline) ═════════════════
  // Section label with an icon circle on the timeline. Long labels wrap.
  function timelineSection(label, yTop, iconDraw) {
    const lines = wrapLines(doc, String(label || '').toUpperCase(), 'Helvetica-Bold', 12, COL_W);
    if (draw) {
      const cy = yTop + 7;
      doc.fillColor(ACCENT).circle(TIMELINE_X, cy, ICON_R).fill();
      if (iconDraw) iconDraw(cy);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK);
      lines.forEach((ln, i) => doc.text(ln, COL_X, yTop + i * 15, { characterSpacing: 0.6, lineBreak: false }));
      const ruleY = yTop + lines.length * 15 + 1;
      doc.strokeColor(RULE).lineWidth(0.8).moveTo(COL_X, ruleY).lineTo(COL_R, ruleY).stroke();
    }
    return yTop + lines.length * 15 + 10;
  }
  function timelineDot(yCenter) {
    if (draw) {
      doc.fillColor(WHITE).circle(TIMELINE_X, yCenter, 3.2).fill();
      doc.strokeColor(ACCENT).lineWidth(0.9).circle(TIMELINE_X, yCenter, 3.2).stroke();
    }
  }
  function iconPerson(cy) {
    doc.fillColor(WHITE);
    doc.circle(TIMELINE_X, cy - 2.6, 2.6).fill();
    doc.moveTo(TIMELINE_X - 5, cy + 6).bezierCurveTo(TIMELINE_X - 5, cy + 0.5, TIMELINE_X + 5, cy + 0.5, TIMELINE_X + 5, cy + 6).fill();
  }
  function iconBriefcase(cy) {
    doc.fillColor(WHITE).roundedRect(TIMELINE_X - 5.5, cy - 2.5, 11, 7.5, 1).fill();
    doc.fillColor(ACCENT).rect(TIMELINE_X - 2, cy - 4.5, 4, 2.5).fill();
  }
  function iconCap(cy) {
    doc.fillColor(WHITE).polygon([TIMELINE_X - 6, cy - 1], [TIMELINE_X, cy - 4.5], [TIMELINE_X + 6, cy - 1], [TIMELINE_X, cy + 2.5]).fill();
    doc.fillColor(WHITE).rect(TIMELINE_X - 2.2, cy + 1, 4.4, 3.5).fill();
  }

  function rPara(text, yTop, opts = {}) {
    const size = opts.size || 9.3, leading = tighten(opts.leading || 13.2, size);
    const lines = wrapLines(doc, String(text || ''), opts.font || 'Helvetica', size, COL_W);
    const y2 = block(doc, lines, COL_X, yTop, { font: opts.font || 'Helvetica', size, color: opts.color || BODY, leading, draw });
    return { y: y2, lines: lines.length };
  }
  function rBullets(items, yTop, opts = {}) {
    const size = opts.size || 9.1, leading = tighten(opts.leading || 12.8, size);
    const indent = 12;
    let cy = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, COL_W - indent);
      if (draw) doc.fillColor(ACCENT).circle(COL_X + 2, cy + size * 0.55, 1.4).fill();
      cy = block(doc, lines, COL_X + indent, cy, { font: 'Helvetica', size, color: BODY, leading, draw });
      cy += tightLeading ? 1 : 2.5;
      total += lines.length;
    });
    return { y: cy, lines: total };
  }

  let ry = BODY_TOP;
  let timelineBottom = ry;

  if (content.profile) {
    ry = timelineSection('Profile', ry, iconPerson);
    const r = rPara(`"${content.profile}"`, ry, { font: 'Helvetica-Oblique' });
    track('profile', r.lines, true);
    ry = r.y + gapPx(16) + GS;
    timelineBottom = ry;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    ry = timelineSection('Work Experience', ry, iconBriefcase);
    let linesUsed = 0;
    content.experience.forEach((exp, idx) => {
      timelineDot(ry + 4);
      const headerR = expTitleDateRow(doc, { org: exp.org || '', date: exp.dateRange }, COL_X, ry, COL_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.3, titleColor: INK,
        dateFont: 'Helvetica', dateSize: 9, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y;
      linesUsed += headerR.lines;
      if (exp.role) {
        const roleLines = wrapLines(doc, exp.role, 'Helvetica', 9.3, COL_W);
        yy = block(doc, roleLines, COL_X, yy, { font: 'Helvetica', size: 9.3, color: ACCENT, leading: 13, draw });
        linesUsed += roleLines.length;
      }
      const br = rBullets(exp.bullets || [], yy + 2);
      linesUsed += br.lines;
      ry = br.y + (idx < content.experience.length - 1 ? gapPx(10) : 0);
    });
    track('experience', linesUsed, true);
    ry += gapPx(16) + GS;
    timelineBottom = ry;
  } else track('experience', 0, false);

  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    ry = timelineSection('Education', ry, iconCap);
    let linesUsed = 0;
    eduList.forEach((edu, idx) => {
      timelineDot(ry + 4);
      const headerR = expTitleDateRow(doc, { org: edu.degree || edu.level || '', date: edu.dateRange }, COL_X, ry, COL_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.3, titleColor: INK,
        dateFont: 'Helvetica', dateSize: 9, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y;
      linesUsed += headerR.lines;
      if (edu.school) {
        const schoolLines = wrapLines(doc, edu.school, 'Helvetica', 9.3, COL_W);
        yy = block(doc, schoolLines, COL_X, yy, { font: 'Helvetica', size: 9.3, color: ACCENT, leading: 13, draw });
        linesUsed += schoolLines.length;
      }
      if (edu.extra) { const r = rPara(edu.extra, yy + 1, { size: 9, color: MUTED }); yy = r.y; linesUsed += r.lines; }
      ry = yy + (idx < eduList.length - 1 ? gapPx(10) : 0);
    });
    track('education', linesUsed, true);
    ry += gapPx(16) + GS;
    timelineBottom = ry;
  } else track('education', 0, false);

  const hasAchievements = content.achievements && content.achievements.length;
  const hasCerts = content.certifications && content.certifications.length;
  if (hasAchievements || hasCerts) {
    ry = timelineSection('Certifications & Awards', ry, iconCap);
    let linesUsed = 0;
    if (hasAchievements) { const r = rBullets(content.achievements, ry); ry = r.y; linesUsed += r.lines; }
    if (hasCerts) {
      const certLines = content.certifications.map(c => [c.title, c.issuer].filter(Boolean).join(' — '));
      const r = rBullets(certLines, ry); ry = r.y; linesUsed += r.lines;
    }
    track('certifications', linesUsed, true);
    ry += gapPx(16) + GS;
    timelineBottom = ry;
  } else { track('achievements', 0, false); track('certifications', 0, false); }

  (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar').forEach(cs => {
    ry = timelineSection(cs.title || 'Section', ry, iconBriefcase);
    let linesUsed = 0;
    if (cs.items && cs.items.length) { const r = rBullets(cs.items, ry); ry = r.y; linesUsed = r.lines; }
    else if (cs.text) { const r = rPara(cs.text, ry); ry = r.y; linesUsed = r.lines; }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    ry += gapPx(16) + GS;
    timelineBottom = ry;
  });

  // Vertical timeline line, drawn last so it spans the content actually used.
  if (draw && timelineBottom > BODY_TOP) {
    doc.strokeColor(RULE).lineWidth(1).moveTo(TIMELINE_X, BODY_TOP + 2).lineTo(TIMELINE_X, timelineBottom - gapPx(16) - 4).stroke();
  }

  return { finalY: Math.max(sidebarBottom, ry), sections };
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