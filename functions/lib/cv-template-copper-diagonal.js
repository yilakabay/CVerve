// functions/lib/cv-template-copper-diagonal.js
//
// "Diagonal Navy & Copper" CV template — ported from the original
// ReportLab design: a full-height navy sidebar, a slate header band with a
// diagonal navy accent cut into it, a circular photo with copper/navy
// double ring, and a timeline-styled experience section on the right.
// Same measure()/render() contract as every other template.
//
// ── FIX: experience title/date row could overlap ────────────────────────
// The org/title next to each experience entry's date used to be drawn with
// NO width limit at all — a long org name could run straight underneath
// or into the date text with nothing to stop it. It now goes through
// cv-shared's expTitleDateRow(): if the title fits next to the date on one
// line, nothing changes; if it doesn't, the title wraps onto as many lines
// as it needs (full width) and the date drops onto its own line right
// after, so it can never overlap or get cut off.

const { PDFDocument, measureDoc, wrapLines, truncateToFit, expTitleDateRow, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const NAVY = '#141F45', COPPER = '#BF6125', COPPER_LT = '#F5E1C7';
const SLATE = '#243359', BODY = '#333B4D', MID = '#80878F', WHITE = '#FFFFFF', OFF_WHITE = '#F7F7F9';

const SIDEBAR_W = 195.0, HEADER_H = 158.0, PHOTO_R = 52.0;
const PHOTO_CX = SIDEBAR_W / 2, PHOTO_CY = HEADER_H / 2 + 6;
const L_PAD = 18.0, R_START = SIDEBAR_W + 18.0, R_END = PAGE_W - 18.0, RIGHT_W = R_END - R_START;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function layout(doc, content, { draw, stretchPerGap = 0, compactSkills = false, tightLeading = false } = {}) {
  // Tightening never goes below a floor that keeps wrapped lines within the
  // same bullet/paragraph from visually touching or overlapping — this is
  // a real cap, not just a smaller number, so "tight" mode can never
  // produce overlapping text no matter how it's combined with other flags.
  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    const floor = size + 2.2;
    return Math.max(floor, Math.round(leading * 0.86 * 10) / 10);
  };
  const tightenGap = (gap) => tightLeading ? Math.round(gap * 0.6) : gap;
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(OFF_WHITE);
    doc.rect(0, 0, SIDEBAR_W, PAGE_H).fill(NAVY);
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(SLATE);
    doc.polygon([0, 0], [SIDEBAR_W, 0], [SIDEBAR_W, HEADER_H], [0, HEADER_H]).fill(NAVY);
    doc.rect(SIDEBAR_W - 4, 0, 4, PAGE_H).fill(COPPER);
    doc.rect(0, 0, PAGE_W, 4).fill(COPPER);
    doc.rect(PAGE_W - 80, 0, 80, 40).fill('#2C3C68');

    const hx = SIDEBAR_W + 22;
    const NAME_TOP = 26;
    const headerAvailW = R_END - hx;

    // ── Name: wrap/shrink instead of running off the header ────────────
    const NAME_SIZE_LADDER = [30, 26, 22, 20];
    const upperName = (content.name || '').toUpperCase();
    let nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
    let nameLines = null;
    for (const size of NAME_SIZE_LADDER) {
      doc.font('Helvetica-Bold').fontSize(size);
      if (doc.widthOfString(upperName) <= headerAvailW) {
        nameSize = size;
        nameLines = [upperName];
        break;
      }
    }
    if (!nameLines) {
      nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
      doc.font('Helvetica-Bold').fontSize(nameSize);
      nameLines = wrapLines(doc, upperName, 'Helvetica-Bold', nameSize, headerAvailW).slice(0, 2);
    }
    doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(WHITE);
    const nameLineH = doc.currentLineHeight(true);
    let nameBottomY = NAME_TOP;
    nameLines.forEach((ln, i) => {
      const lineY = NAME_TOP + i * nameLineH;
      // FIX: truncateToFit instead of PDFKit's width+ellipsis, which can
      // silently wrap onto an extra line instead of truncating — here
      // that would throw off nameBottomY and everything cascading from it.
      const safe = truncateToFit(doc, ln, 'Helvetica-Bold', nameSize, headerAvailW);
      doc.text(safe, hx, lineY, { lineBreak: false });
      nameBottomY = lineY + nameLineH;
    });

    // ── Subtitle: same wrap-then-measure treatment, cascading off the
    // name's real bottom rather than a fixed y=62 offset ────────────────
    const SUBTITLE_TOP = nameBottomY + 6;
    doc.font('Helvetica').fontSize(10).fillColor(COPPER_LT);
    const subtitleLineH = doc.currentLineHeight(true);
    const subtitleLines = wrapLines(doc, (content.subtitle || '').toUpperCase(), 'Helvetica', 10, headerAvailW).slice(0, 2);
    let subtitleBottomY = SUBTITLE_TOP;
    if (subtitleLines.length) {
      subtitleLines.forEach((ln, i) => {
        const lineY = SUBTITLE_TOP + i * subtitleLineH;
        const safe = truncateToFit(doc, ln, 'Helvetica', 10, headerAvailW);
        doc.text(safe, hx, lineY, { lineBreak: false });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    const DIVIDER_Y = subtitleBottomY + 6;
    doc.strokeColor(COPPER).lineWidth(0.8).moveTo(hx, DIVIDER_Y).lineTo(R_END, DIVIDER_Y).stroke();

    // ── Contact row ──────────────────────────────────────────────────
    // FIX: this used to be drawn with doc.text(..., { lineBreak: false })
    // and NO width bound at all — a long phone/email/location, or simply
    // enough fields together (now including LinkedIn), could run straight
    // past the header's right edge with nothing to catch it. Now built on
    // flowItems() (the same flex-wrap-style helper SKILLS uses elsewhere
    // in this file): items sit side by side at their natural width and
    // wrap onto a new row — within the header's own available width —
    // the moment the next one wouldn't fit, instead of overflowing.
    // LinkedIn is appended after location; any field the user didn't
    // provide is simply absent via .filter(Boolean), same as before.
    const rowY = DIVIDER_Y + 12;
    const contacts = [content.contact?.phone, content.contact?.email, content.contact?.location, content.contact?.linkedin].filter(Boolean);
    if (contacts.length) {
      flowItems(doc, contacts, hx, rowY - 8, headerAvailW, {
        font: 'Helvetica', size: 8.5, color: WHITE,
        gapX: 16, gapY: 13,
        bulletColor: COPPER, bulletSize: 3, bulletGap: 6,
        draw: true
      });
    }

    doc.fillColor(WHITE).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 5).fill();
    doc.strokeColor(COPPER).lineWidth(3).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 5).stroke();
    doc.strokeColor(NAVY).lineWidth(1.5).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 9).stroke();
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(PHOTO_CX, PHOTO_CY, PHOTO_R).clip();
        doc.image(buf, PHOTO_CX - PHOTO_R, PHOTO_CY - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('copper-diagonal photo error:', e.message); }
    } else {
      doc.fillColor('#D5D9E0').circle(PHOTO_CX, PHOTO_CY, PHOTO_R).fill();
    }
  }

  function lsection(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(WHITE);
      doc.text(label, L_PAD, yTop + 1, { lineBreak: false });
      doc.strokeColor(COPPER).lineWidth(1.2).moveTo(L_PAD, yTop + 13).lineTo(SIDEBAR_W - L_PAD, yTop + 13).stroke();
    }
    return yTop + 22;
  }
  function lbold(text, yTop, opts = {}) {
    const size = opts.size || 9;
    const lines = wrapLines(doc, text, 'Helvetica-Bold', size, SIDEBAR_W - L_PAD * 2);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(WHITE);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD, cur, { lineBreak: false }); cur += size * 1.4; });
    }
    return yTop + lines.length * size * 1.4;
  }
  function lnorm(text, yTop, opts = {}) {
    const size = opts.size || 8.5, indent = opts.indent || 0;
    const lines = wrapLines(doc, text, 'Helvetica', size, SIDEBAR_W - L_PAD * 2 - indent);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(COPPER_LT);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD + indent, cur, { lineBreak: false }); cur += size * 1.4; });
    }
    return yTop + lines.length * size * 1.4;
  }
  // Bulleted list in the sidebar — same dash-bullet-plus-wrapped-text shape
  // as SKILLS — used for any custom sidebar section given as a list rather
  // than a paragraph. Every line goes through wrapLines against the real
  // sidebar width, so it can't overflow the sidebar any more than SKILLS.
  function lbullets(items, yTop, opts = {}) {
    const size = opts.size || 8.5;
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, SIDEBAR_W - L_PAD * 2 - 12);
      if (draw) {
        doc.fillColor(COPPER).rect(L_PAD, cur + 5.5, 5, 2).fill();
        doc.font('Helvetica').fontSize(size).fillColor(WHITE);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, L_PAD + 12, ly, { lineBreak: false }); ly += size * 1.45; });
        cur = ly;
      } else {
        cur += lines.length * size * 1.45;
      }
      cur += 2;
      total += lines.length;
    });
    return { y: cur, lines: total };
  }

  let y = HEADER_H + 16;
  y = lsection('EDUCATION', y) + 2;
  const eduList = normalizeEducation(content.education);
  eduList.slice(0, 2).forEach(edu => {
    if (draw) { doc.font('Helvetica-Bold').fontSize(8).fillColor(COPPER); doc.text(edu.dateRange || '', L_PAD, y + 7, { lineBreak: false }); }
    y += 12;
    y = lbold((edu.school || '').toUpperCase(), y);
    if (edu.degree) y = lnorm(edu.degree, y, { indent: 6 });
    if (edu.extra) y = lnorm(edu.extra, y, { indent: 6 });
    y += 9;
  });
  y += 3;

  // Skills: one-per-line by default (the template's normal look). Only
  // when compactSkills is true — which measure() sets ONLY after the
  // normal layout has already been found to overflow the page — do
  // skills switch to flowing side-by-side rows (flex-wrap style) to
  // recover vertical space. This is a last-resort space-saving step the
  // renderer takes automatically, tried BEFORE ever asking the user to
  // cut real content; it never changes the layout when everything
  // already fits normally.
  y = lsection('SKILLS', y) + 4;
  if (compactSkills) {
    const skillsResult = flowItems(doc, content.skills || [], L_PAD + 8, y, SIDEBAR_W - L_PAD * 2 - 8, {
      font: 'Helvetica', size: 8.8, color: WHITE,
      gapX: 10, gapY: 13,
      bulletColor: COPPER, bulletSize: 4, bulletGap: 6,
      draw
    });
    y = skillsResult.y;
    track('skills', skillsResult.lines, (content.skills || []).length > 0);
  } else {
    let skillLines = 0;
    (content.skills || []).forEach(sk => {
      const lines = wrapLines(doc, sk, 'Helvetica', 8.8, SIDEBAR_W - L_PAD * 2 - 12);
      if (draw) {
        doc.fillColor(COPPER).rect(L_PAD, y + 5.5, 5, 2).fill();
        doc.font('Helvetica').fontSize(8.8).fillColor(WHITE);
        let cur = y;
        lines.forEach(ln => { doc.text(ln, L_PAD + 12, cur, { lineBreak: false }); cur += 12.5; });
        y = cur;
      } else { y += lines.length * 12.5; }
      y += 2;
      skillLines += lines.length;
    });
    track('skills', skillLines, (content.skills || []).length > 0);
  }
  y += 4 + stretchPerGap;

  // Languages: bars are keyed off each language's OWN proficiency label
  // (via proficiencyToFill), never off array position. This also already
  // flexes to any number of languages — no hardcoded cap, no slice(0, N).
  y = lsection('LANGUAGES', y) + 4;
  (content.languages || []).forEach((l) => {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
      doc.text(l.name, L_PAD, y + 7.5, { lineBreak: false });
      const lw = doc.widthOfString(l.name);
      doc.font('Helvetica').fontSize(8).fillColor(COPPER_LT);
      doc.text(`(${l.level})`, L_PAD + lw + 4, y + 7, { lineBreak: false });
    }
    y += 13;
    const fillPct = proficiencyToFill(l.level);
    if (draw) {
      const bw = SIDEBAR_W - L_PAD * 2;
      doc.roundedRect(L_PAD, y + 4.5, bw, 5, 2.5).fill('#293D67');
      doc.roundedRect(L_PAD, y + 4.5, bw * fillPct, 5, 2.5).fill(COPPER);
    }
    y += 14;
  });
  y += 6;

  // ── Custom sidebar sections ──────────────────────────────────────────
  (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar').forEach(cs => {
    y = lsection((cs.title || 'Section').toUpperCase(), y) + 4;
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = lbullets(cs.items, y);
      y = r.y;
      linesUsed = r.lines;
    } else if (cs.text) {
      const before = y;
      y = lnorm(cs.text, y);
      linesUsed = Math.round((y - before) / (8.5 * 1.4)) || 1;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += 6 + stretchPerGap;
  });

  function rsection(label, yTop) {
    if (draw) {
      doc.fillColor(COPPER).rect(R_START - 10, yTop, 4, 15).fill();
      doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY);
      doc.text(label, R_START, yTop, { lineBreak: false });
      doc.strokeColor(COPPER).lineWidth(1.2).moveTo(R_START, yTop + 14).lineTo(R_END, yTop + 14).stroke();
    }
    return yTop + 24;
  }
  function rpara(text, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 14.5, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, RIGHT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, R_START, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function rbullets(items, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 13.5, size);
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, item, 'Helvetica', size, RIGHT_W - 14);
      if (draw) {
        doc.save();
        doc.translate(R_START + 3, cur + size * 0.4);
        doc.rotate(45);
        doc.rect(-2, -2, 4, 4).fill(COPPER);
        doc.restore();
        doc.font('Helvetica').fontSize(size).fillColor(BODY);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, R_START + 14, ly, { lineBreak: false }); ly += leading; });
      }
      cur += lines.length * leading + (tightLeading ? 1.5 : 3.5);
      total += lines.length;
    });
    return { y: cur, lines: total };
  }

  let ry = HEADER_H + 18;
  const GS = stretchPerGap;

  if (content.profile) {
    ry = rsection('PROFILE', ry);
    const r = rpara(content.profile, ry);
    track('profile', r.lines, true);
    ry = r.y + tightenGap(12) + GS;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    ry = rsection('EXPERIENCE', ry);
    let linesUsed = 0;
    content.experience.forEach(exp => {
      if (draw) {
        doc.fillColor(COPPER).circle(R_START - 3, ry + 9, 4.5).fill();
      }
      // FIX: previously drawn org/date with no width limit at all — a
      // long org name could run straight into the date text. Now uses
      // expTitleDateRow(): wraps the title onto extra lines (never
      // truncates) and drops the date onto its own line if it doesn't
      // fit alongside the title.
      const headerR = expTitleDateRow(doc, { org: exp.org, date: exp.dateRange }, R_START + 8, ry + 1, RIGHT_W - 8, {
        titleFont: 'Helvetica-Bold', titleSize: 10.5, titleColor: NAVY,
        dateFont: 'Helvetica-Oblique', dateSize: 8.5, dateColor: MID,
        lineH: 13, gap: 10, draw
      });
      ry = headerR.y;
      if (draw) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(COPPER); doc.text(exp.role || '', R_START + 8, ry, { lineBreak: false }); }
      ry += 13;
      const r2 = rbullets(exp.bullets || [], ry);
      linesUsed += 1 + headerR.lines + r2.lines;
      ry = r2.y;
    });
    track('experience', linesUsed, true);
    ry += tightenGap(12) + GS;
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    ry = rsection('ACHIEVEMENT', ry);
    const r3 = rbullets(content.achievements, ry);
    track('achievements', r3.lines, true);
    ry = r3.y + tightenGap(12) + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    ry = rsection('CERTIFICATIONS & RECOGNITION', ry);
    let linesUsed = 0;
    content.certifications.forEach((cert, i) => {
      const full = `${cert.title} | ${cert.issuer}`;
      const certLeading = tighten(13.5, 9.5);
      const lines = wrapLines(doc, full, 'Helvetica', 9.5, RIGHT_W - 16);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COPPER);
        doc.text(`${i + 1}.`, R_START, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        let ly = ry;
        lines.forEach(ln => { doc.text(ln, R_START + 16, ly, { lineBreak: false }); ly += certLeading; });
        ry = ly;
      } else { ry += lines.length * certLeading; }
      linesUsed += lines.length;
      ry += tightLeading ? 2 : 5;
    });
    track('certifications', linesUsed, true);
    ry += tightenGap(8) + GS;
  } else track('certifications', 0, false);

  // ── Custom main-column sections ──────────────────────────────────────
  (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar').forEach(cs => {
    ry = rsection((cs.title || 'Section').toUpperCase(), ry);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r4 = rbullets(cs.items, ry);
      ry = r4.y;
      linesUsed = r4.lines;
    } else if (cs.text) {
      const r4 = rpara(cs.text, ry);
      ry = r4.y;
      linesUsed = r4.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    ry += tightenGap(12) + GS;
  });

  // References: content.references is now an array (1, 2, 3+ — no cap).
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = rsection('REFERENCE' + (refList.length > 1 ? 'S' : ''), ry);
    const gap = 8;
    const boxW = (RIGHT_W - gap * (refList.length - 1)) / refList.length;
    const PAD = 8;
    const NAME_SIZE = 10.5, ROLE_SIZE = 9, FIELD_SIZE = 8.5;
    const NAME_LH = NAME_SIZE * 1.3, ROLE_LH = ROLE_SIZE * 1.35, FIELD_LH = 13;
    const EMAIL_OFFSET_X = 34, PHONE_OFFSET_X = 36;

    function wrapField(value, offsetX) {
      if (!value) return [];
      return wrapLines(doc, String(value), 'Helvetica', FIELD_SIZE, boxW - PAD - offsetX);
    }

    const refBlocks = refList.map(ref => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', NAME_SIZE, boxW - PAD).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Helvetica', ROLE_SIZE, boxW - PAD).slice(0, 4) : [];
      const emailLines = wrapField(ref.email, EMAIL_OFFSET_X);
      const phoneLines = wrapField(ref.phone, PHONE_OFFSET_X);
      let h = 4 + nameLines.length * NAME_LH + 2;
      if (roleLines.length) h += roleLines.length * ROLE_LH + 4;
      h += emailLines.length * FIELD_LH;
      h += phoneLines.length * FIELD_LH;
      return { ref, nameLines, roleLines, emailLines, phoneLines, h: Math.max(h, 52) };
    });
    const rowH = Math.max(...refBlocks.map(b => b.h));

    refBlocks.forEach((block, i) => {
      const { nameLines, roleLines, emailLines, phoneLines, h } = block;
      const bx = R_START + i * (boxW + gap);
      if (draw) {
        doc.roundedRect(bx - 6, ry - 4, boxW + 6, h, 4).fill(COPPER_LT);
        doc.roundedRect(bx - 6, ry - 4, boxW + 6, h, 4).lineWidth(0.8).stroke(COPPER);

        let cy = ry + 1;
        doc.font('Helvetica-Bold').fontSize(NAME_SIZE).fillColor(NAVY);
        nameLines.forEach(ln => { doc.text(ln, bx + 4, cy, { lineBreak: false }); cy += NAME_LH; });
        cy += 2;

        if (roleLines.length) {
          doc.font('Helvetica').fontSize(ROLE_SIZE).fillColor(BODY);
          roleLines.forEach(ln => { doc.text(ln, bx + 4, cy, { lineBreak: false }); cy += ROLE_LH; });
          cy += 4;
        }

        if (emailLines.length) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(NAVY);
          doc.text('Email:', bx + 4, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          emailLines.forEach((ln) => {
            doc.text(ln, bx + EMAIL_OFFSET_X, cy, { lineBreak: false });
            cy += FIELD_LH;
          });
        }
        if (phoneLines.length) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(NAVY);
          doc.text('Phone:', bx + 4, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          phoneLines.forEach((ln) => {
            doc.text(ln, bx + PHONE_OFFSET_X, cy, { lineBreak: false });
            cy += FIELD_LH;
          });
        }
      }
    });

    const linesUsed = refBlocks.reduce((sum, b) =>
      sum + b.nameLines.length + b.roleLines.length + b.emailLines.length + b.phoneLines.length, 0);
    track('references', linesUsed, true);
    ry += rowH;
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
    sections: last.sections, appliedLevel: last.level,
    hardOverflow,
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