// functions/lib/cv-template-copper-diagonal.js
//
// "Diagonal Navy & Copper" CV template — ported from the original
// ReportLab design: a full-height navy sidebar, a slate header band with a
// diagonal navy accent cut into it, a circular photo with copper/navy
// double ring, and a timeline-styled experience section on the right.
// Same measure()/render() contract as every other template.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const NAVY = '#141F45', COPPER = '#BF6125', COPPER_LT = '#F5E1C7';
const SLATE = '#243359', BODY = '#333B4D', MID = '#80878F', WHITE = '#FFFFFF', OFF_WHITE = '#F7F7F9';

const SIDEBAR_W = 195.0, HEADER_H = 158.0, PHOTO_R = 52.0;
const PHOTO_CX = SIDEBAR_W / 2, PHOTO_CY = HEADER_H / 2 + 6;
const L_PAD = 18.0, R_START = SIDEBAR_W + 18.0, R_END = PAGE_W - 18.0, RIGHT_W = R_END - R_START;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function layout(doc, content, { draw, stretchPerGap = 0, compactSkills = false } = {}) {
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
    doc.font('Helvetica-Bold').fontSize(30).fillColor(WHITE);
    doc.text((content.name || '').toUpperCase(), hx, 26, { lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(COPPER_LT);
    doc.text((content.subtitle || '').toUpperCase(), hx, 62, { lineBreak: false });
    doc.strokeColor(COPPER).lineWidth(0.8).moveTo(hx, 78).lineTo(R_END, 78).stroke();

    // Contact row: any missing field (phone/email/location) is simply
    // absent from content.contact, so .filter(Boolean) already drops it
    // and no orphan label/icon is drawn for it. Nothing else to do here —
    // this already flexes to however many of the 3 the user actually has.
    let cx = hx, rowY = 90;
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
    const size = opts.size || 9.5, leading = opts.leading || 14.5;
    const lines = wrapLines(doc, text, 'Helvetica', size, RIGHT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, R_START, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function rbullets(items, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = opts.leading || 13.5;
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
      cur += lines.length * leading + 3.5;
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
    ry = r.y + 12 + GS;
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
    ry += 12 + GS;
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    ry = rsection('ACHIEVEMENT', ry);
    const r3 = rbullets(content.achievements, ry);
    track('achievements', r3.lines, true);
    ry = r3.y + 12 + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    ry = rsection('CERTIFICATIONS & RECOGNITION', ry);
    let linesUsed = 0;
    content.certifications.forEach((cert, i) => {
      const full = `${cert.title} | ${cert.issuer}`;
      const lines = wrapLines(doc, full, 'Helvetica', 9.5, RIGHT_W - 16);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COPPER);
        doc.text(`${i + 1}.`, R_START, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        let ly = ry;
        lines.forEach(ln => { doc.text(ln, R_START + 16, ly, { lineBreak: false }); ly += 13.5; });
        ry = ly;
      } else { ry += lines.length * 13.5; }
      linesUsed += lines.length;
      ry += 5;
    });
    track('certifications', linesUsed, true);
    ry += 8 + GS;
  } else track('certifications', 0, false);

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
    const boxH = 60;
    refList.forEach((ref, i) => {
      const bx = R_START + i * (boxW + gap);
      if (draw) {
        doc.roundedRect(bx - 6, ry - 4, boxW + 6, boxH, 4).fill(COPPER_LT);
        doc.roundedRect(bx - 6, ry - 4, boxW + 6, boxH, 4).lineWidth(0.8).stroke(COPPER);
        const nameLines = wrapLines(doc, ref.name, 'Helvetica-Bold', 10.5, boxW - 8);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
        doc.text(nameLines[0] || '', bx + 4, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(BODY);
        doc.text(ref.role || '', bx + 4, ry + 15, { lineBreak: false, width: boxW - 8, ellipsis: true });
        if (ref.email) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
          doc.text('Email:', bx + 4, ry + 29, { lineBreak: false });
          doc.font('Helvetica').fontSize(8.5).fillColor(BODY);
          doc.text(ref.email, bx + 34, ry + 29, { lineBreak: false, width: boxW - 38, ellipsis: true });
        }
        if (ref.phone) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
          doc.text('Phone:', bx + 4, ry + 42, { lineBreak: false });
          doc.font('Helvetica').fontSize(8.5).fillColor(BODY);
          doc.text(ref.phone, bx + 36, ry + 42, { lineBreak: false });
        }
      }
    });
    track('references', 4, true);
    ry += boxH;
  } else track('references', 0, false);

  return { finalY: Math.max(y, ry), sections };
}

function measure(content) {
  // Pass 1: normal layout (one skill per line — the template's default
  // look). If this already fits, use it as-is; compaction is never
  // applied just because it's available.
  const doc1 = measureDoc();
  const normal = layout(doc1, content, { draw: false, compactSkills: false });
  const available = AVAILABLE_BOTTOM;

  if (normal.finalY <= available) {
    return {
      fits: true, finalY: normal.finalY, availableHeight: available,
      overflowPoints: 0, overflowLines: 0,
      underflowPoints: Math.round(available - normal.finalY), underflowLines: Math.round((available - normal.finalY) / 13.5),
      sections: normal.sections,
      compactionApplied: false
    };
  }

  // Pass 2: normal layout overflowed. Before asking the user to cut any
  // content, automatically retry with skills packed into flowing rows
  // (compactSkills: true) to recover vertical space. This is a rendering
  // technique, not a content change — nothing the user wrote is altered
  // or removed.
  const doc2 = measureDoc();
  const compact = layout(doc2, content, { draw: false, compactSkills: true });
  const overflowPt = Math.max(0, compact.finalY - available);
  const underflowPt = Math.max(0, available - compact.finalY);

  return {
    fits: overflowPt === 0, finalY: compact.finalY, availableHeight: available,
    overflowPoints: Math.round(overflowPt), overflowLines: Math.round(overflowPt / 13.5),
    underflowPoints: Math.round(underflowPt), underflowLines: Math.round(underflowPt / 13.5),
    sections: compact.sections,
    // Tells the caller (cv-chat.js / the AI) that a space-saving layout
    // change was already applied automatically. If fits is now true, the
    // AI should tell the user their content fit WITHOUT needing to cut
    // anything. If fits is still false, real trimming is genuinely needed
    // even after this automatic recovery step.
    compactionApplied: true
  };
}

function render(content) {
  const m = measure(content);
  const presentSections = m.sections.filter(s => s.present).length;
  const numGaps = Math.max(1, presentSections);
  const stretchPerGap = (!m.fits || presentSections === 0) ? 0 : m.underflowPoints / numGaps;

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  // compactSkills must match whatever measure() actually decided (m.compactionApplied),
  // never re-derived independently — otherwise the drawn PDF could disagree
  // with the fit numbers the AI already showed the user.
  layout(doc, content, { draw: true, stretchPerGap, compactSkills: m.compactionApplied });
  doc.end();
  return done;
}

module.exports = { measure, render, PAGE_W, PAGE_H };