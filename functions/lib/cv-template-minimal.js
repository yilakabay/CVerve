// functions/lib/cv-template-minimal.js
//
// "Minimal / Scandinavian" CV template. Same measure()/render() contract
// as every other template — see cv-shared.js for the shared helpers.
//
// ── CONTENT SCHEMA ─────────────────────────────────────────────────────
// {
//   name, subtitle, photoBase64,
//   contact: { phone, email, location },        // any field may be omitted
//   education: { degree, school, years, extra },
//   languages: [{ name, level }],
//   profile, skills: string[],
//   experience: [{ org, role, dateRange, bullets: string[] }],
//   achievements: string[],
//   certifications: [{ title, issuer }],
//   references: [{ name, role, email, phone }]   // 0, 1, or many
// }
//
// ── Fit escalation ladder ─────────────────────────────────────────────
// Skills here are already joined into a single wrapped paragraph
// ("JS · Python · SQL"), which is already a fairly dense layout — there's
// no separate "compact skills" step to add on top of that. The ladder is
// just two levels: normal → tight-leading (tighter paragraph/bullet
// leading and smaller inter-section gaps). See
// cv-template-copper-diagonal.js for the full explanation of why render()
// refuses (throws) rather than drawing overlapping/clipped text if even
// the tightened layout still overflows past a small threshold.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;

const MARGIN_L = 56;
const MARGIN_R = 56;
const CONTENT_LEFT = MARGIN_L;
const CONTENT_RIGHT = PAGE_W - MARGIN_R;
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;

const LABEL_COL_W = 108;
const TEXT_COL_X = CONTENT_LEFT + LABEL_COL_W;
const TEXT_COL_W = CONTENT_RIGHT - TEXT_COL_X;

const INK      = '#232326';
const BODY_GRY = '#5A5C62';
const MUTED    = '#96989E';
const HAIRLINE = '#DADBDE';
const ACCENT   = '#B08456';

function layout(doc, content, { draw, stretchPerGap = 0, tightLeading = false } = {}) {
  const sections = [];
  let y = 0;

  function track(name, linesUsed, present) {
    sections.push({ name, linesUsed, present });
  }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    const floor = size + 2.2;
    return Math.max(floor, Math.round(leading * 0.86 * 10) / 10);
  };
  const tightenGap = (gap) => tightLeading ? Math.round(gap * 0.6) : gap;

  const TOP = 58;
  if (draw) {
    doc.font('Helvetica').fontSize(30).fillColor(INK);
    doc.text(content.name || '', CONTENT_LEFT, TOP, { lineBreak: false });
    doc.strokeColor(ACCENT).lineWidth(1.4)
      .moveTo(CONTENT_LEFT, TOP + 35).lineTo(CONTENT_LEFT + 46, TOP + 35).stroke();
    doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
    doc.text((content.subtitle || '').toUpperCase(), CONTENT_LEFT, TOP + 44, { lineBreak: false });
  }

  const PHOTO_R = 32;
  const photoCx = CONTENT_RIGHT - PHOTO_R;
  const photoCy = TOP + 14 + PHOTO_R;
  if (draw && content.photoBase64) {
    try {
      const buf = Buffer.from(content.photoBase64, 'base64');
      doc.save();
      doc.circle(photoCx, photoCy, PHOTO_R).clip();
      doc.image(buf, photoCx - PHOTO_R, photoCy - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
      doc.restore();
    } catch (e) {
      console.error('cv-template-minimal photo error:', e.message);
    }
  }
  if (draw) {
    doc.strokeColor(HAIRLINE).lineWidth(0.9).circle(photoCx, photoCy, PHOTO_R).stroke();
  }

  const HEAD_BOTTOM = TOP + 70;
  if (draw) {
    const ruleEndX = (photoCx - PHOTO_R) - 14;
    doc.strokeColor(HAIRLINE).lineWidth(0.75)
      .moveTo(CONTENT_LEFT, HEAD_BOTTOM).lineTo(ruleEndX, HEAD_BOTTOM).stroke();
  }

  const META_TOP = HEAD_BOTTOM + 20;
  const colW = CONTENT_W / 3;
  const col1 = CONTENT_LEFT, col2 = CONTENT_LEFT + colW, col3 = CONTENT_LEFT + 2 * colW;

  function metaLabel(label, x, yTop) {
    if (!draw) return;
    doc.font('Helvetica').fontSize(8).fillColor(ACCENT);
    doc.text(label.toUpperCase(), x, yTop, { lineBreak: false });
  }
  function metaLine(text, x, yTop, opts = {}) {
    if (!draw) return;
    doc.font(opts.font || 'Helvetica').fontSize(opts.size || 9.3).fillColor(opts.color || INK);
    doc.text(text, x, yTop, { lineBreak: false });
    if (opts.link) doc.link(x, yTop - 2, doc.widthOfString(text), 11, opts.link);
  }

  metaLabel('Contact', col1, META_TOP);
  const contactRows = [
    content.contact?.phone ? { text: content.contact.phone, link: `tel:${content.contact.phone.replace(/\s+/g, '')}` } : null,
    content.contact?.email ? { text: content.contact.email, link: `mailto:${content.contact.email}` } : null,
    content.contact?.location ? { text: content.contact.location, color: BODY_GRY } : null
  ].filter(Boolean);
  contactRows.forEach((row, i) => metaLine(row.text, col1, META_TOP + 15 + i * 13, { link: row.link, color: row.color }));

  metaLabel('Education', col2, META_TOP);
  const eduList = normalizeEducation(content.education);
  const edu0 = eduList[0] || {};
  metaLine(edu0.degree || '', col2, META_TOP + 15);
  metaLine(edu0.school || '', col2, META_TOP + 28, { color: BODY_GRY });
  metaLine(edu0.extra || '', col2, META_TOP + 41, { color: BODY_GRY });

  metaLabel('Languages', col3, META_TOP);
  (content.languages || []).slice(0, 2).forEach((l, i) => {
    metaLine(`${l.name} — ${l.level}`, col3, META_TOP + 15 + i * 13, { color: BODY_GRY });
  });

  const META_BOTTOM = META_TOP + 58;
  if (draw) {
    doc.strokeColor(HAIRLINE).lineWidth(0.75)
      .moveTo(CONTENT_LEFT, META_BOTTOM).lineTo(CONTENT_RIGHT, META_BOTTOM).stroke();
  }

  y = META_BOTTOM + tightenGap(16) + stretchPerGap * 0.6;

  let sectionNum = 0;
  function sectionHeading(label, yTop) {
    sectionNum += 1;
    if (draw) {
      doc.font('Helvetica').fontSize(8.3).fillColor(ACCENT);
      doc.text(String(sectionNum).padStart(2, '0'), CONTENT_LEFT, yTop + 1, { lineBreak: false });
      doc.font('Helvetica').fontSize(11.5).fillColor(INK);
      doc.text(label.toUpperCase(), CONTENT_LEFT + 22, yTop + 1, { lineBreak: false });
    }
    return yTop + (tightLeading ? 20 : 24);
  }

  function bodyParagraph(text, yTop, opts = {}) {
    const size = opts.size || 9.7, leading = tighten(opts.leading || 13.8, size);
    const width = opts.width || TEXT_COL_W, x = opts.x ?? TEXT_COL_X;
    const lines = wrapLines(doc, text, 'Helvetica', size, width);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY_GRY);
      let cur = yTop;
      for (const ln of lines) { doc.text(ln, x, cur, { lineBreak: false }); cur += leading; }
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }

  function bodyBullets(items, yTop, opts = {}) {
    const size = opts.size || 9.7, leading = tighten(opts.leading || 13.8, size);
    const width = opts.width || TEXT_COL_W, x = opts.x ?? TEXT_COL_X;
    let cur = yTop, totalLines = 0;
    for (const item of (items || [])) {
      const lines = wrapLines(doc, item, 'Helvetica', size, width - 12);
      if (draw) {
        doc.fillColor(ACCENT).circle(x + 1.5, cur + size * 0.7, 1.2).fill();
        doc.font('Helvetica').fontSize(size).fillColor(opts.color || BODY_GRY);
        let ly = cur;
        for (const ln of lines) { doc.text(ln, x + 10, ly, { lineBreak: false }); ly += leading; }
      }
      cur += lines.length * leading + (tightLeading ? 1.2 : 2.2);
      totalLines += lines.length;
    }
    return { y: cur, lines: totalLines };
  }

  const GAP = tightenGap(14) + stretchPerGap;

  if (content.profile) {
    y = sectionHeading('Profile', y);
    const r = bodyParagraph(content.profile, y);
    track('profile', r.lines, true);
    y = r.y;
  } else track('profile', 0, false);

  if (content.skills && content.skills.length) {
    y = sectionHeading('Skills', y + GAP);
    const r = bodyParagraph(content.skills.join('   ·   '), y, { leading: tighten(15.5, 9.7) });
    track('skills', r.lines, true);
    y = r.y;
  } else track('skills', 0, false);

  if (content.experience && content.experience.length) {
    y = sectionHeading('Experience', y + GAP);
    let linesUsed = 0;
    for (const exp of content.experience) {
      if (draw) {
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        doc.text(exp.org || '', TEXT_COL_X, y + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(8.8).fillColor(MUTED);
        doc.text(`${exp.role || ''} — ${exp.dateRange || ''}`, TEXT_COL_X, y + 14, { lineBreak: false });
      }
      const r = bodyBullets(exp.bullets || [], y + 26);
      linesUsed += 3 + r.lines;
      y = r.y;
    }
    track('experience', linesUsed, true);
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    y = sectionHeading('Achievements', y + GAP);
    const r = bodyBullets(content.achievements, y);
    track('achievements', r.lines, true);
    y = r.y;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    y = sectionHeading('Certifications', y + GAP);
    let linesUsed = 0;
    for (const cert of content.certifications) {
      const r = bodyParagraph(`${cert.title} — ${cert.issuer}`, y, { leading: tighten(13.8, 9.7) });
      linesUsed += r.lines;
      y = r.y + (tightLeading ? 2.5 : 4);
    }
    track('certifications', linesUsed, true);
  } else track('certifications', 0, false);

  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = sectionHeading(refList.length > 1 ? 'References' : 'Reference', y + GAP);
    let linesUsed = 0;
    refList.forEach((ref, i) => {
      if (draw) {
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        doc.text(ref.name, TEXT_COL_X, y + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(BODY_GRY);
        doc.text(ref.role || '', TEXT_COL_X, y + 15, { lineBreak: false, width: TEXT_COL_W, align: 'right' });
        let lineY = y + 32;
        if (ref.email) {
          doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
          doc.text('EMAIL', TEXT_COL_X, lineY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(ref.email, TEXT_COL_X + 40, lineY, { lineBreak: false });
        }
        if (ref.phone) {
          doc.fillColor(MUTED);
          doc.text('PHONE', TEXT_COL_X + 230, lineY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(ref.phone, TEXT_COL_X + 272, lineY, { lineBreak: false });
        }
      }
      y += tightLeading ? 38 : 46;
      linesUsed += 3;
      if (i < refList.length - 1) y += tightLeading ? 4 : 6;
    });
    track('references', linesUsed, true);
  } else track('references', 0, false);

  return { finalY: y, sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { tightLeading: false } },
  { name: 'tight-leading', opts: { tightLeading: true } }
];
const HARD_OVERFLOW_LINE_THRESHOLD = 3;
const AVAILABLE_BOTTOM = PAGE_H - 40;

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
        underflowPoints: Math.round(available - finalY), underflowLines: Math.round((available - finalY) / 13.8),
        sections, appliedLevel: level.name, hardOverflow: false
      };
    }
  }

  const overflowPt = last.finalY - available;
  const overflowLines = Math.round(overflowPt / 13.8);
  const hardOverflow = overflowLines > HARD_OVERFLOW_LINE_THRESHOLD;

  return {
    fits: false, finalY: last.finalY, availableHeight: available,
    overflowPoints: Math.round(overflowPt), overflowLines,
    underflowPoints: 0, underflowLines: 0,
    sections: last.sections, appliedLevel: last.level, hardOverflow,
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