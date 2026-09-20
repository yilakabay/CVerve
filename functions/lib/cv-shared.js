// functions/lib/cv-shared.js
//
// Small helpers shared by every CV template module (cv-template-*.js), so
// each one doesn't have to redefine the same wrap/measure boilerplate.

const PDFDocument = require('pdfkit');

function measureDoc() {
  return new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
}

// Wraps text to fit maxWidth, breaking between words as normal. If a
// SINGLE word is wider than maxWidth on its own (a long compound term, a
// URL, a skill with no spaces, etc.), it is additionally force-broken by
// character so it still fits — this is what guarantees text can never be
// drawn past the edge of its column, which the old word-only version
// could not do (a too-wide single word had no way to break and simply
// overflowed). Used by every template via cv-shared, so this fix applies
// everywhere at once.
function wrapLines(doc, text, font, size, maxWidth) {
  doc.font(font).fontSize(size);
  const rawWords = String(text || '').split(' ');

  // Pass 1: expand any word wider than maxWidth into character chunks that
  // each individually fit. Continuation chunks of the same broken word are
  // flagged so pass 2 joins them back together with no artificial space.
  const tokens = [];
  rawWords.forEach(w => {
    if (w.length === 0 || doc.widthOfString(w) <= maxWidth) {
      tokens.push({ text: w, continuation: false });
      return;
    }
    let chunk = '';
    let isFirstChunk = true;
    for (const ch of w) {
      const trial = chunk + ch;
      if (doc.widthOfString(trial) <= maxWidth || !chunk) {
        chunk = trial;
      } else {
        tokens.push({ text: chunk, continuation: !isFirstChunk });
        isFirstChunk = false;
        chunk = ch;
      }
    }
    if (chunk) tokens.push({ text: chunk, continuation: !isFirstChunk });
  });

  // Pass 2: normal greedy line-wrapping over the tokens.
  const lines = [];
  let cur = '';
  tokens.forEach(tok => {
    const joiner = (!cur || tok.continuation) ? '' : ' ';
    const trial = cur + joiner + tok.text;
    if (doc.widthOfString(trial) <= maxWidth || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = tok.text;
    }
  });
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

// ── Generic flowing / multi-column layout ────────────────────────────────
// Two reusable layout strategies any template's measure()/render() can call
// for ANY list of short items (skills, achievements, certifications, tags,
// etc) whenever fitting the page matters more than one-item-per-line. Both
// follow the same "returns the next y position" chaining pattern as every
// other section-drawing function in the template files, so they slot into
// an existing layout() function without changing how the rest of it works.
//
// Pick whichever suits the content:
//   flowItems()   — like flexbox "flex-wrap: wrap". Items sit side by side
//                   left-to-right at their NATURAL width, wrapping to a new
//                   row only when the next item wouldn't fit. Best for
//                   short, uneven-length items like skill tags, where
//                   packing 3-4 short ones next to a longer one uses the
//                   width much better than a fixed grid would.
//   columnItems() — a fixed N-column grid (like CSS "columns: N"), items
//                   flow down each column in a straight fixed-width grid.
//                   Best when a tidy aligned grid look matters more than
//                   maximum density (e.g. a skills grid users can scan).
//
// Both are pure measurement when draw=false (same convention as
// wrapLines/layout elsewhere) — call once with draw:false inside measure(),
// then again with draw:true inside render(), exactly like every other
// section helper in the cv-template-*.js files.

function flowItems(doc, items, x, yTop, totalWidth, opts = {}) {
  const {
    font = 'Helvetica', size = 8.8, color = '#FFFFFF',
    gapX = 14, gapY = 12.5,           // space after an item, and between rows
    bulletColor = null,               // if set, draws a small square bullet before each item
    bulletSize = 3, bulletGap = 6,
    draw = false
  } = opts;

  doc.font(font).fontSize(size);
  let cx = x, cy = yTop, rows = 1;
  const bulletW = bulletColor ? bulletSize + bulletGap : 0;
  // The width actually available for the text of an item once its bullet
  // (if any) is accounted for — this is what an oversized item gets
  // wrapped against below.
  const itemAvailW = Math.max(10, totalWidth - bulletW);

  (items || []).forEach((raw) => {
    const text = String(raw);
    const itemW = doc.widthOfString(text) + bulletW;
    const isFirstOnRow = cx === x;

    // Wrap to a new row if this item won't fit in the remaining width —
    // unless it's the very first item on the row (handled below).
    if (!isFirstOnRow && (cx - x) + itemW > totalWidth) {
      cx = x;
      cy += gapY;
      rows += 1;
    }

    // An item that's wider than the ENTIRE row (a long skill/tag with no
    // natural break point, e.g. "Financial Data Analysis and
    // Interpretation") used to just get drawn with lineBreak:false and no
    // width limit, so it ran straight past the edge of the column. Now it
    // gets wrapped onto its own multi-line block — using the same
    // word/char-fallback wrapping every other section of the CV uses —
    // and takes up as many rows as it needs, instead of overflowing.
    if (itemW > totalWidth) {
      const wlines = wrapLines(doc, text, font, size, itemAvailW);
      if (draw) {
        if (bulletColor) {
          doc.fillColor(bulletColor).rect(cx, cy + size * 0.55, bulletSize, bulletSize).fill();
        }
        doc.font(font).fontSize(size).fillColor(color);
        wlines.forEach((ln, i) => {
          doc.text(ln, cx + bulletW, cy + i * gapY, { lineBreak: false });
        });
      }
      cy += (wlines.length - 1) * gapY;
      rows += wlines.length - 1;
      // Force the next item onto a fresh row rather than trying to pack
      // something next to the tail end of a wrapped block.
      cx = x;
      cy += gapY;
      rows += 1;
      return;
    }

    if (draw) {
      if (bulletColor) {
        doc.fillColor(bulletColor).rect(cx, cy + size * 0.55, bulletSize, bulletSize).fill();
      }
      doc.font(font).fontSize(size).fillColor(color);
      doc.text(text, cx + bulletW, cy, { lineBreak: false });
    }

    cx += itemW + gapX;
  });

  return { y: cy + gapY, rows, lines: rows };
}

function columnItems(doc, items, x, yTop, totalWidth, opts = {}) {
  const {
    font = 'Helvetica', size = 8.8, color = '#FFFFFF',
    columns = 2, rowGap = 13,
    bulletColor = null, bulletSize = 3, bulletGap = 6,
    draw = false
  } = opts;

  const colW = totalWidth / columns;
  const rowCount = Math.ceil((items || []).length / columns);
  const bulletW = bulletColor ? bulletSize + bulletGap : 0;

  (items || []).forEach((raw, i) => {
    const text = String(raw);
    const row = Math.floor(i / columns);
    const col = i % columns;
    const ix = x + col * colW;
    const iy = yTop + row * rowGap;

    if (draw) {
      if (bulletColor) {
        doc.fillColor(bulletColor).rect(ix, iy + size * 0.55, bulletSize, bulletSize).fill();
      }
      doc.font(font).fontSize(size).fillColor(color);
      doc.text(text, ix + bulletW, iy, { lineBreak: false, width: colW - bulletW - 4, ellipsis: true });
    }
  });

  return { y: yTop + rowCount * rowGap, rows: rowCount, lines: rowCount };
}

// ── Fit-recovery recommendation ──────────────────────────────────────────
// Called ONLY when a template's most compact layout still overflows the
// page (see each template's measure()). Picks the single most useful,
// concrete thing to cut — the largest trimmable section — rather than a
// vague "your CV is too long". This is what lets the AI give the user a
// confident, specific recommendation ("cut ~2 lines from Experience — the
// Beta Inc role has the longest bullets") instead of an open-ended
// "what do you want to remove?" question.
const TRIMMABLE_SECTIONS = ['experience', 'achievements', 'certifications', 'skills', 'profile'];

function buildFitRecommendation(sections, overflowLines) {
  const trimmable = (sections || [])
    .filter(s => s.present && TRIMMABLE_SECTIONS.includes(s.name) && s.linesUsed > 0)
    .sort((a, b) => b.linesUsed - a.linesUsed);

  if (!trimmable.length) {
    return `Content is about ${overflowLines} line(s) too long for one page, but there's no single large section to trim — consider shortening the profile summary or the longest bullet points across sections.`;
  }
  const target = trimmable[0];
  const cutCount = Math.min(overflowLines, target.linesUsed);
  return `Content is about ${overflowLines} line(s) too long for one page even after tightening the layout. The "${target.name}" section is the largest (${target.linesUsed} lines) — recommend cutting or shortening about ${cutCount} line(s) there, e.g. the least relevant bullet point or entry, rather than trimming a little from everywhere.`;
}

module.exports = {
  PDFDocument, measureDoc, wrapLines,
  normalizeEducation, normalizeReferences,
  proficiencyToFill,
  flowItems, columnItems,
  buildFitRecommendation
};