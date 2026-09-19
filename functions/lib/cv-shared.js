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

// Accepts reference as EITHER the old single-object shape
// { name, role, email, phone } OR the array shape
// [{ name, role, email, phone }, ...]. Always returns an array, so
// templates with a "reference box" can loop over however many the user
// actually gave (1, 2, 3...) instead of assuming there's only ever one.
// Empty/incomplete entries (no name) are dropped.
function normalizeReferences(reference) {
  let list;
  if (!reference) list = [];
  else if (Array.isArray(reference)) list = reference;
  else list = [reference];
  return list.filter(r => r && r.name);
}

// Maps a free-text proficiency label (as the model/user would naturally
// write it) to a 0..1 bar-fill fraction. This is what language-skill bars
// should key off of — NEVER off array position. Unrecognized labels fall
// back to a mid-level fill (0.6) rather than guessing full or empty, so a
// weird/unexpected label doesn't silently render as "native" or "none".
const PROFICIENCY_FILL = [
  { fill: 1.00, keywords: ['native', 'mother tongue', 'bilingual', 'c2'] },
  { fill: 0.85, keywords: ['fluent', 'proficient', 'advanced', 'c1'] },
  { fill: 0.65, keywords: ['upper intermediate', 'good', 'b2'] },
  { fill: 0.50, keywords: ['intermediate', 'conversational', 'b1'] },
  { fill: 0.30, keywords: ['basic', 'elementary', 'beginner', 'a2', 'a1'] }
];
const DEFAULT_PROFICIENCY_FILL = 0.6;

function proficiencyToFill(level) {
  const norm = String(level || '').trim().toLowerCase();
  if (!norm) return DEFAULT_PROFICIENCY_FILL;
  for (const entry of PROFICIENCY_FILL) {
    if (entry.keywords.some(kw => norm.includes(kw))) return entry.fill;
  }
  return DEFAULT_PROFICIENCY_FILL;
}

module.exports = {
  PDFDocument, measureDoc, wrapLines,
  normalizeEducation, normalizeReferences,
  proficiencyToFill
};