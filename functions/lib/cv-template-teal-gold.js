// functions/lib/cv-template-teal-gold.js
//
// "Teal & Gold" CV template — ported from the original ReportLab design: a
// full-width teal header with circular photo, a dark-teal left sidebar
// below it (education, skills, languages), and a wide right content
// column. Same measure()/render() contract as every other template.
//
// ── Fit escalation ladder ─────────────────────────────────────────────
// See cv-template-copper-diagonal.js for the full explanation. Same three
// levels here: normal → compact-skills (flow-wrap) → +tight-leading, with
// render() refusing to draw (throwing) if even the most compact level
// still overflows past a small, genuinely-crowded threshold.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const TEAL = '#173F52', GOLD = '#BC9138', GOLD_LIGHT = '#F0E1AD';
const SIDEBAR_BG = '#1C4F66', PALE_BG = '#F3F6F9';
const BODY = '#2E383D', MID = '#737F8C', WHITE = '#FFFFFF';

const HEADER_H = 152.0, LEFT_W = 190.0, L_PAD = 20.0, R_PAD = 20.0;
const R_LEFT = LEFT_W + R_PAD + 2, R_RIGHT = PAGE_W - 20.0, RIGHT_W = R_RIGHT - R_LEFT;
const PHOTO_R = 50.0, PHOTO_CX = LEFT_W / 2, PHOTO_CY = HEADER_H / 2;
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
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(PALE_BG);
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(TEAL);
    doc.rect(0, HEADER_H, LEFT_W, PAGE_H - HEADER_H).fill(SIDEBAR_BG);
    doc.rect(0, HEADER_H, PAGE_W, 3.5).fill(GOLD);
    doc.rect(LEFT_W, 0, 2.5, HEADER_H).fill(GOLD);
    doc.rect(LEFT_W + 18, 10, 3, 106).fill(GOLD);

    const nameX = LEFT_W + 30;
    const NAME_TOP = 30;
    doc.font('Helvetica-Bold').fontSize(28).fillColor(WHITE);
    // Measure the name's actual rendered line height (PDFKit's own metric
    // for the current font/size) instead of a hardcoded offset, so the
    // subtitle is always placed fully below it — including descenders —
    // no matter what font size this header ends up using later.
    const nameLineH = doc.currentLineHeight(true);
    doc.text(content.name || '', nameX, NAME_TOP, { lineBreak: false });

    const SUBTITLE_TOP = NAME_TOP + nameLineH + 4;
    doc.font('Helvetica').fontSize(10.5).fillColor(GOLD);
    const subtitleLineH = doc.currentLineHeight(true);
    const subtitleAvailW = (PAGE_W - 18) - nameX;

    // The letter-spacing effect (a space inserted between every character)
    // roughly doubles a title's rendered width, so word-wrap the ORIGINAL
    // text using a conservative shrink factor first — this breaks at real
    // word boundaries rather than mid-word — then apply the letter-spacing
    // per finished line. Capped at 2 lines; doc.text's own width+ellipsis
    // is a hard backstop underneath this estimate, so even an unusually
    // wide title (a very long single word, an unexpected font metric) can
    // never physically draw past the header's right edge.
    const rawSubtitleLines = wrapLines(doc, content.subtitle || '', 'Helvetica', 10.5, subtitleAvailW / 1.9).slice(0, 2);
    const spacedSubtitleLines = rawSubtitleLines.map(ln => ln.split('').join(' ').toUpperCase());

    // Draw each subtitle line while tracking the actual bottom y-coordinate
    // we drew at, rather than trusting a separately-computed line count.
    // Everything below the subtitle (the divider, and the contact row —
    // both its bullet dots AND its text) is then positioned relative to
    // THIS single measured value, so a 1-line vs 2-line subtitle can never
    // leave the dots and the text out of sync with each other or with the
    // divider — they all derive from the same number.
    let subtitleBottomY = SUBTITLE_TOP;
    spacedSubtitleLines.forEach((ln, i) => {
      const lineY = SUBTITLE_TOP + i * subtitleLineH;
      doc.text(ln, nameX, lineY, { lineBreak: false, width: subtitleAvailW, ellipsis: true });
      subtitleBottomY = lineY + subtitleLineH;
    });
    // Even with no subtitle at all, still reserve one line's worth of
    // space so the divider/contact row sit at a consistent baseline.
    if (!spacedSubtitleLines.length) subtitleBottomY = SUBTITLE_TOP + subtitleLineH;

    const DIVIDER_Y = subtitleBottomY + 3;
    doc.strokeColor(GOLD).lineWidth(0.7).moveTo(nameX, DIVIDER_Y).lineTo(PAGE_W - 18, DIVIDER_Y).stroke();

    // Single shared row position for the whole contact line — the dot
    // bullets and the text of every contact item read from this ONE
    // variable, so they move down together as a unit whenever the
    // subtitle (and therefore the divider) grows to a second line.
    const rowY = DIVIDER_Y + 17;
    let ix = nameX;
    doc.font('Helvetica').fontSize(8.5);
    [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean).forEach(txt => {
      const tw = doc.widthOfString(txt);
      // Vertically center the dot against the text's optical middle rather
      // than its top — doc.text's y is the top of the glyph box, so the
      // dot needs to sit roughly half a line down from there, not above
      // it (which is what made it look like it was floating too high).
      doc.fillColor(GOLD).circle(ix + 3, rowY + 3.2, 1.8).fill();
      doc.fillColor(WHITE).text(txt, ix + 9, rowY, { lineBreak: false });
      ix += tw + 22;
    });

    doc.fillColor(WHITE).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 4).fill();
    doc.strokeColor(GOLD).lineWidth(2.5).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 4).stroke();
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(PHOTO_CX, PHOTO_CY, PHOTO_R).clip();
        doc.image(buf, PHOTO_CX - PHOTO_R, PHOTO_CY - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('teal-gold photo error:', e.message); }
    } else {
      doc.fillColor('#D5D9E0').circle(PHOTO_CX, PHOTO_CY, PHOTO_R).fill();
    }
  }

  function lhead(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(GOLD);
      doc.text(label, L_PAD, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(1.0).moveTo(L_PAD, yTop + 12).lineTo(LEFT_W - L_PAD, yTop + 12).stroke();
    }
    return yTop + 21;
  }
  function lbold(text, yTop, opts = {}) {
    const size = opts.size || 9;
    const lines = wrapLines(doc, text, 'Helvetica-Bold', size, LEFT_W - L_PAD * 2);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(opts.color || WHITE);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD, cur, { lineBreak: false }); cur += size * 1.35; });
    }
    return yTop + lines.length * size * 1.35;
  }
  function lnorm(text, yTop, opts = {}) {
    const size = opts.size || 8.5, indent = opts.indent || 0;
    const lines = wrapLines(doc, text, 'Helvetica', size, LEFT_W - L_PAD * 2 - indent);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || GOLD_LIGHT);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD + indent, cur, { lineBreak: false }); cur += size * 1.4; });
    }
    return yTop + lines.length * size * 1.4;
  }

  let y = HEADER_H + 18;
  y = lhead('EDUCATION', y);
  const eduList = normalizeEducation(content.education);
  eduList.slice(0, 2).forEach(edu => {
    if (draw) { doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD); doc.text(edu.dateRange || '', L_PAD, y + 7, { lineBreak: false }); }
    y += 13;
    y = lbold((edu.school || '').toUpperCase(), y);
    if (edu.degree) y = lnorm(edu.degree, y, { indent: 5 });
    if (edu.extra) y = lnorm(edu.extra, y, { indent: 5 });
    y += 8;
  });
  y += 6;

  // ── SKILLS ────────────────────────────────────────────────────────────
  // Every skill is wrapped to fit the sidebar column width, in BOTH the
  // normal per-line layout and the compact flow-wrap layout — including a
  // single skill/tag that's too long to fit on one line by itself (e.g.
  // "Financial Data Analysis and Interpretation"), which is what used to
  // run past the edge of the sidebar. See cv-shared.js's flowItems() for
  // the fix on the compact-skills path; the per-line path below already
  // wrapped correctly via wrapLines().
  y = lhead('SKILLS', y);
  if (compactSkills) {
    const skillsResult = flowItems(doc, content.skills || [], L_PAD + 6, y, LEFT_W - L_PAD * 2 - 6, {
      font: 'Helvetica', size: 8.8, color: WHITE,
      gapX: 10, gapY: 12.5,
      bulletColor: GOLD, bulletSize: 3.5, bulletGap: 5,
      draw
    });
    y = skillsResult.y;
    track('skills', skillsResult.lines, (content.skills || []).length > 0);
  } else {
    let skillLines = 0;
    (content.skills || []).forEach(sk => {
      const lines = wrapLines(doc, sk, 'Helvetica', 8.8, LEFT_W - L_PAD * 2 - 10);
      if (draw) {
        doc.fillColor(GOLD).rect(L_PAD, y + 6.2, 3.5, 3.5).fill();
        doc.font('Helvetica').fontSize(8.8).fillColor(WHITE);
        let cur = y;
        lines.forEach(ln => { doc.text(ln, L_PAD + 10, cur + 1.3, { lineBreak: false }); cur += 12; });
        y = cur;
      } else { y += lines.length * 12; }
      y += 2.5;
      skillLines += lines.length;
    });
    track('skills', skillLines, (content.skills || []).length > 0);
  }
  y += 4 + stretchPerGap;

  y = lhead('LANGUAGES', y);
  (content.languages || []).forEach((l) => {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
      doc.text(l.name, L_PAD, y + 7.5, { lineBreak: false });
      const lw = doc.widthOfString(l.name);
      doc.font('Helvetica').fontSize(8).fillColor(GOLD_LIGHT);
      doc.text(`(${l.level})`, L_PAD + lw + 4, y + 7, { lineBreak: false });
    }
    y += 13;
    const fillPct = proficiencyToFill(l.level);
    if (draw) {
      const bw = LEFT_W - L_PAD * 2;
      doc.fillColor('#3A6A7C').rect(L_PAD, y + 3.5, bw, 4).fill();
      doc.fillColor(GOLD).rect(L_PAD, y + 3.5, bw * fillPct, 4).fill();
    }
    y += 12;
  });

  function rhead(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(TEAL);
      doc.text(label, R_LEFT, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(1.5).moveTo(R_LEFT, yTop + 14).lineTo(R_RIGHT, yTop + 14).stroke();
    }
    return yTop + 23;
  }
  function rpara(text, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 14.0, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, RIGHT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, R_LEFT, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function rbullets(items, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 13.5, size);
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, item, 'Helvetica', size, RIGHT_W - 12);
      if (draw) {
        doc.fillColor(GOLD).rect(R_LEFT + 1, cur + size * 0.4, 3.5, 3.5).fill();
        doc.font('Helvetica').fontSize(size).fillColor(BODY);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, R_LEFT + 12, ly, { lineBreak: false }); ly += leading; });
      }
      cur += lines.length * leading + (tightLeading ? 1.5 : 3.5);
      total += lines.length;
    });
    return { y: cur, lines: total };
  }

  let ry = HEADER_H + 18;
  const GS = stretchPerGap;

  if (content.profile) {
    ry = rhead('PROFILE', ry);
    const r = rpara(content.profile, ry);
    track('profile', r.lines, true);
    ry = r.y + tightenGap(10) + GS;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    ry = rhead('EXPERIENCE', ry);
    let linesUsed = 0;
    content.experience.forEach(exp => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL);
        doc.text(exp.org || '', R_LEFT, ry + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(GOLD);
        const dw = doc.widthOfString(exp.dateRange || '');
        doc.text(exp.dateRange || '', R_RIGHT - dw, ry + 1, { lineBreak: false });
      }
      ry += 13;
      if (draw) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(MID); doc.text(exp.role || '', R_LEFT, ry, { lineBreak: false }); }
      ry += 12;
      const r2 = rbullets(exp.bullets || [], ry);
      linesUsed += 2 + r2.lines;
      ry = r2.y;
    });
    track('experience', linesUsed, true);
    ry += tightenGap(10) + GS;
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    ry = rhead('ACHIEVEMENT', ry);
    const r3 = rbullets(content.achievements, ry);
    track('achievements', r3.lines, true);
    ry = r3.y + tightenGap(10) + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    ry = rhead('CERTIFICATIONS & RECOGNITION', ry);
    let linesUsed = 0;
    const certLeading = tighten(13.5, 9.5);
    content.certifications.forEach((cert, i) => {
      const full = `${cert.title} | ${cert.issuer}`;
      const lines = wrapLines(doc, full, 'Helvetica', 9.5, RIGHT_W - 14);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GOLD);
        doc.text(`${i + 1}.`, R_LEFT, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        let ly = ry;
        lines.forEach(ln => { doc.text(ln, R_LEFT + 14, ly, { lineBreak: false }); ly += certLeading; });
        ry = ly;
      } else { ry += lines.length * certLeading; }
      linesUsed += lines.length;
    });
    track('certifications', linesUsed, true);
    ry += tightenGap(8) + GS;
  } else track('certifications', 0, false);

  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = rhead(refList.length > 1 ? 'REFERENCES' : 'REFERENCE', ry);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL);
        doc.text(ref.name, R_LEFT, ry + 1, { lineBreak: false });
        ry += 14;
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        doc.text(ref.role || '', R_LEFT, ry, { lineBreak: false });
        ry += 14;
        [['Email', ref.email], ['Phone', ref.phone]].forEach(([label, val]) => {
          if (!val) return;
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEAL);
          doc.text(label + ':', R_LEFT, ry, { lineBreak: false });
          const lw = doc.widthOfString(label + ': ');
          doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
          doc.text(val, R_LEFT + lw, ry, { lineBreak: false });
          ry += 13;
        });
      } else {
        ry += 14 + 14 + (ref.email ? 13 : 0) + (ref.phone ? 13 : 0);
      }
      linesUsed += 4;
      if (i < refList.length - 1) ry += 6;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: Math.max(y, ry), sections };
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
        underflowPoints: Math.round(available - finalY), underflowLines: Math.round((available - finalY) / 13.5),
        sections, appliedLevel: level.name, hardOverflow: false
      };
    }
  }

  const overflowPt = last.finalY - available;
  const overflowLines = Math.round(overflowPt / 13.5);
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