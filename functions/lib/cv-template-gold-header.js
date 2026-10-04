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
//
// ── FIX: experience/education org line no longer unbounded ──────────────
// boldLine() (used for each experience's org and each education entry's
// school) used to draw its text with NO width limit at all — a long org
// or school name could run straight past CONTENT_R into the page margin.
// The date for each entry sits in its own separate left-hand label column
// here (dateLabel()), so there's no risk of the title colliding with a
// date the way the sidebar/timeline templates could — but the title
// itself still needed a width guard. It now wraps onto as many lines as
// it needs (full CONTENT_W), never overflowing and never truncated.

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

    const SUBTITLE_TOP = DIVIDER_Y + 14;
    doc.font('Helvetica').fontSize(9.5).fillColor(GOLD_LITE);
    const subtitleLineH = doc.currentLineHeight(true);
    const subtitleLines = wrapLines(doc, (content.subtitle || '').toUpperCase(), 'Helvetica', 9.5, nameAvailW).slice(0, 2);
    // FIX: this previously used PDFKit's own width+ellipsis option, which
    // (per the warning in cv-shared.js's truncateToFit) can still wrap
    // onto an extra line instead of truncating once a width is supplied
    // — here that would silently push CONTACT_TOP (and everything below
    // it) down without the rest of the layout knowing. wrapLines() has
    // already bounded this to 2 lines above, so each of those 2 lines
    // just needs a guaranteed-safe single-line truncate, same as every
    // other truncated field in this file.
    let subtitleBottomY = SUBTITLE_TOP;
    if (subtitleLines.length) {
      subtitleLines.forEach((ln, i) => {
        const lineY = SUBTITLE_TOP + i * subtitleLineH;
        const safe = truncateToFit(doc, ln, 'Helvetica', 9.5, nameAvailW);
        doc.text(safe, 18, lineY, { lineBreak: false });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    // ── Contact rows ──────────────────────────────────────────────────
    // Order: phone, email, LinkedIn, location. LinkedIn sits between
    // email and location (not first — it's a secondary contact detail,
    // not the headline one) and is simply omitted via .filter(Boolean)
    // when the user didn't provide it, same as every other contact field.
    //
    // FIX (overflow past the header band): this block used to assume at
    // most 3 rows at a fixed 15.5pt row height, which is exactly enough
    // to stay inside HEADER_H (195pt) given where CONTACT_TOP typically
    // lands. Adding a 4th row (LinkedIn) at that same fixed spacing can
    // push past the bottom of the charcoal header band and visibly spill
    // onto the lighter body background below it — and the same risk
    // exists any time a long name/subtitle has already pushed
    // CONTACT_TOP further down than usual. So the row height is now
    // computed from the ACTUAL remaining space down to the header's
    // bottom edge: it only compresses (down to a readable floor) when
    // there isn't enough room for the default 15.5pt spacing, and stays
    // at the normal spacing otherwise.
    const CONTACT_TOP = subtitleBottomY + 10;
    const contacts = [content.contact?.phone, content.contact?.email, content.contact?.linkedin, content.contact?.location].filter(Boolean);
    if (contacts.length) {
      const HEADER_BOTTOM_PAD = 14;
      const availableH = Math.max(0, (HEADER_H - HEADER_BOTTOM_PAD) - CONTACT_TOP);
      const idealRowH = 15.5;
      const minRowH = 11.5;
      const fitRowH = contacts.length > 1 ? availableH / contacts.length : idealRowH;
      const rowH = Math.max(minRowH, Math.min(idealRowH, fitRowH));
      const fontSize = rowH < 13 ? 8.7 : 10;
      doc.font('Helvetica').fontSize(fontSize);
      // Same reasoning as the subtitle fix above: truncateToFit()'s manual
      // binary-search truncation is used instead of PDFKit's width+
      // ellipsis, which can silently wrap instead of truncate and would
      // overlap the next contact row.
      const contactTextW = PHOTO_X - 30 - 18;
      contacts.forEach((ct, i) => {
        const cy = CONTACT_TOP + i * rowH;
        doc.fillColor(GOLD).circle(21, cy + fontSize * 0.42, 1.8).fill();
        const safe = truncateToFit(doc, ct, 'Helvetica', fontSize, contactTextW);
        doc.font('Helvetica').fontSize(fontSize).fillColor(WHITE);
        doc.text(safe, 30, cy, { lineBreak: false });
      });
    }
  }

  function section(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GOLD);
      doc.text(label, MARGIN_L, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(0.6).moveTo(MARGIN_L, yTop + 6).lineTo(CONTENT_R, yTop + 6).stroke();
    }
    return yTop + 16;
  }
  function dateLabel(text, yTop) {
    if (!draw || !text) return;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
    const safe = truncateToFit(doc, text, 'Helvetica-Oblique', 8, LABEL_W - 2);
    const tw = doc.widthOfString(safe);
    doc.text(safe, MARGIN_L + LABEL_W - tw, yTop, { lineBreak: false });
  }
  // FIX: previously drew `text` at full width with no limit at all, so a
  // long org/school name could run straight past CONTENT_R into the page
  // margin. Now wraps onto as many lines as it needs (full CONTENT_W),
  // returning the real bottom y so callers advance by the actual height
  // used instead of a fixed single-line offset.
  function boldLine(text, yTop, size = 10.5) {
    const lines = wrapLines(doc, text || '', 'Helvetica-Bold', size, CONTENT_W);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, CONTENT_X, cur, { lineBreak: false }); cur += size + 3; });
    }
    return yTop + lines.length * (size + 3);
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
  // ── Bullet point ──────────────────────────────────────────────────────
  // FIX (bullet/text misalignment): the dot's vertical center used to be a
  // fixed "yTop - 2.5" offset, tuned only for the default size=9.2 call.
  // Any bullet drawn at a different size (tightLeading mode, or a future
  // opts.size override) kept that same fixed offset even though the
  // line's actual height had changed — so the dot drifted away from the
  // middle of its own first line, which is the "dot floating between two
  // lines" effect in the PDF. Now the offset is derived from
  // doc.currentLineHeight() for the size THIS call actually uses, so the
  // dot stays centered on its line regardless of size/leading.
  function bullet(text, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = tighten(opts.leading || 13.0, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, CONTENT_W - 10);
    if (draw) {
      doc.font('Helvetica').fontSize(size);
      const lineH = doc.currentLineHeight(true);
      const dotY = yTop + lineH / 2 - 1.3;
      doc.fillColor(GOLD).circle(CONTENT_X + 3.5, dotY, 1.8).fill();
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
      const orgTop = y;
      y = boldLine(exp.org || '', y);
      const orgLines = Math.round((y - orgTop) / ((10.5) + 3)) || 1;
      y = italicLine(exp.role || '', y - 2);
      y += 1;
      (exp.bullets || []).forEach(b => { y = bullet(b, y); linesUsed++; });
      linesUsed += 1 + orgLines;
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
      const schoolTop = y;
      y = boldLine(edu.school || '', y);
      const schoolLines = Math.round((y - schoolTop) / ((10.5) + 3)) || 1;
      if (edu.degree) y = italicLine(edu.degree, y - 2);
      if (edu.extra) { y = bullet(edu.extra, y); linesUsed++; }
      y += tightLeading ? 3 : 6;
      linesUsed += 1 + schoolLines;
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

  // ── Skills ──────────────────────────────────────────────────────────
  // FIX (skills cut off with "…"): previously a fixed 3/4-column grid
  // forced every skill cell to a single line via truncateToFit(), which
  // silently chopped off text ("Financial Data Analy…") any time a skill
  // phrase didn't fit the column — real content loss, not just a
  // cosmetic wrap.
  //
  // Now each cell WRAPS at the normal skill font size instead of
  // shrinking or cutting — as many lines as the phrase needs, no cap.
  // The grid is no longer a fixed single row height: each row's height
  // is computed from whichever item in that row needed the most lines,
  // so a long skill gets all the vertical room it needs and the row
  // below starts after that, same as every other "measure then draw"
  // section in this file. wrapLines() itself still force-breaks a
  // single word wider than the column (e.g. a long URL/compound term),
  // so nothing can run past the cell's edge — but a whole skill phrase
  // is never truncated anymore, however long it is.
  if (content.skills && content.skills.length) {
    y = section('SKILLS', y);
    const colCount = tightLeading ? 4 : 3, colW = CONTENT_W / colCount;
    const lineH = tightLeading ? 10.5 : 12;
    const rowPad = tightLeading ? 3 : 5;
    const size = 8.8;
    const cellW = colW - 10;

    doc.font('Helvetica').fontSize(size);
    const wrapped = content.skills.map(skill => wrapLines(doc, String(skill), 'Helvetica', size, cellW));

    const rowCount = Math.ceil(content.skills.length / colCount);
    let linesUsed = 0;
    let cy = y;
    for (let row = 0; row < rowCount; row++) {
      const rowItems = [];
      for (let col = 0; col < colCount; col++) {
        const i = row * colCount + col;
        if (i < wrapped.length) rowItems.push(wrapped[i]);
      }
      const maxLines = Math.max(1, ...rowItems.map(w => w.length));
      if (draw) {
        for (let col = 0; col < colCount; col++) {
          const i = row * colCount + col;
          if (i >= content.skills.length) continue;
          const wlines = wrapped[i];
          const cellX = CONTENT_X + col * colW;
          doc.fillColor(GOLD).rect(cellX, cy + 1, 3, 3).fill();
          doc.font('Helvetica').fontSize(size).fillColor(BODY);
          wlines.forEach((ln, li) => {
            doc.text(ln, cellX + 7, cy + lineH * li, { lineBreak: false });
          });
        }
      }
      cy += lineH * maxLines + rowPad;
      if (row === 0) linesUsed = maxLines;
    }
    y = cy + tightenGap(4) + GS - rowPad;
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