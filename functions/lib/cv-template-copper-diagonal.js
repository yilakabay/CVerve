// functions/lib/cv-template-copper-diagonal.js
//
// "Diagonal Navy & Copper" CV template — ported from the original
// ReportLab design: a full-height navy sidebar, a slate header band with a
// diagonal navy accent cut into it, a circular photo with copper/navy
// double ring, and a timeline-styled experience section on the right.
// Same measure()/render() contract as every other template.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

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
    // This used to be drawn with lineBreak:false and no width at all, so
    // a long name simply ran past the header's right edge. Now it first
    // tries a size ladder (30 → 26 → 22 → 20) to fit on one line — a
    // slightly smaller single line reads better than an early wrap — and
    // only wraps onto a second line, capped at 2, if even the smallest
    // size can't fit it on one. Everything below (subtitle, divider,
    // contact row) is then positioned off the ACTUAL measured bottom of
    // whatever was drawn, so a 2-line name can never leave later elements
    // overlapping it — same fix already applied to the teal-gold template.
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
      doc.text(ln, hx, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
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
        doc.text(ln, hx, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    const DIVIDER_Y = subtitleBottomY + 6;
    doc.strokeColor(COPPER).lineWidth(0.8).moveTo(hx, DIVIDER_Y).lineTo(R_END, DIVIDER_Y).stroke();

    // Contact row: any missing field (phone/email/location) is simply
    // absent from content.contact, so .filter(Boolean) already drops it
    // and no orphan label/icon is drawn for it. Its row position (rowY)
    // now derives from DIVIDER_Y instead of a fixed constant, so it moves
    // down together with a wrapped name/subtitle rather than overlapping
    // them — and the dot and its text still share this one rowY value, so
    // they can never end up out of sync with each other either.
    const rowY = DIVIDER_Y + 12;
    let cx = hx;
    doc.font('Helvetica').fontSize(8.5);
    [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean).forEach(txt => {
      const tw = doc.widthOfString(txt);
      doc.fillColor(COPPER).rect(cx, rowY - 6, 3, 3).fill();
      doc.fillColor(WHITE).text(txt, cx + 8, rowY - 8, { lineBreak: false });
      cx += tw + 22;
    });

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
  // A user can ask the AI to add a section not in the fixed schema (e.g.
  // "Academic Projects", "Hobbies"). Entries in content.customSections
  // with placement:'sidebar' get their own heading + wrapped content here,
  // via the same lsection/lnorm/lbullets helpers (and therefore the same
  // width-safe wrapping) as every built-in sidebar section — so they
  // can't overflow the sidebar any more than SKILLS or LANGUAGES can.
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
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
        doc.text(exp.org || '', R_START + 8, ry + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MID);
        const dw = doc.widthOfString(exp.dateRange || '');
        doc.text(exp.dateRange || '', R_END - dw, ry + 1, { lineBreak: false });
      }
      ry += 13;
      if (draw) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(COPPER); doc.text(exp.role || '', R_START + 8, ry, { lineBreak: false }); }
      ry += 13;
      const r2 = rbullets(exp.bullets || [], ry);
      linesUsed += 2 + r2.lines;
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
  // Same idea as the sidebar version above, but for content that fits
  // better in the wide right column — a project with a real description,
  // multiple bullet points, etc. Every entry with placement !== 'sidebar'
  // (including no placement at all — main is the default) lands here,
  // via rsection/rpara/rbullets so it gets the same wrapping, leading and
  // tight-leading/compaction behavior as EXPERIENCE/ACHIEVEMENT, and the
  // same per-section line tracking so overflow detection and the fit
  // recommendation both already account for it automatically.
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
  // Boxes are laid out side by side and their own width divides evenly by
  // count, so 1 reference gets one full-width box, 3 references get three
  // narrower boxes on the same row, rather than assuming there's only
  // ever one. Falls back to the old singular content.reference shape via
  // normalizeReferences() so existing conversations/content don't break.
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = rsection('REFERENCE' + (refList.length > 1 ? 'S' : ''), ry);
    const gap = 8;
    const boxW = (RIGHT_W - gap * (refList.length - 1)) / refList.length;
    const PAD = 8;
    const NAME_SIZE = 10.5, ROLE_SIZE = 9, FIELD_SIZE = 8.5;
    const NAME_LH = NAME_SIZE * 1.3, ROLE_LH = ROLE_SIZE * 1.35, FIELD_LH = 13;

    // PDFKit's lineBreak:false + width + ellipsis combo (used below for
    // name/role's old single-line behavior) turned out to still wrap
    // rather than truncate once a width was supplied — that's what let a
    // long email run onto a second line and overlap Phone underneath it.
    // Doing the truncation ourselves, character by character against the
    // real measured width, and only ever drawing the already-safe result
    // with lineBreak:false, sidesteps that PDFKit quirk entirely: there is
    // no wrapping left for it to (mis)do.
    function truncateToWidth(text, font, size, maxWidth) {
      doc.font(font).fontSize(size);
      const str = String(text || '');
      if (doc.widthOfString(str) <= maxWidth) return str;
      const ELLIPSIS = '…';
      let lo = 0, hi = str.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (doc.widthOfString(str.slice(0, mid) + ELLIPSIS) <= maxWidth) lo = mid; else hi = mid - 1;
      }
      return str.slice(0, lo) + ELLIPSIS;
    }

    // Each reference box now measures its OWN real content height — a
    // long role no longer forces the shorter boxes next to it to stretch
    // to match; every box stops growing as soon as its own content fits.
    // Only the row's overall vertical footprint (rowH, used to advance ry
    // afterward so later content doesn't overlap the tallest box) still
    // needs the max — the boxes themselves are drawn at their own height.
    const refBlocks = refList.map(ref => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', NAME_SIZE, boxW - PAD).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Helvetica', ROLE_SIZE, boxW - PAD).slice(0, 3) : [];
      const emailText = ref.email ? truncateToWidth(ref.email, 'Helvetica', FIELD_SIZE, boxW - PAD - 30) : '';
      const phoneText = ref.phone ? truncateToWidth(ref.phone, 'Helvetica', FIELD_SIZE, boxW - PAD - 32) : '';
      let h = 4 + nameLines.length * NAME_LH + 2;
      if (roleLines.length) h += roleLines.length * ROLE_LH + 4;
      if (emailText) h += FIELD_LH;
      if (phoneText) h += FIELD_LH;
      return { ref, nameLines, roleLines, emailText, phoneText, h: Math.max(h, 52) };
    });
    const rowH = Math.max(...refBlocks.map(b => b.h));

    refBlocks.forEach((block, i) => {
      const { ref, nameLines, roleLines, emailText, phoneText, h } = block;
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

        if (emailText) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(NAVY);
          doc.text('Email:', bx + 4, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          doc.text(emailText, bx + 34, cy, { lineBreak: false });
          cy += FIELD_LH;
        }
        if (phoneText) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(NAVY);
          doc.text('Phone:', bx + 4, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          doc.text(phoneText, bx + 36, cy, { lineBreak: false });
          cy += FIELD_LH;
        }
      }
    });

    const linesUsed = refBlocks.reduce((sum, b) =>
      sum + b.nameLines.length + b.roleLines.length + (b.emailText ? 1 : 0) + (b.phoneText ? 1 : 0), 0);
    track('references', linesUsed, true);
    ry += rowH;
  } else track('references', 0, false);

  return { finalY: Math.max(y, ry), sections };
}

// Escalation ladder: each level is a slightly more space-saving rendering
// technique, tried in order, LEAST visually invasive first. A level is
// only ever used if every level before it has already failed to fit.
// Nothing here changes or removes any of the user's actual content —
// these are purely rendering-density choices.
const FIT_LEVELS = [
  { name: 'normal', opts: { compactSkills: false, tightLeading: false } },
  { name: 'compact-skills', opts: { compactSkills: true, tightLeading: false } },
  { name: 'compact-skills+tight-leading', opts: { compactSkills: true, tightLeading: true } }
];

// Beyond this many lines of overflow, even at maximum compaction, tightening
// further would start visually crowding or clipping text rather than
// legibly shrinking it — so the renderer stops and reports it as genuinely
// too much content, instead of silently degrading into a bad-looking PDF.
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

  // Every level failed — report the numbers from the MOST compact attempt
  // (the last one tried), since that's the closest the renderer can get.
  const overflowPt = last.finalY - available;
  const overflowLines = Math.round(overflowPt / 13.5);
  const hardOverflow = overflowLines > HARD_OVERFLOW_LINE_THRESHOLD;

  return {
    fits: false, finalY: last.finalY, availableHeight: available,
    overflowPoints: Math.round(overflowPt), overflowLines,
    underflowPoints: 0, underflowLines: 0,
    sections: last.sections, appliedLevel: last.level,
    hardOverflow,
    // A concrete, specific cut recommendation — never present just to pad
    // the response; only computed once we know trimming is genuinely
    // needed, so the AI has something confident to tell the user instead
    // of an open "what should I remove?" question.
    recommendation: buildFitRecommendation(last.sections, overflowLines)
  };
}

function render(content) {
  const m = measure(content);

  // Refuse to render rather than silently produce a PDF with clipped or
  // crowded text. The caller (cv-chat.js's callTool) already wraps this in
  // try/catch and surfaces the message as a tool failure, so the AI sees
  // exactly why and can give the user a specific, confident recommendation
  // instead of a broken file.
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
  // Always the SAME level measure() already decided on — render() never
  // re-derives this independently, so the drawn PDF can never disagree
  // with the fit numbers already shown to the user.
  layout(doc, content, { draw: true, stretchPerGap, ...level.opts });
  doc.end();
  return done;
}

module.exports = { measure, render, PAGE_W, PAGE_H };