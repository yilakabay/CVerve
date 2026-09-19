// functions/lib/cv-template-navy-sidebar.js
//
// "Navy Sidebar" CV template — ported from the original ReportLab (Python)
// design: a full-height navy left sidebar (contact, education, skills,
// languages), a circular photo crossing a horizontal navy accent bar, and
// a white content column (profile, experience, achievement, certification,
// reference). Same measure()/render() contract as every other template.
//
// ── Fit escalation ladder ─────────────────────────────────────────────
// See cv-template-copper-diagonal.js for the full explanation. Same three
// levels here: normal → compact-skills (flow-wrap) → +tight-leading, with
// render() refusing to draw (throwing) if even the most compact level
// still overflows past a small, genuinely-crowded threshold. Note this
// template's gaps are added BEFORE each heading (contentHeading(label,
// y + GAP_SECTION)) rather than after the previous section, so tightenGap()
// is applied at the call site of contentHeading() instead.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

const NAVY = '#1A3560', CONTENT_BG = '#EEF2F7', LIGHT_BLUE = '#8AB4D8';
const BODY_GRAY = '#364457', WHITE = '#FFFFFF', BULLET_BLUE = '#6AAEE0';

const SIDEBAR_W = 217.44, SIDEBAR_MARGIN = 38.9, SIDEBAR_TEXT_W = 158.0;
const SIDEBAR_INDENT2 = 55.1, BULLET_DOT_DX = 3.2, BULLET_TEXT_DX = 9.7;
const CONTENT_LEFT = SIDEBAR_W + 24.0;
const CONTENT_RIGHT = PAGE_W - 24.0;
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function layout(doc, content, { draw, stretchPerGap = 0, compactSkills = false, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    const floor = size + 2.2;
    return Math.max(floor, Math.round(leading * 0.86 * 10) / 10);
  };
  const tightenGap = (gap) => tightLeading ? Math.round(gap * 0.6) : gap;

  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(CONTENT_BG);
    doc.rect(0, 0, SIDEBAR_W, PAGE_H).fill(NAVY);
  }

  const cx = 113.9, cyTop = 121.3, r = 70.7;
  const BAR_H = 26.0;
  if (draw) {
    doc.rect(0, cyTop - BAR_H / 2, PAGE_W, BAR_H).fill(NAVY);
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(cx, cyTop, r + 5).fill(WHITE);
        doc.circle(cx, cyTop, r).clip();
        doc.image(buf, cx - r, cyTop - r, { width: r * 2, height: r * 2, cover: [r * 2, r * 2] });
        doc.restore();
      } catch (e) { console.error('navy-sidebar photo error:', e.message); }
    } else {
      doc.circle(cx, cyTop, r + 5).fill(WHITE);
      doc.circle(cx, cyTop, r).fill('#D5D9E0');
    }
  }

  function sidebarHeading(label, yTop) {
    if (!draw) return;
    doc.font('Helvetica-Bold').fontSize(14).fillColor(LIGHT_BLUE);
    doc.text(label, SIDEBAR_MARGIN, yTop, { lineBreak: false });
    doc.strokeColor(LIGHT_BLUE).lineWidth(0.75)
      .moveTo(SIDEBAR_MARGIN, yTop + 16.5).lineTo(SIDEBAR_MARGIN + SIDEBAR_TEXT_W, yTop + 16.5).stroke();
  }
  function sidebarText(text, yTop, opts = {}) {
    if (!draw) return;
    doc.font(opts.font || 'Helvetica-Bold').fontSize(opts.size || 10.5).fillColor(opts.color || WHITE);
    doc.text(text, opts.x ?? SIDEBAR_MARGIN, yTop, { lineBreak: false });
  }

  sidebarHeading('CONTACT', 225.7);
  const contactRows = [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean);
  contactRows.forEach((txt, i) => sidebarText(txt, 252.4 + i * 21.6));

  sidebarHeading('EDUCATION', 329.8);
  const eduList = normalizeEducation(content.education);
  let eduY = 355.0;
  eduList.slice(0, 2).forEach((edu, i) => {
    const label = edu.level || (i === 0 ? 'HIGHER EDUCATION' : 'SECONDARY EDUCATION');
    sidebarText(`${label} ${edu.dateRange || ''}`, eduY, { font: 'Helvetica-Bold', size: 9, color: LIGHT_BLUE });
    eduY += 15.5;
    const schoolLines = wrapLines(doc, (edu.school || '').toUpperCase(), 'Helvetica-Bold', 10.5, SIDEBAR_TEXT_W);
    schoolLines.forEach(ln => { sidebarText(ln, eduY, { size: 10.5 }); eduY += 13; });
    if (edu.degree) {
      const lines = draw ? wrapLines(doc, edu.degree, 'Helvetica', 9.5, SIDEBAR_TEXT_W - (SIDEBAR_INDENT2 - SIDEBAR_MARGIN)) : [edu.degree];
      lines.forEach(ln => { sidebarText(ln, eduY, { font: 'Helvetica', size: 9.5, x: SIDEBAR_INDENT2 }); eduY += 13; });
    }
    if (edu.extra) { sidebarText(edu.extra, eduY, { font: 'Helvetica', size: 9.5, x: SIDEBAR_INDENT2 }); eduY += 15; }
    eduY += 10;
  });
  const eduEnd = eduY - 10;

  const SECTION_GAP = 16.6 + stretchPerGap;
  const skillsHeadingTop = eduEnd + SECTION_GAP;
  sidebarHeading('SKILLS', skillsHeadingTop);

  const textW = SIDEBAR_TEXT_W - BULLET_TEXT_DX;
  let skillsEnd;
  let skillLines = 0;
  if (compactSkills) {
    const skillsResult = flowItems(doc, content.skills || [], SIDEBAR_MARGIN + BULLET_TEXT_DX, skillsHeadingTop + 28.8, textW, {
      font: 'Helvetica', size: 10, color: WHITE,
      gapX: 10, gapY: 12.5,
      bulletColor: BULLET_BLUE, bulletSize: 3.2, bulletGap: 6,
      draw
    });
    skillsEnd = skillsResult.y - 4.5;
    skillLines = skillsResult.lines;
  } else {
    let cursor = skillsHeadingTop + 28.8;
    (content.skills || []).forEach(skill => {
      const lines = wrapLines(doc, skill, 'Helvetica', 10, textW);
      if (draw) {
        doc.fillColor(BULLET_BLUE).circle(SIDEBAR_MARGIN + BULLET_DOT_DX, cursor + 10 * 0.72, 1.6).fill();
        doc.font('Helvetica').fontSize(10).fillColor(WHITE);
        lines.forEach(ln => { doc.text(ln, SIDEBAR_MARGIN + BULLET_TEXT_DX, cursor, { lineBreak: false }); cursor += 12.0; });
      } else {
        cursor += lines.length * 12.0;
      }
      cursor += 4.5;
      skillLines += lines.length;
    });
    skillsEnd = cursor - 4.5;
  }
  track('skills', skillLines, (content.skills || []).length > 0);

  const langHeadingTop = skillsEnd + SECTION_GAP;
  sidebarHeading('LANGUAGES', langHeadingTop);
  (content.languages || []).slice(0, 2).forEach((l, i) => {
    sidebarText(`${l.name}     (${l.level})`, langHeadingTop + 26.0 + i * 13.6, { font: 'Helvetica', size: 10 });
  });

  function contentHeading(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY);
      doc.text(label, CONTENT_LEFT, yTop, { lineBreak: false });
      doc.strokeColor(NAVY).lineWidth(1).moveTo(CONTENT_LEFT, yTop + 17).lineTo(CONTENT_RIGHT, yTop + 17).stroke();
    }
    return yTop + 24;
  }
  function contentParagraph(text, yTop, opts = {}) {
    const size = opts.size || 10, leading = tighten(opts.leading || 14.2, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, opts.width || CONTENT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY_GRAY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, opts.x ?? CONTENT_LEFT, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function contentBullets(items, yTop, opts = {}) {
    const size = opts.size || 10, leading = tighten(opts.leading || 14.2, size), indent = opts.indent ?? 14;
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, item, 'Helvetica', size, CONTENT_W - indent);
      if (draw) {
        doc.fillColor(NAVY).circle(CONTENT_LEFT + 4, cur + size * 0.72, 1.8).fill();
        doc.font('Helvetica').fontSize(size).fillColor(BODY_GRAY);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, CONTENT_LEFT + indent, ly, { lineBreak: false }); ly += leading; });
      }
      cur += lines.length * leading + (tightLeading ? 1.5 : 3.5);
      total += lines.length;
    });
    return { y: cur, lines: total };
  }

  if (draw) {
    const whiteCenter = (SIDEBAR_W + PAGE_W) / 2;
    doc.font('Helvetica-Bold').fontSize(28).fillColor(NAVY);
    const nameW = doc.widthOfString((content.name || '').toUpperCase());
    doc.text((content.name || '').toUpperCase(), whiteCenter - nameW / 2, 81.4, { lineBreak: false });
    doc.font('Helvetica').fontSize(10.5).fillColor(WHITE);
    const subtitle = (content.subtitle || '').split('').join(' ').toUpperCase();
    const subW = doc.widthOfString(subtitle);
    doc.text(subtitle, whiteCenter - subW / 2, cyTop + 3.7, { lineBreak: false });
  }

  let y = 160.2;
  const GAP_SECTION = tightenGap(9) + stretchPerGap;

  if (content.profile) {
    y = contentHeading('PROFILE', y);
    const r1 = contentParagraph(content.profile, y);
    track('profile', r1.lines, true);
    y = r1.y;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    y = contentHeading('EXPERIENCE', y + GAP_SECTION);
    let linesUsed = 0;
    content.experience.forEach(exp => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
        doc.text(exp.org || '', CONTENT_LEFT, y + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(LIGHT_BLUE);
        const dw = doc.widthOfString(exp.dateRange || '');
        doc.text(exp.dateRange || '', CONTENT_RIGHT - dw, y + 1, { lineBreak: false });
      }
      y += 16.5;
      if (draw) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(BODY_GRAY);
        doc.text(exp.role || '', CONTENT_LEFT, y, { lineBreak: false });
      }
      y += 15.5;
      const r2 = contentBullets(exp.bullets || [], y);
      linesUsed += 3 + r2.lines;
      y = r2.y;
    });
    track('experience', linesUsed, true);
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    y = contentHeading('ACHIEVEMENT', y + GAP_SECTION);
    const r3 = contentBullets(content.achievements, y);
    track('achievements', r3.lines, true);
    y = r3.y;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    y = contentHeading('CERTIFICATION AND RECOGNITION', y + GAP_SECTION);
    let linesUsed = 0;
    const certLeading = tighten(14.2, 10);
    content.certifications.forEach((cert, i) => {
      const bodyLines = wrapLines(doc, `${cert.title} | ${cert.issuer}`, 'Helvetica', 10, CONTENT_W - 16);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
        doc.text(`${i + 1}.`, CONTENT_LEFT, y, { lineBreak: false });
        let cy2 = y;
        bodyLines.forEach(ln => { doc.font('Helvetica').fontSize(10).fillColor(BODY_GRAY); doc.text(ln, CONTENT_LEFT + 16, cy2, { lineBreak: false }); cy2 += certLeading; });
        y = cy2 + (tightLeading ? 2 : 4);
      } else {
        y += bodyLines.length * certLeading + (tightLeading ? 2 : 4);
      }
      linesUsed += bodyLines.length;
    });
    track('certifications', linesUsed, true);
  } else track('certifications', 0, false);

  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = contentHeading(refList.length > 1 ? 'REFERENCES' : 'REFERENCE', y + GAP_SECTION);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
        doc.text(ref.name, CONTENT_LEFT, y + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(BODY_GRAY);
        doc.text(ref.role || '', CONTENT_LEFT, y + 18, { lineBreak: false });
        let ly = y + 35.5;
        if (ref.email) { doc.text(`Email: ${ref.email}`, CONTENT_LEFT, ly, { lineBreak: false }); ly += 14.5; }
        if (ref.phone) { doc.text(`Phone: ${ref.phone}`, CONTENT_LEFT, ly, { lineBreak: false }); }
      }
      y += 64;
      linesUsed += 4;
      if (i < refList.length - 1) y += 6;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: y, sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { compactSkills: false, tightLeading: false } },
  { name: 'compact-skills', opts: { compactSkills: true, tightLeading: false } },
  { name: 'compact-skills+tight-leading', opts: { compactSkills: true, tightLeading: true } }
];
const HARD_OVERFLOW_LINE_THRESHOLD = 3;

function measure(content) {
  const available = AVAILABLE_BOTTOM;
  let last = null;

  for (const level of FIT_LEVELS) {
    const doc = measureDoc();
    const { finalY, sections } = layout(doc, content, { draw: false, ...level.opts });
    last = { finalY, sections, level: level.name };
    if (finalY <= available) {
      return {
        fits: true, finalY, availableHeight: available,
        overflowPoints: 0, overflowLines: 0,
        underflowPoints: Math.round(available - finalY), underflowLines: Math.round((available - finalY) / 14.2),
        sections, appliedLevel: level.name, hardOverflow: false
      };
    }
  }

  const overflowPt = last.finalY - available;
  const overflowLines = Math.round(overflowPt / 14.2);
  const hardOverflow = overflowLines > HARD_OVERFLOW_LINE_THRESHOLD;

  return {
    fits: false, finalY: last.finalY, availableHeight: available,
    overflowPoints: Math.round(overflowPt), overflowLines,
    underflowPoints: 0, underflowLines: 0,
    sections: last.sections, appliedLevel: last.level, hardOverflow,
    recommendation: buildFitRecommendation(last.sections, overflowLines)
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

module.exports = { measure, render, PAGE_W, PAGE_H };