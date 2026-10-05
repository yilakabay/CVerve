// functions/lib/cv-template-block-band.js
//
// "Gray Block & Black Band" CV template — ported from the Python/ReportLab
// design: a light gray full-height left panel (About Me, Education, Skills,
// Languages), a black header band top-right with the name and title, a
// circular photo sitting on the seam, a contact row under the band, and a
// right column with a connected experience timeline, achievements,
// certifications and references.
//
// Skills are a plain list here (no progress bars), as requested.
//
// Same measure()/render() contract as every other template.
//
// ── Safety rules (shared, from cv-shared.js) ──────────────────────────────
// • Every text run is wrapped to its real box width (wrapLines). Nothing is
//   cut with "..." — long names wrap onto more lines.
// • Vertical positions come from the lines actually drawn, never fixed
//   offsets, so longer content pushes the rest down instead of colliding.
// • Experience title/date rows use expTitleDateRow() (wrap, never truncate).
// • Custom sections are rendered in BOTH the sidebar and the main column.
// • Fit ladder: normal → tight-leading. If it still overflows, render()
//   throws with a concrete cut recommendation instead of a clipped PDF.
// • Nothing personal is hard-coded: every value comes from `content`.

const {
  PDFDocument, measureDoc, wrapLines, expTitleDateRow,
  normalizeEducation, normalizeReferences, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Colors ----------
const WHITE = '#FFFFFF';
const GRAY_PANEL = '#E7E7E3';
const BLACK_BAND = '#18181A';
const INK = '#1E1F22';
const BODY = '#5C5E62';
const MUTED = '#8C8E93';
const RULE_L = '#B9BAB6';
const RULE_R = '#E0E2E4';
const PHOTO_PLACEHOLDER = '#D5D9E0';

// ---------- Layout ----------
const GRAY_W = 235.0;
const PAD_L = 28.0;
const LEFT_X = PAD_L;
const LEFT_RIGHT = GRAY_W - PAD_L;
const LEFT_W = LEFT_RIGHT - LEFT_X;

const RIGHT_X = GRAY_W + 32.0;
const RIGHT_RIGHT = PAGE_W - 42.0;
const RIGHT_W = RIGHT_RIGHT - RIGHT_X;

const BAND_TOP = 26.0;
const BAND_LEFT_X = 168.0;   // band overlaps slightly into the gray panel
const BAND_MIN_H = 108.0;
const PHOTO_R = 60.0;
const PHOTO_CX = GRAY_W / 2.0;
const NAME_X = PHOTO_CX + PHOTO_R + 26;
const BAND_RIGHT_PAD = 30.0;

const AVAILABLE_BOTTOM = PAGE_H - 30;

// ── Small drawing helpers ─────────────────────────────────────────────────

// Draws (or just measures) a block of already-wrapped lines. Returns new y.
function block(doc, lines, x, y, { font, size, color, leading, draw }) {
  if (draw) {
    doc.font(font).fontSize(size).fillColor(color);
    lines.forEach((ln, i) => doc.text(ln, x, y + i * leading, { lineBreak: false }));
  }
  return y + lines.length * leading;
}

// Section heading: uppercase label with a thin rule running to the right edge.
function heading(doc, label, x, y, { width, size, color, ruleColor, draw }) {
  if (draw) {
    const text = String(label || '').toUpperCase();
    doc.font('Helvetica-Bold').fontSize(size).fillColor(color);
    doc.text(text, x, y, { lineBreak: false });
    const lw = doc.widthOfString(text);
    doc.strokeColor(ruleColor).lineWidth(0.9)
      .moveTo(x + lw + 10, y + size * 0.45).lineTo(x + width, y + size * 0.45).stroke();
  }
  return y + size + 8;
}

// Plain dot-bulleted list (used for skills, languages, achievements, bullets).
function bulletList(doc, items, x, y, { width, size, leading, color, dotColor, gap, draw }) {
  let cur = y, lines = 0;
  (items || []).forEach(item => {
    const ls = wrapLines(doc, String(item), 'Helvetica', size, width - 12);
    if (draw) {
      doc.fillColor(dotColor).circle(x + 2, cur + size * 0.55, 1.5).fill();
    }
    cur = block(doc, ls, x + 12, cur, { font: 'Helvetica', size, color, leading, draw });
    cur += gap;
    lines += ls.length;
  });
  return { y: cur, lines };
}

// ── Layout ────────────────────────────────────────────────────────────────

function layout(doc, content, { draw, stretchPerGap = 0, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    return Math.max(size + 2.2, Math.round(leading * 0.86 * 10) / 10);
  };
  const gapPx = (g) => (tightLeading ? Math.round(g * 0.6) : g);
  const GS = stretchPerGap;

  // ── Backgrounds ───────────────────────────────────────────────────────
  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(WHITE);
    doc.rect(0, 0, GRAY_W, PAGE_H).fill(GRAY_PANEL);
  }

  // ── Header band: size the name so it wraps instead of truncating ──────
  const NAME_W = PAGE_W - BAND_RIGHT_PAD - NAME_X;
  const NAME_SIZES = [24, 20, 18];
  const nameText = content.name || '';
  let nameSize = NAME_SIZES[NAME_SIZES.length - 1];
  let nameLines = null;
  for (const s of NAME_SIZES) {
    const ls = wrapLines(doc, nameText, 'Helvetica-Bold', s, NAME_W);
    if (ls.length <= 2) { nameSize = s; nameLines = ls; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Helvetica-Bold', nameSize, NAME_W);
  const nameLH = nameSize * 1.18;

  const SUB_SIZE = 13, SUB_LH = 15.5;
  const subLines = wrapLines(doc, content.subtitle || '', 'Helvetica', SUB_SIZE, NAME_W);

  const textBlockH = nameLines.length * nameLH + (subLines.length ? 6 + subLines.length * SUB_LH : 0);
  const bandH = Math.max(BAND_MIN_H, textBlockH + 36);
  const BAND_BOTTOM = BAND_TOP + bandH;
  const PHOTO_CY = BAND_TOP + bandH / 2;

  if (draw) {
    doc.roundedRect(BAND_LEFT_X, BAND_TOP, PAGE_W - BAND_LEFT_X, bandH, 8).fill(BLACK_BAND);

    // Photo sits on the seam between the band and the gray panel.
    doc.fillColor(WHITE).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 5).fill();
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(PHOTO_CX, PHOTO_CY, PHOTO_R).clip();
        doc.image(buf, PHOTO_CX - PHOTO_R, PHOTO_CY - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('block-band photo error:', e.message); }
    } else {
      doc.fillColor(PHOTO_PLACEHOLDER).circle(PHOTO_CX, PHOTO_CY, PHOTO_R).fill();
    }
  }

  const textTop = BAND_TOP + (bandH - textBlockH) / 2;
  let nameBottom = block(doc, nameLines, NAME_X, textTop, { font: 'Helvetica-Bold', size: nameSize, color: WHITE, leading: nameLH, draw });
  if (subLines.length) {
    block(doc, subLines, NAME_X, nameBottom + 6, { font: 'Helvetica', size: SUB_SIZE, color: WHITE, leading: SUB_LH, draw });
  }

  // ── Contact row under the band (two columns, wrapped, no truncation) ───
  const colW = RIGHT_W / 2 - 6;
  const colX = [RIGHT_X, RIGHT_X + RIGHT_W / 2 + 6];
  const contactItems = [
    content.contact?.phone ? { text: content.contact.phone, link: `tel:${String(content.contact.phone).replace(/\s+/g, '')}` } : null,
    content.contact?.location ? { text: content.contact.location, link: null } : null,
    content.contact?.email ? { text: content.contact.email, link: `mailto:${content.contact.email}` } : null,
    content.contact?.linkedin ? { text: content.contact.linkedin, link: content.contact.linkedin.startsWith('http') ? content.contact.linkedin : `https://${content.contact.linkedin}` } : null,
  ].filter(Boolean);

  let cY = BAND_BOTTOM + 26;
  let contactLines = 0;
  for (let r = 0; r * 2 < contactItems.length; r++) {
    const rowItems = contactItems.slice(r * 2, r * 2 + 2);
    let rowH = 0;
    rowItems.forEach((it, k) => {
      const x = colX[k];
      const ls = wrapLines(doc, it.text, 'Helvetica', 9.3, colW - 12);
      rowH = Math.max(rowH, ls.length * 12.5);
      if (draw) {
        doc.fillColor(INK).circle(x + 2.6, cY + 5, 2.6).fill();
        doc.font('Helvetica').fontSize(9.3).fillColor(INK);
        ls.forEach((ln, i) => {
          doc.text(ln, x + 12, cY + i * 12.5, { lineBreak: false });
          if (it.link) doc.link(x + 12, cY + i * 12.5, doc.widthOfString(ln), 11, it.link);
        });
      }
      contactLines += ls.length;
    });
    cY += rowH + 6;
  }
  const RIGHT_BLOCK_TOP = cY + 8;
  if (draw) {
    doc.strokeColor(RULE_R).lineWidth(0.75).moveTo(RIGHT_X, RIGHT_BLOCK_TOP).lineTo(RIGHT_RIGHT, RIGHT_BLOCK_TOP).stroke();
  }
  track('contact', contactLines, contactItems.length > 0);

  // ════════════════ LEFT PANEL ════════════════
  let ly = PHOTO_CY + PHOTO_R + 22;

  // About Me
  if (content.profile) {
    ly = heading(doc, 'About Me', LEFT_X, ly, { width: LEFT_W, size: 11.5, color: INK, ruleColor: RULE_L, draw });
    const L = tighten(12.6, 8.9);
    const ls = wrapLines(doc, content.profile, 'Helvetica', 8.9, LEFT_W);
    ly = block(doc, ls, LEFT_X, ly, { font: 'Helvetica', size: 8.9, color: BODY, leading: L, draw });
    track('profile', ls.length, true);
    ly += gapPx(14) + GS;
  } else track('profile', 0, false);

  // Education (up to two entries, same as the other templates)
  const eduList = normalizeEducation(content.education).slice(0, 2);
  if (eduList.length) {
    ly = heading(doc, 'Education', LEFT_X, ly, { width: LEFT_W, size: 11.5, color: INK, ruleColor: RULE_L, draw });
    let eduLines = 0;
    eduList.forEach(edu => {
      const title = edu.degree || edu.level || '';
      const tl = wrapLines(doc, title, 'Helvetica-Bold', 9.3, LEFT_W);
      ly = block(doc, tl, LEFT_X, ly, { font: 'Helvetica-Bold', size: 9.3, color: INK, leading: 12, draw });
      const sl = wrapLines(doc, edu.school || '', 'Helvetica', 8.8, LEFT_W);
      ly = block(doc, sl, LEFT_X, ly, { font: 'Helvetica', size: 8.8, color: BODY, leading: 12, draw });
      const dl = wrapLines(doc, edu.dateRange || '', 'Helvetica', 8.8, LEFT_W);
      ly = block(doc, dl, LEFT_X, ly, { font: 'Helvetica', size: 8.8, color: BODY, leading: 12, draw });
      const xl = wrapLines(doc, edu.extra || '', 'Helvetica', 8.8, LEFT_W);
      ly = block(doc, xl, LEFT_X, ly, { font: 'Helvetica', size: 8.8, color: BODY, leading: 12, draw });
      eduLines += tl.length + sl.length + dl.length + xl.length;
      ly += 8;
    });
    track('education', eduLines, true);
    ly += gapPx(6) + GS;
  } else track('education', 0, false);

  // Skills: plain list, no bars
  if (content.skills && content.skills.length) {
    ly = heading(doc, 'Skills', LEFT_X, ly, { width: LEFT_W, size: 11.5, color: INK, ruleColor: RULE_L, draw });
    const r = bulletList(doc, content.skills, LEFT_X, ly, { width: LEFT_W, size: 9.0, leading: 12.5, color: BODY, dotColor: INK, gap: 4, draw });
    ly = r.y;
    track('skills', r.lines, true);
    ly += gapPx(10) + GS;
  } else track('skills', 0, false);

  // Languages
  const langItems = (content.languages || []).map(l => (l.level ? `${l.name} — ${l.level}` : l.name)).filter(Boolean);
  if (langItems.length) {
    ly = heading(doc, 'Languages', LEFT_X, ly, { width: LEFT_W, size: 11.5, color: INK, ruleColor: RULE_L, draw });
    const r = bulletList(doc, langItems, LEFT_X, ly, { width: LEFT_W, size: 9.0, leading: 12.5, color: BODY, dotColor: INK, gap: 4, draw });
    ly = r.y;
    track('languages', r.lines, true);
    ly += gapPx(10) + GS;
  } else track('languages', 0, false);

  // Custom sidebar sections (placement "sidebar")
  (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar').forEach(cs => {
    ly = heading(doc, cs.title || 'Section', LEFT_X, ly, { width: LEFT_W, size: 11.5, color: INK, ruleColor: RULE_L, draw });
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = bulletList(doc, cs.items, LEFT_X, ly, { width: LEFT_W, size: 9.0, leading: 12.5, color: BODY, dotColor: INK, gap: 4, draw });
      ly = r.y;
      linesUsed = r.lines;
    } else if (cs.text) {
      const ls = wrapLines(doc, cs.text, 'Helvetica', 8.9, LEFT_W);
      ly = block(doc, ls, LEFT_X, ly, { font: 'Helvetica', size: 8.9, color: BODY, leading: tighten(12.6, 8.9), draw });
      linesUsed = ls.length;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    ly += gapPx(10) + GS;
  });

  // ════════════════ RIGHT COLUMN ════════════════
  let ry = RIGHT_BLOCK_TOP + 16;

  // Experience (connected timeline)
  if (content.experience && content.experience.length) {
    ry = heading(doc, 'Experience', RIGHT_X, ry, { width: RIGHT_W, size: 13, color: INK, ruleColor: RULE_R, draw });
    const TIMELINE_X = RIGHT_X + 3;
    const TX = TIMELINE_X + 16;
    const TW = RIGHT_RIGHT - TX;
    let linesUsed = 0;

    content.experience.forEach(exp => {
      const nodeY = ry + 5;
      const headerR = expTitleDateRow(doc, { org: exp.role, date: exp.dateRange }, TX, ry, TW, {
        titleFont: 'Helvetica-Bold', titleSize: 10.6, titleColor: INK,
        dateFont: 'Helvetica-Oblique', dateSize: 9, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      let cy = headerR.y + 3;
      const ol = wrapLines(doc, exp.org || '', 'Helvetica', 9.0, TW);
      cy = block(doc, ol, TX, cy, { font: 'Helvetica', size: 9.0, color: BODY, leading: 13, draw });
      cy += 3;
      const br = bulletList(doc, exp.bullets || [], TX, cy, { width: TW, size: 9.4, leading: 13.4, color: BODY, dotColor: INK, gap: 2.6, draw });
      cy = br.y;

      if (draw) {
        // Timeline segment from this entry's node down to its end, then the node.
        doc.strokeColor(RULE_R).lineWidth(1).moveTo(TIMELINE_X, nodeY + 4).lineTo(TIMELINE_X, cy - 4).stroke();
        doc.strokeColor(INK).lineWidth(1.1).circle(TIMELINE_X, nodeY, 4).stroke();
        doc.fillColor(INK).circle(TIMELINE_X, nodeY, 1.6).fill();
      }

      linesUsed += 1 + headerR.lines + ol.length + br.lines;
      ry = cy + gapPx(10);
    });
    track('experience', linesUsed, true);
    ry += gapPx(4) + GS;
  } else track('experience', 0, false);

  // Achievements
  if (content.achievements && content.achievements.length) {
    ry = heading(doc, 'Achievements', RIGHT_X, ry, { width: RIGHT_W, size: 13, color: INK, ruleColor: RULE_R, draw });
    const r = bulletList(doc, content.achievements, RIGHT_X, ry, { width: RIGHT_W, size: 9.4, leading: 13.4, color: BODY, dotColor: INK, gap: 2.4, draw });
    ry = r.y;
    track('achievements', r.lines, true);
    ry += gapPx(10) + GS;
  } else track('achievements', 0, false);

  // Custom main-column sections (placement "main" or unspecified)
  (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar').forEach(cs => {
    ry = heading(doc, cs.title || 'Section', RIGHT_X, ry, { width: RIGHT_W, size: 13, color: INK, ruleColor: RULE_R, draw });
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = bulletList(doc, cs.items, RIGHT_X, ry, { width: RIGHT_W, size: 9.4, leading: 13.4, color: BODY, dotColor: INK, gap: 2.4, draw });
      ry = r.y;
      linesUsed = r.lines;
    } else if (cs.text) {
      const ls = wrapLines(doc, cs.text, 'Helvetica', 9.4, RIGHT_W);
      ry = block(doc, ls, RIGHT_X, ry, { font: 'Helvetica', size: 9.4, color: BODY, leading: tighten(13.4, 9.4), draw });
      linesUsed = ls.length;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    ry += gapPx(10) + GS;
  });

  // Certifications
  if (content.certifications && content.certifications.length) {
    ry = heading(doc, 'Certifications', RIGHT_X, ry, { width: RIGHT_W, size: 13, color: INK, ruleColor: RULE_R, draw });
    let linesUsed = 0;
    content.certifications.forEach(cert => {
      const tl = wrapLines(doc, cert.title || '', 'Helvetica-Bold', 9.2, RIGHT_W - 11);
      const il = wrapLines(doc, cert.issuer || '', 'Helvetica', 8.8, RIGHT_W - 11);
      if (draw) doc.fillColor(INK).circle(RIGHT_X + 2, ry + 6, 1.5).fill();
      ry = block(doc, tl, RIGHT_X + 11, ry, { font: 'Helvetica-Bold', size: 9.2, color: INK, leading: tighten(13, 9.2), draw });
      ry = block(doc, il, RIGHT_X + 11, ry, { font: 'Helvetica', size: 8.8, color: MUTED, leading: tighten(12, 8.8), draw });
      linesUsed += tl.length + il.length;
      ry += 5;
    });
    track('certifications', linesUsed, true);
    ry += gapPx(8) + GS;
  } else track('certifications', 0, false);

  // References (stacked, any number)
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = heading(doc, refList.length > 1 ? 'References' : 'Reference', RIGHT_X, ry, { width: RIGHT_W, size: 13, color: INK, ruleColor: RULE_R, draw });
    let linesUsed = 0;
    const LABEL_W = 44;
    refList.forEach((ref, i) => {
      const nl = wrapLines(doc, ref.name || '', 'Helvetica-Bold', 10.3, RIGHT_W).slice(0, 2);
      ry = block(doc, nl, RIGHT_X, ry, { font: 'Helvetica-Bold', size: 10.3, color: INK, leading: 14, draw });
      const rl = ref.role ? wrapLines(doc, ref.role, 'Helvetica', 9.2, RIGHT_W) : [];
      ry = block(doc, rl, RIGHT_X, ry, { font: 'Helvetica', size: 9.2, color: BODY, leading: 13, draw });
      linesUsed += nl.length + rl.length;

      [['Email:', ref.email], ['Phone:', ref.phone]].forEach(([label, val]) => {
        if (!val) return;
        const vl = wrapLines(doc, String(val), 'Helvetica', 9.2, RIGHT_W - LABEL_W);
        if (draw) {
          doc.font('Helvetica-Bold').fontSize(9.2).fillColor(INK);
          doc.text(label, RIGHT_X, ry, { lineBreak: false });
        }
        ry = block(doc, vl, RIGHT_X + LABEL_W, ry, { font: 'Helvetica', size: 9.2, color: BODY, leading: 13, draw });
        linesUsed += vl.length;
      });
      if (i < refList.length - 1) ry += 8;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: Math.max(ly, ry), sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { tightLeading: false } },
  { name: 'tight-leading', opts: { tightLeading: true } },
];
const HARD_OVERFLOW_LINE_THRESHOLD = 3;

function measure(content) {
  let last = null;
  for (const level of FIT_LEVELS) {
    const doc = measureDoc();
    const { finalY, sections } = layout(doc, content, { draw: false, ...level.opts });
    last = { finalY, sections, level: level.name };
    if (finalY <= AVAILABLE_BOTTOM) {
      return {
        fits: true, finalY, availableHeight: AVAILABLE_BOTTOM,
        overflowPoints: 0, overflowLines: 0,
        underflowPoints: Math.round(AVAILABLE_BOTTOM - finalY),
        underflowLines: Math.round((AVAILABLE_BOTTOM - finalY) / 13),
        sections, appliedLevel: level.name, hardOverflow: false,
      };
    }
  }
  const overflowPt = last.finalY - AVAILABLE_BOTTOM;
  const overflowLines = Math.round(overflowPt / 13);
  return {
    fits: false, finalY: last.finalY, availableHeight: AVAILABLE_BOTTOM,
    overflowPoints: Math.round(overflowPt), overflowLines,
    underflowPoints: 0, underflowLines: 0,
    sections: last.sections, appliedLevel: last.level,
    hardOverflow: overflowLines > HARD_OVERFLOW_LINE_THRESHOLD,
    recommendation: buildFitRecommendation(last.sections, overflowLines),
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