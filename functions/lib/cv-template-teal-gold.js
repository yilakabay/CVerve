// functions/lib/cv-template-teal-gold.js
//
// "Teal & Gold" CV template — ported from the original ReportLab design: a
// full-width teal header with circular photo, a dark-teal left sidebar
// below it (education, skills, languages), and a wide right content
// column. Same measure()/render() contract as every other template.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const TEAL = '#173F52', GOLD = '#BC9138', GOLD_LIGHT = '#F0E1AD';
const SIDEBAR_BG = '#1C4F66', PALE_BG = '#F3F6F9';
const BODY = '#2E383D', MID = '#737F8C', WHITE = '#FFFFFF';

const HEADER_H = 152.0, LEFT_W = 190.0, L_PAD = 20.0, R_PAD = 20.0;
const R_LEFT = LEFT_W + R_PAD + 2, R_RIGHT = PAGE_W - 20.0, RIGHT_W = R_RIGHT - R_LEFT;
const PHOTO_R = 50.0, PHOTO_CX = LEFT_W / 2, PHOTO_CY = HEADER_H / 2;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function layout(doc, content, { draw, stretchPerGap = 0 } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(PALE_BG);
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(TEAL);
    doc.rect(0, HEADER_H, LEFT_W, PAGE_H - HEADER_H).fill(SIDEBAR_BG);
    doc.rect(0, HEADER_H, PAGE_W, 3.5).fill(GOLD);
    doc.rect(LEFT_W, 0, 2.5, HEADER_H).fill(GOLD);
    doc.rect(LEFT_W + 18, 10, 3, 106).fill(GOLD);

    const nameX = LEFT_W + 30;
    doc.font('Helvetica-Bold').fontSize(28).fillColor(WHITE);
    doc.text(content.name || '', nameX, 30, { lineBreak: false });
    doc.font('Helvetica').fontSize(10.5).fillColor(GOLD);
    doc.text((content.subtitle || '').split('').join(' ').toUpperCase(), nameX, 51, { lineBreak: false });
    doc.strokeColor(GOLD).lineWidth(0.7).moveTo(nameX, 62).lineTo(PAGE_W - 18, 62).stroke();

    let ix = nameX, rowY = 79;
    doc.font('Helvetica').fontSize(8.5);
    [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean).forEach(txt => {
      const tw = doc.widthOfString(txt);
      doc.fillColor(GOLD).circle(ix + 3, rowY - 3, 1.8).fill();
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

  y = lhead('SKILLS', y);
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
  y += 6 + stretchPerGap;

  y = lhead('LANGUAGES', y);
  (content.languages || []).forEach((l, i) => {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
      doc.text(l.name, L_PAD, y + 7.5, { lineBreak: false });
      const lw = doc.widthOfString(l.name);
      doc.font('Helvetica').fontSize(8).fillColor(GOLD_LIGHT);
      doc.text(`(${l.level})`, L_PAD + lw + 4, y + 7, { lineBreak: false });
    }
    y += 13;
    const fillPct = i === 0 ? 1.0 : 0.75;
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
    const size = opts.size || 9.5, leading = opts.leading || 14.0;
    const lines = wrapLines(doc, text, 'Helvetica', size, RIGHT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, R_LEFT, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function rbullets(items, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = opts.leading || 13.5;
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, item, 'Helvetica', size, RIGHT_W - 12);
      if (draw) {
        doc.fillColor(GOLD).rect(R_LEFT + 1, cur + size * 0.4, 3.5, 3.5).fill();
        doc.font('Helvetica').fontSize(size).fillColor(BODY);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, R_LEFT + 12, ly, { lineBreak: false }); ly += leading; });
      }
      cur += lines.length * leading + 3.5;
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
    ry = r.y + 10 + GS;
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
    ry += 10 + GS;
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    ry = rhead('ACHIEVEMENT', ry);
    const r3 = rbullets(content.achievements, ry);
    track('achievements', r3.lines, true);
    ry = r3.y + 10 + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    ry = rhead('CERTIFICATIONS & RECOGNITION', ry);
    let linesUsed = 0;
    content.certifications.forEach((cert, i) => {
      const full = `${cert.title} | ${cert.issuer}`;
      const lines = wrapLines(doc, full, 'Helvetica', 9.5, RIGHT_W - 14);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GOLD);
        doc.text(`${i + 1}.`, R_LEFT, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        let ly = ry;
        lines.forEach(ln => { doc.text(ln, R_LEFT + 14, ly, { lineBreak: false }); ly += 13.5; });
        ry = ly;
      } else { ry += lines.length * 13.5; }
      linesUsed += lines.length;
    });
    track('certifications', linesUsed, true);
    ry += 8 + GS;
  } else track('certifications', 0, false);

  if (content.reference && content.reference.name) {
    ry = rhead('REFERENCE', ry);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL);
      doc.text(content.reference.name, R_LEFT, ry + 1, { lineBreak: false });
      ry += 14;
      doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
      doc.text(content.reference.role || '', R_LEFT, ry, { lineBreak: false });
      ry += 14;
      [['Email', content.reference.email], ['Phone', content.reference.phone]].forEach(([label, val]) => {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEAL);
        doc.text(label + ':', R_LEFT, ry, { lineBreak: false });
        const lw = doc.widthOfString(label + ': ');
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        doc.text(val || '', R_LEFT + lw, ry, { lineBreak: false });
        ry += 13;
      });
    } else { ry += 40; }
    track('reference', 4, true);
  } else track('reference', 0, false);

  return { finalY: Math.max(y, ry), sections };
}

function measure(content) {
  const doc = measureDoc();
  const { finalY, sections } = layout(doc, content, { draw: false });
  const available = AVAILABLE_BOTTOM;
  const overflowPt = Math.max(0, finalY - available);
  const underflowPt = Math.max(0, available - finalY);
  return {
    fits: overflowPt === 0, finalY, availableHeight: available,
    overflowPoints: Math.round(overflowPt), overflowLines: Math.round(overflowPt / 13.5),
    underflowPoints: Math.round(underflowPt), underflowLines: Math.round(underflowPt / 13.5),
    sections
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
  layout(doc, content, { draw: true, stretchPerGap });
  doc.end();
  return done;
}

module.exports = { measure, render, PAGE_W, PAGE_H };