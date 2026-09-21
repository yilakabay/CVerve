// functions/lib/cv-template-gold-header.js
//
// "Corporate Minimal Gold" CV template — ported from the original ReportLab
// design: a full-width charcoal header band with a square photo top-right,
// gold accent throughout, and a two-column body (narrow date/label column,
// wide content column). Same measure()/render() contract as every other
// template — see cv-template-minimal.js for the full explanation.
//
// ── Fit escalation ladder ─────────────────────────────────────────────
// This template's skills are already laid out as a dense 3-column grid
// (not one-per-line), so there's no "compact skills" step to add here —
// the ladder is just two levels: normal → tight-leading. See
// cv-template-copper-diagonal.js for the full explanation of why render()
// refuses (throws) rather than drawing overlapping/clipped text if even
// the tightened layout still overflows past a small threshold.

const { PDFDocument, measureDoc, wrapLines, truncateToFit, normalizeEducation, normalizeReferences, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const CHARCOAL = '#1C1C1E', GOLD = '#B8962E', GOLD_LITE = '#E6D199';
const WHITE = '#FFFFFF', BODY = '#38383D', MUTED = '#858589';

const MARGIN_L = 42.0, MARGIN_R = PAGE_W - 38.0;
const LABEL_W = 88.0, GAP0 = 14.0;
const CONTENT_X = MARGIN_L + LABEL_W + GAP0;
const CONTENT_R = MARGIN_R;
const CONTENT_W = CONTENT_R - CONTENT_X;
const HEADER_H = 195.0, PHOTO_SIZE = HEADER_H, PHOTO_X = PAGE_W - PHOTO_SIZE;
const BODY_TOP = HEADER_H + 30.0;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function layout(doc, content, { draw, stretchPerGap = 0, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    const floor = size + 2.2;
    return Math.max(floor, Math.round(leading * 0.86 * 10) / 10);
  };
  const tightenGap = (gap) => tightLeading ? Math.round(gap * 0.6) : gap;

  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill('#FCFCFC');
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(CHARCOAL);
    doc.rect(0, 0, 6, HEADER_H).fill(GOLD);
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.rect(PHOTO_X, 0, PHOTO_SIZE, PHOTO_SIZE).clip();
        doc.image(buf, PHOTO_X, 0, { width: PHOTO_SIZE, height: PHOTO_SIZE, cover: [PHOTO_SIZE, PHOTO_SIZE] });
        doc.restore();
      } catch (e) { console.error('gold-header photo error:', e.message); }
    } else {
      doc.rect(PHOTO_X, 0, PHOTO_SIZE, PHOTO_SIZE).fill('#3A3A3E');
    }
    doc.rect(PHOTO_X, 0, PHOTO_SIZE, PHOTO_SIZE).lineWidth(1.5).stroke(GOLD);

    // ── Name: two stacked lines (first word large, rest of the name below
    // in gold) — this already acts like a natural 2-line wrap by word, but
    // previously neither line had a width limit at all, so a long single
    // first name or a long "rest of name" could run straight into the
    // photo. Each line now shrinks through a small size ladder to fit the
    // available width before falling back to truncateToFit as a last
    // resort — and everything below (divider, subtitle, contact rows) now
    // cascades off the ACTUAL measured bottom of these lines instead of
    // fixed y offsets, so it can never overlap a name that needed to
    // shrink or truncate.
    const nameAvailW = PHOTO_X - 18 - 18;
    const nameWords = (content.name || '').trim().split(/\s+/).filter(Boolean);
    const firstWord = nameWords[0] || '';
    const restWords = nameWords.slice(1).join(' ');
    const NAME_SIZE_LADDER = [36, 30, 26, 22];

    function fitNameLine(text) {
      let size = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
      for (const s of NAME_SIZE_LADDER) {
        doc.font('Helvetica-Bold').fontSize(s);
        if (doc.widthOfString(text) <= nameAvailW) { size = s; return { text, size }; }
      }
      doc.font('Helvetica-Bold').fontSize(size);
      return { text: truncateToFit(doc, text, 'Helvetica-Bold', size, nameAvailW), size };
    }

    const L1_TOP = 18;
    const line1 = fitNameLine(firstWord);
    doc.font('Helvetica-Bold').fontSize(line1.size).fillColor(WHITE);
    const line1H = doc.currentLineHeight(true);
    doc.text(line1.text, 18, L1_TOP, { lineBreak: false });
    const line1BottomY = L1_TOP + line1H;

    let line2BottomY = line1BottomY;
    if (restWords) {
      const L2_TOP = line1BottomY + 2;
      const line2 = fitNameLine(restWords);
      doc.font('Helvetica-Bold').fontSize(line2.size).fillColor(GOLD_LITE);
      const line2H = doc.currentLineHeight(true);
      doc.text(line2.text, 18, L2_TOP, { lineBreak: false });
      line2BottomY = L2_TOP + line2H;
    }

    const DIVIDER_Y = line2BottomY + 11;
    doc.strokeColor(GOLD).lineWidth(1).moveTo(18, DIVIDER_Y).lineTo(PHOTO_X - 18, DIVIDER_Y).stroke();

    // ── Subtitle: wraps up to 2 lines against the same available width,
    // instead of running past the photo unbounded ─────────────────────
    const SUBTITLE_TOP = DIVIDER_Y + 14;
    doc.font('Helvetica').fontSize(9.5).fillColor(GOLD_LITE);
    const subtitleLineH = doc.currentLineHeight(true);
    const subtitleLines = wrapLines(doc, (content.subtitle || '').toUpperCase(), 'Helvetica', 9.5, nameAvailW).slice(0, 2);
    let subtitleBottomY = SUBTITLE_TOP;
    if (subtitleLines.length) {
      subtitleLines.forEach((ln, i) => {
        const lineY = SUBTITLE_TOP + i * subtitleLineH;
        doc.text(ln, 18, lineY, { lineBreak: false, width: nameAvailW, ellipsis: true });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    // Contact rows: any missing field is simply absent from
    // content.contact, so .filter(Boolean) already drops it. Their
    // starting position now derives from subtitleBottomY instead of a
    // fixed constant, so a wrapped subtitle pushes them down instead of
    // overlapping them. Each row's bullet dot and its text still share
    // one cy value, so they stay in sync with each other too.
    const CONTACT_TOP = subtitleBottomY + 10;
    doc.font('Helvetica').fontSize(10);
    const contacts = [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean);
    contacts.forEach((ct, i) => {
      const cy = CONTACT_TOP + i * 15.5;
      doc.fillColor(GOLD).circle(21, cy + 3.5, 1.8).fill();
      doc.fillColor(WHITE).text(ct, 30, cy, { lineBreak: false, width: PHOTO_X - 30 - 18, ellipsis: true });
    });
  }

  function section(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GOLD);
      doc.text(label, MARGIN_L, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(0.6).moveTo(MARGIN_L, yTop + 6).lineTo(CONTENT_R, yTop + 6).stroke();
    }
    return yTop + 16;
  }
  // Right-aligned date/label column: this MUST stay one line (the content
  // column starts right after it), so an unusually long value is
  // truncated to fit rather than left to run past LABEL_W into the
  // content text or off the page's left margin.
  function dateLabel(text, yTop) {
    if (!draw || !text) return;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
    const safe = truncateToFit(doc, text, 'Helvetica-Oblique', 8, LABEL_W - 2);
    const tw = doc.widthOfString(safe);
    doc.text(safe, MARGIN_L + LABEL_W - tw, yTop, { lineBreak: false });
  }
  function boldLine(text, yTop, size = 10.5) {
    if (draw) { doc.font('Helvetica-Bold').fontSize(size).fillColor(BODY); doc.text(text, CONTENT_X, yTop, { lineBreak: false }); }
    return yTop + size + 3;
  }
  function italicLine(text, yTop, size = 9.2) {
    if (draw) { doc.font('Helvetica-Oblique').fontSize(size).fillColor(GOLD); doc.text(text, CONTENT_X, yTop, { lineBreak: false }); }
    return yTop + size + 3;
  }
  function para(text, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = tighten(opts.leading || 13.5, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, CONTENT_W - (opts.indent || 0));
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, CONTENT_X + (opts.indent || 0), cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function bullet(text, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = tighten(opts.leading || 13.0, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, CONTENT_W - 10);
    if (draw) {
      doc.fillColor(GOLD).circle(CONTENT_X + 3.5, yTop - 2.5, 1.8).fill();
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, CONTENT_X + 10, cur, { lineBreak: false }); cur += leading; });
      return cur + (tightLeading ? 0.8 : 1.5);
    }
    return yTop + lines.length * leading + (tightLeading ? 0.8 : 1.5);
  }

  let y = BODY_TOP;
  const GS = stretchPerGap;

  if (content.profile) {
    y = section('PROFILE', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + tightenGap(10) + GS;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    y = section('EXPERIENCE', y);
    let linesUsed = 0;
    content.experience.forEach(exp => {
      dateLabel(exp.dateRange, y + 2);
      y = boldLine(exp.org || '', y);
      y = italicLine(exp.role || '', y - 2);
      y += 1;
      (exp.bullets || []).forEach(b => { y = bullet(b, y); linesUsed++; });
      linesUsed += 2;
    });
    track('experience', linesUsed, true);
    y += tightenGap(8) + GS;
  } else track('experience', 0, false);

  const eduList = normalizeEducation(content.education);
  if (eduList.length) {
    y = section('EDUCATION', y);
    let linesUsed = 0;
    eduList.slice(0, 2).forEach(edu => {
      dateLabel(edu.dateRange, y + 2);
      y = boldLine(edu.school || '', y);
      if (edu.degree) y = italicLine(edu.degree, y - 2);
      if (edu.extra) { y = bullet(edu.extra, y); linesUsed++; }
      y += tightLeading ? 3 : 6;
      linesUsed += 2;
    });
    track('education', linesUsed, true);
    y += tightenGap(4) + GS;
  } else track('education', 0, false);

  if (content.achievements && content.achievements.length) {
    y = section('ACHIEVEMENTS', y);
    let linesUsed = 0;
    content.achievements.forEach(a => { y = bullet(a, y); linesUsed++; });
    track('achievements', linesUsed, true);
    y += tightenGap(10) + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    y = section('CERTIFICATIONS', y);
    let linesUsed = 0;
    const titleLeading = tighten(12, 9.2), issuerLeading = tighten(12.5, 8.5);
    content.certifications.forEach((cert, i) => {
      dateLabel(String(i + 1).padStart(2, '0'), y + 2);
      // Title now wraps (up to 2 lines) instead of being drawn with no
      // width at all, which used to let a long title run past CONTENT_R.
      const titleLines = wrapLines(doc, cert.title || '', 'Helvetica-Bold', 9.2, CONTENT_W).slice(0, 2);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.2).fillColor(BODY);
        let ty = y;
        titleLines.forEach(ln => { doc.text(ln, CONTENT_X, ty, { lineBreak: false }); ty += titleLeading; });
        y = ty;
      } else {
        y += titleLines.length * titleLeading;
      }
      const issuerLines = wrapLines(doc, cert.issuer || '', 'Helvetica', 8.5, CONTENT_W);
      if (draw) {
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
        let iy = y;
        issuerLines.forEach(ln => { doc.text(ln, CONTENT_X, iy, { lineBreak: false }); iy += issuerLeading; });
        y = iy;
      } else {
        y += issuerLines.length * issuerLeading;
      }
      y += tightLeading ? 2 : 4;
      linesUsed += titleLines.length + issuerLines.length;
    });
    track('certifications', linesUsed, true);
    y += tightenGap(4) + GS;
  } else track('certifications', 0, false);

  if (content.skills && content.skills.length) {
    y = section('SKILLS', y);
    // Skills are a dense fixed-row-height grid (3 columns, 4 in tight
    // mode), so a skill has to stay on ONE line — there's no room in the
    // row below it to wrap into. Previously this relied on PDFKit's
    // lineBreak:false + width + ellipsis to truncate, but that combo has
    // proven unreliable elsewhere in this app (it can still wrap once a
    // width is given, which would silently overlap the row underneath).
    // truncateToFit() does the truncation manually and draws the
    // already-safe, guaranteed-single-line result instead.
    const colCount = tightLeading ? 4 : 3, colW = CONTENT_W / colCount;
    const rowH = tightLeading ? 11.5 : 13;
    let linesUsed = 0;
    content.skills.forEach((skill, i) => {
      const row = Math.floor(i / colCount), col = i % colCount;
      const sy = y + row * rowH;
      if (draw) {
        doc.fillColor(GOLD).rect(CONTENT_X + col * colW, sy + 1, 3, 3).fill();
        const safe = truncateToFit(doc, skill, 'Helvetica', 8.8, colW - 10);
        doc.font('Helvetica').fontSize(8.8).fillColor(BODY);
        doc.text(safe, CONTENT_X + col * colW + 7, sy, { lineBreak: false });
      }
      if (col === 0) linesUsed++;
    });
    y += Math.ceil(content.skills.length / colCount) * rowH + tightenGap(4) + GS;
    track('skills', linesUsed, true);
  } else track('skills', 0, false);

  if (content.languages && content.languages.length) {
    y = section('LANGUAGES', y);
    const langRowH = tightLeading ? 13 : 15;
    content.languages.forEach(l => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.2).fillColor(BODY);
        doc.text(l.name, CONTENT_X, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(8.8).fillColor(MUTED);
        doc.text(l.level, CONTENT_X + 70, y, { lineBreak: false });
      }
      y += langRowH;
    });
    track('languages', content.languages.length, true);
    y += tightenGap(4) + GS;
  } else track('languages', 0, false);

  // ── Custom sections ───────────────────────────────────────────────────
  // A user can ask the AI to add a section not in the fixed schema (e.g.
  // "Academic Projects", "Hobbies"). This template has no sidebar/main
  // split — everything lives in one column — so every entry in
  // content.customSections (regardless of any placement hint) lands here,
  // via the same section/bullet/para helpers as every built-in section,
  // getting the same width-safe wrapping.
  (content.customSections || []).forEach(cs => {
    y = section((cs.title || 'Section').toUpperCase(), y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      cs.items.forEach(item => { y = bullet(item, y); linesUsed++; });
    } else if (cs.text) {
      const r = para(cs.text, y);
      y = r.y;
      linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += tightenGap(8) + GS;
  });

  // References: content.references is an array (1, 2, 3+ — no cap).
  // Name/role/email/phone now all wrap against CONTENT_W via wrapLines,
  // same as every other multi-line field in this file — previously role
  // had NO width bound at all, and email/phone had none either, so a long
  // one would simply run off the right edge of the page instead of
  // wrapping or being caught by the fit/overflow system.
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = section('REFERENCE' + (refList.length > 1 ? 'S' : ''), y);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 9.5, CONTENT_W).slice(0, 2);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BODY);
        let ny = y;
        nameLines.forEach(ln => { doc.text(ln, CONTENT_X, ny, { lineBreak: false }); ny += 13; });
        y = ny;
      } else { y += nameLines.length * 13; }
      linesUsed += nameLines.length;

      if (ref.role) {
        const roleLines = wrapLines(doc, ref.role, 'Helvetica', 9, CONTENT_W);
        if (draw) {
          doc.font('Helvetica').fontSize(9).fillColor(MUTED);
          let roY = y;
          roleLines.forEach(ln => { doc.text(ln, CONTENT_X, roY, { lineBreak: false }); roY += 13; });
          y = roY;
        } else { y += roleLines.length * 13; }
        linesUsed += roleLines.length;
      }

      [['Email', ref.email], ['Phone', ref.phone]].forEach(([label, val]) => {
        if (!val) return;
        doc.font('Helvetica-Bold').fontSize(8.5);
        const lw = doc.widthOfString(label + ':  ');
        const valLines = wrapLines(doc, val, 'Helvetica', 8.5, CONTENT_W - lw);
        if (draw) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
          doc.text(label + ':', CONTENT_X, y, { lineBreak: false });
          doc.font('Helvetica').fontSize(8.5).fillColor(BODY);
          let vy = y;
          valLines.forEach(ln => { doc.text(ln, CONTENT_X + lw, vy, { lineBreak: false }); vy += 13; });
          y = vy;
        } else { y += valLines.length * 13; }
        linesUsed += valLines.length;
      });

      if (i < refList.length - 1) y += 8;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: y, sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { tightLeading: false } },
  { name: 'tight-leading', opts: { tightLeading: true } }
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