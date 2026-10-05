// functions/lib/cv-template-editorial.js
//
// "Editorial Column" CV template — ported from the Python/ReportLab design.
// Slim light sidebar (contact, skills, education, languages) with a circular
// portrait, and a wide main column with a serif name block, a timeline-style
// experience section, achievements, certifications and references.
// Same measure()/render() contract as every other template.
//
// ── Safety rules (from cv-shared.js) ─────────────────────────────────────
// • Every text run is wrapped to its real box width (wrapLines), so long
//   values flow onto extra lines instead of running off the page or into
//   the next column.
// • Vertical positions are computed from the actual lines drawn, never from
//   fixed offsets, so a longer name/subtitle/entry pushes content down
//   rather than colliding with the rules below it.
// • Title/date rows use expTitleDateRow() — wrap, never truncate.
// • Fit ladder: normal → tight-leading. If still too tall, render() throws
//   with a concrete recommendation instead of producing a clipped PDF.

const {
  PDFDocument, measureDoc, wrapLines, truncateToFit, expTitleDateRow,
  normalizeEducation, normalizeReferences, proficiencyToFill, buildFitRecommendation
} = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;

// ---------- Palette ----------
const PAPER = '#FFFFFF';
const NAVY = '#141C2D';
const NAVY_SOFT = '#364056';
const GOLD = '#9E8143';
const GOLD_LT = '#C7AE78';
const INK = '#212124';
const BODY = '#54555C';
const MUTED = '#98989E';
const RULE = '#E0DED9';
const SIDEBAR_BG = '#F7F6F3';

// ---------- Layout ----------
const SIDEBAR_W = 188.0;
const GUTTER = 34.0;
const SIDE_PAD = 26.0;
const SIDE_X = SIDE_PAD;
const SIDE_W = SIDEBAR_W - SIDE_PAD * 2;
const COL_X = SIDEBAR_W + GUTTER;
const COL_RIGHT = PAGE_W - 40.0;
const COL_W = COL_RIGHT - COL_X;
const AVAILABLE_BOTTOM = PAGE_H - 30;

const PHOTO_TOP = 40.0;
const PHOTO_R = SIDE_W / 2.0;
const PHOTO_CX = SIDEBAR_W / 2.0;
const PHOTO_CY = PHOTO_TOP + PHOTO_R;

function layout(doc, content, { draw, stretchPerGap = 0, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    return Math.max(size + 2.2, Math.round(leading * 0.86 * 10) / 10);
  };

  // ── Background ──────────────────────────────────────────────────────
  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(PAPER);
    doc.rect(0, 0, SIDEBAR_W, PAGE_H).fill(SIDEBAR_BG);
    doc.strokeColor(GOLD).lineWidth(1.1).moveTo(SIDEBAR_W, 0).lineTo(SIDEBAR_W, PAGE_H).stroke();
  }

  // ── Sidebar helpers ─────────────────────────────────────────────────
  function sideLabel(text, y) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD);
      doc.text(text.toUpperCase(), SIDE_X, y, { lineBreak: false });
    }
    return y + 13;
  }
  function sideRule(y, gapAfter = 16) {
    if (draw) doc.strokeColor(RULE).lineWidth(0.6).moveTo(SIDE_X, y).lineTo(SIDE_X + SIDE_W, y).stroke();
    return y + gapAfter;
  }
  // Wrapped sidebar text. Returns the new y and how many lines it used.
  function sideLines(text, y, { font = 'Helvetica', size = 8.6, color = NAVY_SOFT, x = SIDE_X, width = SIDE_W, leading = 11 } = {}) {
    const lines = wrapLines(doc, String(text || ''), font, size, width);
    if (draw) {
      doc.font(font).fontSize(size).fillColor(color);
      let cy = y;
      lines.forEach(ln => { doc.text(ln, x, cy, { lineBreak: false }); cy += leading; });
    }
    return { y: y + lines.length * leading, lines: lines.length };
  }

  // ── Sidebar: portrait ────────────────────────────────────────────────
  if (draw) {
    doc.fillColor(SIDEBAR_BG).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 6).fill();
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(PHOTO_CX, PHOTO_CY, PHOTO_R).clip();
        doc.image(buf, PHOTO_CX - PHOTO_R, PHOTO_CY - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('editorial photo error:', e.message); }
    } else {
      doc.fillColor('#D5D9E0').circle(PHOTO_CX, PHOTO_CY, PHOTO_R).fill();
    }
    doc.strokeColor(GOLD).lineWidth(1.4).circle(PHOTO_CX, PHOTO_CY, PHOTO_R + 4).stroke();
  }

  let sy = PHOTO_TOP + 2 * PHOTO_R + 30;

  // ── Sidebar: contact ─────────────────────────────────────────────────
  sy = sideLabel('Contact', sy);
  const contactItems = [
    ['Phone', content.contact?.phone, content.contact?.phone ? `tel:${content.contact.phone.replace(/\s+/g, '')}` : null],
    ['Email', content.contact?.email, content.contact?.email ? `mailto:${content.contact.email}` : null],
    ['Location', content.contact?.location, null],
    ['LinkedIn', content.contact?.linkedin, content.contact?.linkedin ? (content.contact.linkedin.startsWith('http') ? content.contact.linkedin : `https://${content.contact.linkedin}`) : null],
  ].filter(([, v]) => !!v);
  contactItems.forEach(([label, value, link]) => {
    if (draw) { doc.font('Helvetica').fontSize(7.6).fillColor(MUTED); doc.text(label.toUpperCase(), SIDE_X, sy, { lineBreak: false }); }
    sy += 10.5;
    const r = sideLines(value, sy, { size: 9, color: NAVY, leading: 11.5 });
    if (draw && link) {
      doc.font('Helvetica').fontSize(9);
      const lines = wrapLines(doc, String(value), 'Helvetica', 9, SIDE_W);
      lines.forEach((ln, i) => {
        const w = doc.widthOfString(ln);
        doc.link(SIDE_X, sy + i * 11.5, w, 11, link);
      });
    }
    sy = r.y + 5;
  });
  sy += 6;
  sy = sideRule(sy, 16);

  // ── Sidebar: skills ──────────────────────────────────────────────────
  sy = sideLabel('Skills', sy);
  (content.skills || []).forEach(s => {
    const r = sideLines(s, sy + 1, { size: 8.6, x: SIDE_X + 9, width: SIDE_W - 9, leading: 11 });
    if (draw) doc.fillColor(GOLD).rect(SIDE_X, sy + 6.2, 3.2, 3.2).fill();
    sy = r.y + 2.2;
  });
  track('skills', (content.skills || []).length, (content.skills || []).length > 0);
  sy += 4;
  sy = sideRule(sy, 16);

  // ── Sidebar: education ───────────────────────────────────────────────
  sy = sideLabel('Education', sy);
  const eduList = normalizeEducation(content.education);
  let eduLines = 0;
  eduList.slice(0, 2).forEach((edu, i) => {
    if (edu.school) {
      const r = sideLines(edu.school, sy, { font: 'Times-Bold', size: 9.5, color: NAVY, leading: 12 });
      sy = r.y; eduLines += r.lines;
    }
    if (edu.degree) {
      const r = sideLines(edu.degree, sy, { font: 'Times-Italic', size: 8.6, color: BODY, leading: 11 });
      sy = r.y; eduLines += r.lines;
    }
    if (edu.dateRange) {
      if (draw) { doc.font('Helvetica').fontSize(7.8).fillColor(MUTED); doc.text(edu.dateRange, SIDE_X, sy, { lineBreak: false }); }
      sy += 10.5; eduLines += 1;
    }
    if (edu.extra) {
      const r = sideLines(edu.extra, sy, { font: 'Helvetica', size: 7.8, color: MUTED, leading: 10.5 });
      sy = r.y; eduLines += r.lines;
    }
    sy += i === 0 && eduList.length > 1 ? 14 : 4;
  });
  track('education', eduLines, eduList.length > 0);
  sy += 2;
  sy = sideRule(sy, 16);

  // ── Sidebar: languages (bar keyed off each language's own level) ─────
  sy = sideLabel('Languages', sy);
  (content.languages || []).forEach(l => {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(8.8).fillColor(NAVY);
      doc.text(truncateToFit(doc, l.name, 'Helvetica-Bold', 8.8, SIDE_W * 0.55), SIDE_X, sy, { lineBreak: false });
      doc.font('Helvetica').fontSize(7.8).fillColor(MUTED);
      const lvl = truncateToFit(doc, l.level || '', 'Helvetica', 7.8, SIDE_W * 0.42);
      doc.text(lvl, SIDE_X, sy + 1, { width: SIDE_W, align: 'right', lineBreak: false });
    }
    sy += 10;
    const pct = proficiencyToFill(l.level);
    if (draw) {
      doc.fillColor(RULE).rect(SIDE_X, sy + 3, SIDE_W, 3).fill();
      doc.fillColor(GOLD).rect(SIDE_X, sy + 3, SIDE_W * pct, 3).fill();
    }
    sy += 16;
  });
  sy = sideRule(sy, 16);

  // ── Sidebar: custom sections (placement "sidebar") ───────────────────
  (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar').forEach(cs => {
    sy = sideLabel(cs.title || 'Section', sy);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      cs.items.forEach(item => {
        const r = sideLines(item, sy + 1, { size: 8.6, x: SIDE_X + 9, width: SIDE_W - 9, leading: 11 });
        if (draw) doc.fillColor(GOLD).rect(SIDE_X, sy + 6.2, 3.2, 3.2).fill();
        sy = r.y + 2.2;
        linesUsed += r.lines;
      });
    } else if (cs.text) {
      const r = sideLines(cs.text, sy, { font: 'Helvetica', size: 8.6, color: NAVY_SOFT, leading: 11 });
      sy = r.y;
      linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    sy += 4;
    sy = sideRule(sy, 16);
  });

  // ── Main column: name block ──────────────────────────────────────────
  // Name: shrink to fit in one line if possible, otherwise WRAP onto as many
  // lines as needed. Never truncated with "...".
  const NAME_TOP = 46.0;
  const nameSizes = [30, 26, 22];
  const nameText = content.name || '';
  let nameSize = nameSizes[nameSizes.length - 1];
  let nameLines = null;
  for (const s of nameSizes) {
    const lines = wrapLines(doc, nameText, 'Times-Bold', s, COL_W);
    if (lines.length === 1) { nameSize = s; nameLines = lines; break; }
  }
  if (!nameLines) nameLines = wrapLines(doc, nameText, 'Times-Bold', nameSize, COL_W);
  const nameLH = nameSize * 1.15;
  if (draw) {
    doc.font('Times-Bold').fontSize(nameSize).fillColor(NAVY);
    nameLines.forEach((ln, i) => doc.text(ln, COL_X, NAME_TOP + i * nameLH, { lineBreak: false }));
  }
  const nameBottom = NAME_TOP + nameLines.length * nameLH;

  const subtitleTop = nameBottom + 2;
  const subtitleLines = wrapLines(doc, (content.subtitle || '').toUpperCase(), 'Helvetica', 11.3, COL_W).slice(0, 2);
  if (draw) {
    doc.font('Helvetica').fontSize(11.3).fillColor(GOLD);
    subtitleLines.forEach((ln, i) => doc.text(ln, COL_X, subtitleTop + i * 14, { lineBreak: false }));
  }
  const ruleY = subtitleTop + Math.max(1, subtitleLines.length) * 14 + 8;
  if (draw) {
    doc.strokeColor(GOLD).lineWidth(1.3).moveTo(COL_X, ruleY).lineTo(COL_X + COL_W, ruleY).stroke();
    doc.strokeColor(RULE).lineWidth(0.6).moveTo(COL_X, ruleY + 3.5).lineTo(COL_X + COL_W, ruleY + 3.5).stroke();
  }

  let y = ruleY + 22;

  // ── Section heading helper (serif, gold rule to the right) ──────────
  function sectionHeading(label, yTop) {
    if (draw) {
      doc.font('Times-Bold').fontSize(13.5).fillColor(NAVY);
      doc.text(label, COL_X, yTop, { lineBreak: false });
      const tw = doc.widthOfString(label);
      doc.strokeColor(GOLD).lineWidth(1.4).moveTo(COL_X + tw + 10, yTop + 7).lineTo(COL_X + COL_W, yTop + 7).stroke();
    }
    return yTop + 24;
  }
  // Wrapped main-column paragraph.
  function mainPara(text, yTop, { size = 9.6, leading = 14.2, font = 'Helvetica', color = BODY } = {}) {
    const L = tighten(leading, size);
    const lines = wrapLines(doc, String(text || ''), font, size, COL_W);
    if (draw) {
      doc.font(font).fontSize(size).fillColor(color);
      let cy = yTop;
      lines.forEach(ln => { doc.text(ln, COL_X, cy, { lineBreak: false }); cy += L; });
    }
    return { y: yTop + lines.length * L, lines: lines.length };
  }

  // ── Profile ─────────────────────────────────────────────────────────
  if (content.profile) {
    y = sectionHeading('Profile', y);
    const r = mainPara(content.profile, y);
    track('profile', r.lines, true);
    y = r.y + 22 + stretchPerGap;
  } else track('profile', 0, false);

  // ── Experience (timeline) ───────────────────────────────────────────
  if (content.experience && content.experience.length) {
    y = sectionHeading('Experience', y);
    let linesUsed = 0;
    const TX = COL_X + 16, TW = COL_W - 16;
    content.experience.forEach(exp => {
      const dotY = y + 4;
      if (draw) doc.fillColor(GOLD).circle(COL_X + 3, dotY, 3.2).fill();
      // Title/date: wrap-not-truncate, date drops below if no room.
      const headerR = expTitleDateRow(doc, { org: exp.org, date: exp.dateRange }, TX, y + 1, TW, {
        titleFont: 'Times-Bold', titleSize: 11, titleColor: INK,
        dateFont: 'Helvetica', dateSize: 8.6, dateColor: MUTED,
        lineH: 13, gap: 10, draw
      });
      let yy = headerR.y + 2;
      if (exp.role) {
        const rl = wrapLines(doc, exp.role, 'Times-Italic', 9.4, TW);
        if (draw) { doc.font('Times-Italic').fontSize(9.4).fillColor(GOLD); rl.forEach(ln => { doc.text(ln, TX, yy, { lineBreak: false }); yy += 13; }); }
        else yy += rl.length * 13;
        linesUsed += rl.length;
      }
      yy += 2;
      (exp.bullets || []).forEach(b => {
        const lines = wrapLines(doc, b, 'Helvetica', 9.0, TW - 12);
        if (draw) {
          doc.fillColor(NAVY_SOFT).rect(TX, yy + 5.4, 2.6, 2.6).fill();
          doc.font('Helvetica').fontSize(9.0).fillColor(BODY);
          let ly = yy;
          lines.forEach(ln => { doc.text(ln, TX + 11, ly, { lineBreak: false }); ly += 12.6; });
        }
        yy += lines.length * 12.6 + 2;
        linesUsed += lines.length;
      });
      if (draw) doc.strokeColor(RULE).lineWidth(1).moveTo(COL_X + 3, dotY + 6).lineTo(COL_X + 3, yy + 2).stroke();
      linesUsed += 1 + headerR.lines;
      y = yy + 4 + stretchPerGap;
    });
    track('experience', linesUsed, true);
    y += 14;
  } else track('experience', 0, false);

  // ── Achievements ────────────────────────────────────────────────────
  if (content.achievements && content.achievements.length) {
    y = sectionHeading('Achievements', y);
    let linesUsed = 0;
    content.achievements.forEach(a => {
      const lines = wrapLines(doc, a, 'Helvetica', 9.4, COL_W - 13);
      if (draw) {
        doc.fillColor(GOLD).rect(COL_X, y + 6, 3, 3).fill();
        doc.font('Helvetica').fontSize(9.4).fillColor(BODY);
        let cy = y;
        lines.forEach(ln => { doc.text(ln, COL_X + 12, cy, { lineBreak: false }); cy += 13.4; });
      }
      y += lines.length * 13.4 + 3;
      linesUsed += lines.length;
    });
    track('achievements', linesUsed, true);
    y += 14;
  } else track('achievements', 0, false);

  // ── Certifications ──────────────────────────────────────────────────
  if (content.certifications && content.certifications.length) {
    y = sectionHeading('Certifications & Recognition', y);
    let linesUsed = 0;
    content.certifications.forEach(cert => {
      const titleLines = wrapLines(doc, cert.title || '', 'Times-Bold', 9.6, COL_W - 14);
      const issuerLines = wrapLines(doc, cert.issuer || '', 'Helvetica', 8.6, COL_W - 14);
      if (draw) {
        doc.fillColor(GOLD).circle(COL_X + 2.5, y + 5.5, 2.6).fill();
        doc.font('Times-Bold').fontSize(9.6).fillColor(INK);
        let cy = y;
        titleLines.forEach(ln => { doc.text(ln, COL_X + 14, cy, { lineBreak: false }); cy += 12.2; });
        doc.font('Helvetica').fontSize(8.6).fillColor(MUTED);
        issuerLines.forEach(ln => { doc.text(ln, COL_X + 14, cy, { lineBreak: false }); cy += 11; });
      }
      y += titleLines.length * 12.2 + issuerLines.length * 11 + 8;
      linesUsed += titleLines.length + issuerLines.length;
    });
    track('certifications', linesUsed, true);
    y += 6;
  } else track('certifications', 0, false);

  // ── Custom sections (main column) ───────────────────────────────────
  (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar').forEach(cs => {
    y = sectionHeading((cs.title || 'Section'), y);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      cs.items.forEach(item => {
        const lines = wrapLines(doc, String(item), 'Helvetica', 9.4, COL_W - 13);
        if (draw) {
          doc.fillColor(GOLD).rect(COL_X, y + 6, 3, 3).fill();
          doc.font('Helvetica').fontSize(9.4).fillColor(BODY);
          let cy = y;
          lines.forEach(ln => { doc.text(ln, COL_X + 12, cy, { lineBreak: false }); cy += 13.4; });
        }
        y += lines.length * 13.4 + 3;
        linesUsed += lines.length;
      });
    } else if (cs.text) {
      const r = mainPara(cs.text, y);
      y = r.y; linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += 14;
  });

  // ── References ──────────────────────────────────────────────────────
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = sectionHeading(refList.length > 1 ? 'References' : 'Reference', y);
    let linesUsed = 0;
    refList.forEach(ref => {
      const nameLines = wrapLines(doc, ref.name || '', 'Times-Bold', 10.4, COL_W).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Times-Italic', 9.0, COL_W).slice(0, 2) : [];
      if (draw) {
        doc.font('Times-Bold').fontSize(10.4).fillColor(INK);
        let ny = y;
        nameLines.forEach(ln => { doc.text(ln, COL_X, ny, { lineBreak: false }); ny += 14; });
        doc.font('Times-Italic').fontSize(9.0).fillColor(BODY);
        roleLines.forEach(ln => { doc.text(ln, COL_X, ny, { lineBreak: false }); ny += 13; });
      }
      y += nameLines.length * 14 + roleLines.length * 13 + 4;

      // Email / phone: label + value, value wrapped inside its own column.
      const fields = [['EMAIL', ref.email, 36], ['PHONE', ref.phone, 38]].filter(([, v]) => !!v);
      fields.forEach(([label, val, off]) => {
        const valLines = wrapLines(doc, String(val), 'Helvetica', 9.0, COL_W - off);
        if (draw) {
          doc.font('Helvetica-Bold').fontSize(8.2).fillColor(GOLD);
          doc.text(label, COL_X, y + 1, { lineBreak: false });
          doc.font('Helvetica').fontSize(9.0).fillColor(NAVY);
          let vy = y;
          valLines.forEach(ln => { doc.text(ln, COL_X + off, vy, { lineBreak: false }); vy += 13; });
        }
        y += valLines.length * 13;
        linesUsed += valLines.length;
      });
      y += 8;
      linesUsed += nameLines.length + roleLines.length;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: Math.max(y, sy), sections };
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
        underflowLines: Math.round((AVAILABLE_BOTTOM - finalY) / 13.5),
        sections, appliedLevel: level.name, hardOverflow: false,
      };
    }
  }
  const overflowPt = last.finalY - AVAILABLE_BOTTOM;
  const overflowLines = Math.round(overflowPt / 13.5);
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