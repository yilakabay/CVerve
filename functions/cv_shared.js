// functions/lib/cv-shared.js
//
// Small helpers shared by every CV template module (cv-template-*.js), so
// each one doesn't have to redefine the same wrap/measure boilerplate.

const PDFDocument = require('pdfkit');

function measureDoc() {
  return new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
}

function wrapLines(doc, text, font, size, maxWidth) {
  doc.font(font).fontSize(size);
  const words = String(text || '').split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = (cur + ' ' + w).trim();
    if (doc.widthOfString(trial) <= maxWidth || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Accepts education as EITHER the old single-object shape
// { degree, school, extra } OR the array shape
// [{ level, dateRange, school, degree, extra }, ...]. Always returns an
// array — index 0 is treated as "higher education", index 1 as
// "secondary", etc., matching the two-tier layout these templates use.
function normalizeEducation(education) {
  if (!education) return [];
  if (Array.isArray(education)) return education;
  return [education];
}

module.exports = { PDFDocument, measureDoc, wrapLines, normalizeEducation };