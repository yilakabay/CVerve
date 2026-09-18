// functions/lib/cv-template-gold-header.js
//
// "Corporate Minimal Gold" CV template — ported from the original ReportLab
// design: a full-width charcoal header band with a square photo top-right,
// gold accent throughout, and a two-column body (narrow date/label column,
// wide content column). Same measure()/render() contract as every other
// template — see cv-template-minimal.js for the full explanation.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation } = require('./cv-shared');

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

function layout(doc, content, { draw, stretchPerGap = 0 } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

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

    doc.font('Helvetica-Bold').fontSize(36).fillColor(WHITE);
    doc.text((content.name || '').split(' ')[0] || '', 18, 18, { lineBreak: false });
    doc.fillColor(GOLD_LITE);
    doc.text((content.name || '').split(' ').slice(1).join(' ') || '', 18, 58, { lineBreak: false });
    doc.strokeColor(GOLD).lineWidth(1).moveTo(18, 112).lineTo(PHOTO_X - 18, 112).stroke();
    doc.font('Helvetica').fontSize(9.5).fillColor(GOLD_LITE);
    doc.text((content.subtitle || '').toUpperCase(), 18, 126, { lineBreak: false });

    doc.font('Helvetica').fontSize(10);
    const contacts = [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean);
    contacts.forEach((ct, i) => {
      const cy = 144 + i * 15.5;
      doc.fillColor(GOLD).circle(21, cy + 3.5, 1.8).fill();
      doc.fillColor(WHITE).text(ct, 30, cy, { lineBreak: false });
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
  function dateLabel(text, yTop) {
    if (!draw || !text) return;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
    const tw = doc.widthOfString(text);
    doc.text(text, MARGIN_L + LABEL_W - tw, yTop, { lineBreak: false });
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
    const size = opts.size || 9.2, leading = opts.leading || 13.5;
    const lines = wrapLines(doc, text, 'Helvetica', size, CONTENT_W - (opts.indent || 0));
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, CONTENT_X + (opts.indent || 0), cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function bullet(text, yTop, opts = {}) {
    const size = opts.size || 9.2, leading = opts.leading || 13.0;
    const lines = wrapLines(doc, text, 'Helvetica', size, CONTENT_W - 10);
    if (draw) {
      doc.fillColor(GOLD).circle(CONTENT_X + 3.5, yTop - 2.5, 1.8).fill();
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, CONTENT_X + 10, cur, { lineBreak: false }); cur += leading; });
      return cur + 1.5;
    }
    return yTop + lines.length * leading + 1.5;
  }

  let y = BODY_TOP;
  const GS = stretchPerGap;

  if (content.profile) {
    y = section('PROFILE', y);
    const r = para(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + 10 + GS;
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
    y += 8 + GS;
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
      y += 6;
      linesUsed += 2;
    });
    track('education', linesUsed, true);
    y += 4 + GS;
  } else track('education', 0, false);

  if (content.achievements && content.achievements.length) {
    y = section('ACHIEVEMENTS', y);
    let linesUsed = 0;
    content.achievements.forEach(a => { y = bullet(a, y); linesUsed++; });
    track('achievements', linesUsed, true);
    y += 10 + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    y = section('CERTIFICATIONS', y);
    let linesUsed = 0;
    content.certifications.forEach((cert, i) => {
      dateLabel(String(i + 1).padStart(2, '0'), y + 2);
      if (draw) { doc.font('Helvetica-Bold').fontSize(9.2).fillColor(BODY); doc.text(cert.title || '', CONTENT_X, y, { lineBreak: false }); }
      y += 12;
      const issuerLines = wrapLines(doc, cert.issuer || '', 'Helvetica', 8.5, CONTENT_W);
      if (draw) { doc.font('Helvetica').fontSize(8.5).fillColor(MUTED); doc.text(cert.issuer || '', CONTENT_X, y, { lineBreak: false }); }
      y += 15;
      linesUsed += 1 + issuerLines.length;
    });
    track('certifications', linesUsed, true);
    y += 4 + GS;
  } else track('certifications', 0, false);

  if (content.skills && content.skills.length) {
    y = section('SKILLS', y);
    const colCount = 3, colW = CONTENT_W / colCount;
    let linesUsed = 0;
    content.skills.forEach((skill, i) => {
      const row = Math.floor(i / colCount), col = i % colCount;
      const sy = y + row * 13;
      if (draw) {
        doc.fillColor(GOLD).rect(CONTENT_X + col * colW, sy + 1, 3, 3).fill();
        doc.font('Helvetica').fontSize(8.8).fillColor(BODY);
        doc.text(skill, CONTENT_X + col * colW + 7, sy, { lineBreak: false });
      }
      if (col === 0) linesUsed++;
    });
    y += Math.ceil(content.skills.length / colCount) * 13 + 4 + GS;
    track('skills', linesUsed, true);
  } else track('skills', 0, false);

  if (content.languages && content.languages.length) {
    y = section('LANGUAGES', y);
    content.languages.forEach(l => {
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.2).fillColor(BODY);
        doc.text(l.name, CONTENT_X, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(8.8).fillColor(MUTED);
        doc.text(l.level, CONTENT_X + 70, y, { lineBreak: false });
      }
      y += 15;
    });
    track('languages', content.languages.length, true);
    y += 4 + GS;
  } else track('languages', 0, false);

  if (content.reference && content.reference.name) {
    y = section('REFERENCE', y);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BODY);
      doc.text(content.reference.name, CONTENT_X, y, { lineBreak: false });
      y += 13;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      doc.text(content.reference.role || '', CONTENT_X, y, { lineBreak: false });
      y += 13;
      [['Email', content.reference.email], ['Phone', content.reference.phone]].forEach(([label, val]) => {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
        doc.text(label + ':', CONTENT_X, y, { lineBreak: false });
        const lw = doc.widthOfString(label + ':  ');
        doc.font('Helvetica').fontSize(8.5).fillColor(BODY);
        doc.text(val || '', CONTENT_X + lw, y, { lineBreak: false });
        y += 13;
      });
    } else {
      y += 39;
    }
    track('reference', 4, true);
  } else track('reference', 0, false);

  return { finalY: y, sections };
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