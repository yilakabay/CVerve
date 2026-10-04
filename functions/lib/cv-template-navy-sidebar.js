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
//
// ── FIX: experience title no longer truncated with "…" ─────────────────
// The org/title next to each experience entry's date used to be cut short
// with truncateToFit() the moment it got close to the date column — a real
// loss of content, not just a cosmetic wrap ("Anbesa and Semen Mountain
// Alliance Tra…"). It now goes through cv-shared's expTitleDateRow(): if
// the title fits next to the date on one line, nothing changes; if it
// doesn't, the title wraps onto as many lines as it needs (full width) and
// the date drops onto its own line right after, so it can never overlap or
// get cut off.

const { PDFDocument, measureDoc, wrapLines, truncateToFit, expTitleDateRow, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

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
    const font = opts.font || 'Helvetica-Bold', size = opts.size || 10.5;
    const maxW = opts.maxWidth ?? (SIDEBAR_TEXT_W - ((opts.x ?? SIDEBAR_MARGIN) - SIDEBAR_MARGIN));
    const safe = truncateToFit(doc, text, font, size, maxW);
    doc.font(font).fontSize(size).fillColor(opts.color || WHITE);
    doc.text(safe, opts.x ?? SIDEBAR_MARGIN, yTop, { lineBreak: false });
  }
  function sidebarBullets(items, yTop) {
    const textW = SIDEBAR_TEXT_W - BULLET_TEXT_DX;
    let cursor = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', 10, textW);
      if (draw) {
        doc.fillColor(BULLET_BLUE).circle(SIDEBAR_MARGIN + BULLET_DOT_DX, cursor + 10 * 0.72, 1.6).fill();
        doc.font('Helvetica').fontSize(10).fillColor(WHITE);
        lines.forEach(ln => { doc.text(ln, SIDEBAR_MARGIN + BULLET_TEXT_DX, cursor, { lineBreak: false }); cursor += 12.0; });
      } else {
        cursor += lines.length * 12.0;
      }
      cursor += 4.5;
      total += lines.length;
    });
    return { y: cursor - 4.5, lines: total };
  }

  // ── Contact rows ───────────────────────────────────────────────────
  // Order: phone, email, LinkedIn, location — LinkedIn inserted as a
  // secondary detail rather than first, consistent with the other
  // templates. Each row already went through sidebarText()'s
  // truncateToFit(), so a 4th row doesn't risk overflowing its own
  // column width — it just adds one more fixed-spacing row below the
  // others, same as before.
  sidebarHeading('CONTACT', 225.7);
  const contactRows = [content.contact?.phone, content.contact?.email, content.contact?.linkedin, content.contact?.location].filter(Boolean);
  contactRows.forEach((txt, i) => sidebarText(txt, 252.4 + i * 21.6));
  // The contact block's height now depends on how many rows there are
  // (3 vs 4 with LinkedIn) — EDUCATION's heading position used to be a
  // fixed constant (329.8) sized for exactly 3 rows, so a 4th row could
  // run into it. It now starts after the actual last contact row instead.
  const contactBlockEnd = 252.4 + Math.max(contactRows.length, 1) * 21.6 + 8;
  const eduHeadingTop = Math.max(329.8, contactBlockEnd);

  sidebarHeading('EDUCATION', eduHeadingTop);
  const eduList = normalizeEducation(content.education);
  let eduY = eduHeadingTop + 25.2;
  let eduLinesUsed = 0;
  eduList.slice(0, 2).forEach((edu, i) => {
    const label = edu.level || (i === 0 ? 'HIGHER EDUCATION' : 'SECONDARY EDUCATION');
    sidebarText(`${label} ${edu.dateRange || ''}`, eduY, { font: 'Helvetica-Bold', size: 9, color: LIGHT_BLUE });
    eduY += 15.5;
    eduLinesUsed += 1;
    const schoolLines = wrapLines(doc, (edu.school || '').toUpperCase(), 'Helvetica-Bold', 10.5, SIDEBAR_TEXT_W);
    schoolLines.forEach(ln => { sidebarText(ln, eduY, { size: 10.5 }); eduY += 13; });
    eduLinesUsed += schoolLines.length;
    if (edu.degree) {
      const lines = wrapLines(doc, edu.degree, 'Helvetica', 9.5, SIDEBAR_TEXT_W - (SIDEBAR_INDENT2 - SIDEBAR_MARGIN));
      lines.forEach(ln => { sidebarText(ln, eduY, { font: 'Helvetica', size: 9.5, x: SIDEBAR_INDENT2 }); eduY += 13; });
      eduLinesUsed += lines.length;
    }
    if (edu.extra) {
      const extraLines = wrapLines(doc, edu.extra, 'Helvetica', 9.5, SIDEBAR_TEXT_W - (SIDEBAR_INDENT2 - SIDEBAR_MARGIN)).slice(0, 2);
      extraLines.forEach(ln => { sidebarText(ln, eduY, { font: 'Helvetica', size: 9.5, x: SIDEBAR_INDENT2 }); eduY += 13; });
      eduY += 2;
      eduLinesUsed += extraLines.length;
    }
    eduY += 10;
  });
  const eduEnd = eduY - 10;
  track('education', eduLinesUsed, eduList.length > 0);

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
  const langList = (content.languages || []).slice(0, 2);
  langList.forEach((l, i) => {
    sidebarText(`${l.name}     (${l.level})`, langHeadingTop + 26.0 + i * 13.6, { font: 'Helvetica', size: 10 });
  });
  track('languages', langList.length, langList.length > 0);
  let sidebarBottom = langHeadingTop + 26.0 + Math.max(langList.length, 1) * 13.6;

  const sidebarCustom = (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar');
  if (sidebarCustom.length) {
    let cy = sidebarBottom + SECTION_GAP;
    sidebarCustom.forEach(cs => {
      sidebarHeading((cs.title || 'Section').toUpperCase(), cy);
      let linesUsed = 0;
      if (cs.items && cs.items.length) {
        const r = sidebarBullets(cs.items, cy + 28.8);
        cy = r.y;
        linesUsed = r.lines;
      } else if (cs.text) {
        const lines = wrapLines(doc, cs.text, 'Helvetica', 9.5, SIDEBAR_TEXT_W);
        let ty = cy + 28.8;
        lines.forEach(ln => { sidebarText(ln, ty, { font: 'Helvetica', size: 9.5 }); ty += 13; });
        cy = ty - 13;
        linesUsed = lines.length;
      }
      track(`custom:${cs.title || 'Section'}`, linesUsed, true);
      cy += SECTION_GAP;
    });
    sidebarBottom = cy - SECTION_GAP;
  }

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
    const headerAvailW = (PAGE_W - SIDEBAR_W) - 40;

    const NAME_SIZE_LADDER = [28, 24, 20, 18];
    const upperName = (content.name || '').toUpperCase();
    let nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
    let nameText = upperName;
    let nameFits = false;
    for (const s of NAME_SIZE_LADDER) {
      doc.font('Helvetica-Bold').fontSize(s);
      if (doc.widthOfString(upperName) <= headerAvailW) { nameSize = s; nameText = upperName; nameFits = true; break; }
    }
    if (!nameFits) {
      nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
      nameText = truncateToFit(doc, upperName, 'Helvetica-Bold', nameSize, headerAvailW);
    }
    doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(NAVY);
    const nameW = doc.widthOfString(nameText);
    doc.text(nameText, whiteCenter - nameW / 2, 81.4, { lineBreak: false });

    const rawSubtitle = (content.subtitle || '');
    const spacedSubtitle = rawSubtitle.split('').join(' ').toUpperCase();
    const SUBTITLE_SIZE_LADDER = [10.5, 9.5, 8.5, 7.5, 6.5];
    let subtitleSize = SUBTITLE_SIZE_LADDER[SUBTITLE_SIZE_LADDER.length - 1];
    let subtitle = spacedSubtitle;
    let subtitleFits = false;
    for (const s of SUBTITLE_SIZE_LADDER) {
      doc.font('Helvetica').fontSize(s);
      if (doc.widthOfString(spacedSubtitle) <= headerAvailW) { subtitleSize = s; subtitleFits = true; break; }
    }
    if (!subtitleFits) {
      subtitleSize = SUBTITLE_SIZE_LADDER[SUBTITLE_SIZE_LADDER.length - 1];
      subtitle = truncateToFit(doc, spacedSubtitle, 'Helvetica', subtitleSize, headerAvailW);
    }
    doc.font('Helvetica').fontSize(subtitleSize).fillColor(WHITE);
    const subW = doc.widthOfString(subtitle);
    const subH = doc.currentLineHeight();
    doc.text(subtitle, whiteCenter - subW / 2, cyTop - subH / 2, { lineBreak: false });
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
      const dateSafe = truncateToFit(doc, exp.dateRange || '', 'Helvetica-Oblique', 10, 150);
      // FIX: title no longer truncated — wraps and pushes the date below
      // it if it doesn't fit next to the date on one line. See the FIX
      // note at the top of this file.
      const headerR = expTitleDateRow(doc, { org: exp.org, date: dateSafe }, CONTENT_LEFT, y + 1, CONTENT_W, {
        titleFont: 'Helvetica-Bold', titleSize: 10.5, titleColor: NAVY,
        dateFont: 'Helvetica-Oblique', dateSize: 10, dateColor: LIGHT_BLUE,
        lineH: 13, gap: 10, draw
      });
      y = headerR.y + 3.5;
      if (draw) {
        const roleText = truncateToFit(doc, exp.role || '', 'Helvetica-Oblique', 10, CONTENT_W);
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(BODY_GRAY);
        doc.text(roleText, CONTENT_LEFT, y, { lineBreak: false });
      }
      y += 15.5;
      const r2 = contentBullets(exp.bullets || [], y);
      linesUsed += 1 + headerR.lines + r2.lines;
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

  const mainCustom = (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar');
  mainCustom.forEach(cs => {
    y = contentHeading((cs.title || 'Section').toUpperCase(), y + GAP_SECTION);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r4 = contentBullets(cs.items, y);
      y = r4.y;
      linesUsed = r4.lines;
    } else if (cs.text) {
      const r4 = contentParagraph(cs.text, y);
      y = r4.y;
      linesUsed = r4.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
  });

  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = contentHeading(refList.length > 1 ? 'REFERENCES' : 'REFERENCE', y + GAP_SECTION);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 10.5, CONTENT_W).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Helvetica', 10, CONTENT_W).slice(0, 2) : [];
      const emailLines = ref.email ? wrapLines(doc, `Email: ${ref.email}`, 'Helvetica', 10, CONTENT_W) : [];
      const phoneLines = ref.phone ? wrapLines(doc, `Phone: ${ref.phone}`, 'Helvetica', 10, CONTENT_W) : [];

      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
        let ny = y + 1;
        nameLines.forEach(ln => { doc.text(ln, CONTENT_LEFT, ny, { lineBreak: false }); ny += 15; });

        doc.font('Helvetica').fontSize(10).fillColor(BODY_GRAY);
        let ly = ny + 2;
        roleLines.forEach(ln => { doc.text(ln, CONTENT_LEFT, ly, { lineBreak: false }); ly += 14; });

        let fy = ly + (roleLines.length ? 3 : 0);
        emailLines.forEach(ln => { doc.text(ln, CONTENT_LEFT, fy, { lineBreak: false }); fy += 14.5; });
        phoneLines.forEach(ln => { doc.text(ln, CONTENT_LEFT, fy, { lineBreak: false }); fy += 14.5; });
      }

      let entryH = nameLines.length * 15 + 2;
      if (roleLines.length) entryH += roleLines.length * 14 + 3;
      entryH += emailLines.length * 14.5 + phoneLines.length * 14.5;
      entryH += tightLeading ? 8 : 14;

      y += entryH;
      linesUsed += nameLines.length + roleLines.length + emailLines.length + phoneLines.length;
      if (i < refList.length - 1) y += 6;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: Math.max(y, sidebarBottom), sections };
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