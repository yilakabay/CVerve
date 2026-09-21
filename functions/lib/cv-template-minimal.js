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
//   references: [{ name, role, email, phone }],  // 0, 1, or many
//   customSections: [{ title, items, text }]      // extra AI/user-added sections
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

const { PDFDocument, measureDoc, wrapLines, truncateToFit, normalizeEducation, normalizeReferences, buildFitRecommendation } = require('./cv-shared');

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
  const PHOTO_R = 32;
  const photoCx = CONTENT_RIGHT - PHOTO_R;
  const photoCy = TOP + 14 + PHOTO_R;
  // How far the name/subtitle/accent rule are allowed to extend before
  // running into the photo — everything in the header wraps or shrinks
  // against this same width.
  const ruleEndX = (photoCx - PHOTO_R) - 14;
  const headerAvailW = ruleEndX - CONTENT_LEFT;

  let headBottom = TOP + 70; // fallback; overwritten below when draw is true
  if (draw) {
    // ── Name: shrink through a size ladder, then wrap up to 2 lines if
    // even the smallest size can't fit — previously drawn with
    // lineBreak:false and no width at all, so a long name could run
    // straight into the photo. Everything below (the accent underline,
    // subtitle, and the full-width hairline before the meta strip) now
    // cascades off the ACTUAL measured bottom of the name/subtitle
    // instead of fixed y offsets, the same fix already applied to every
    // other template's header.
    const NAME_SIZE_LADDER = [30, 26, 23, 20];
    const nameText = content.name || '';
    let nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
    let nameLines = null;
    for (const s of NAME_SIZE_LADDER) {
      doc.font('Helvetica').fontSize(s);
      if (doc.widthOfString(nameText) <= headerAvailW) { nameSize = s; nameLines = [nameText]; break; }
    }
    if (!nameLines) {
      nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
      doc.font('Helvetica').fontSize(nameSize);
      nameLines = wrapLines(doc, nameText, 'Helvetica', nameSize, headerAvailW).slice(0, 2);
    }
    doc.font('Helvetica').fontSize(nameSize).fillColor(INK);
    const nameLineH = doc.currentLineHeight(true);
    let nameBottomY = TOP;
    nameLines.forEach((ln, i) => {
      const lineY = TOP + i * nameLineH;
      doc.text(ln, CONTENT_LEFT, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
      nameBottomY = lineY + nameLineH;
    });

    const ACCENT_Y = nameBottomY + 1;
    doc.strokeColor(ACCENT).lineWidth(1.4)
      .moveTo(CONTENT_LEFT, ACCENT_Y).lineTo(CONTENT_LEFT + 46, ACCENT_Y).stroke();

    const SUBTITLE_TOP = ACCENT_Y + 9;
    doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
    const subtitleLineH = doc.currentLineHeight(true);
    const subtitleLines = wrapLines(doc, (content.subtitle || '').toUpperCase(), 'Helvetica', 9.3, headerAvailW).slice(0, 2);
    let subtitleBottomY = SUBTITLE_TOP;
    if (subtitleLines.length) {
      subtitleLines.forEach((ln, i) => {
        const lineY = SUBTITLE_TOP + i * subtitleLineH;
        doc.text(ln, CONTENT_LEFT, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    headBottom = subtitleBottomY + 15;
    doc.strokeColor(HAIRLINE).lineWidth(0.75)
      .moveTo(CONTENT_LEFT, headBottom).lineTo(ruleEndX, headBottom).stroke();
  }
  const HEAD_BOTTOM = headBottom;

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

  const META_TOP = HEAD_BOTTOM + 20;
  const colW = CONTENT_W / 3;
  const col1 = CONTENT_LEFT, col2 = CONTENT_LEFT + colW, col3 = CONTENT_LEFT + 2 * colW;
  // Every meta-strip line MUST stay single-line and inside its own
  // column — there's no room to wrap without running into the next
  // column or the ones below it. Previously these were drawn with no
  // width bound at all, so a long phone number, email, degree name, or
  // language label could bleed straight into the neighboring column.
  const META_COL_MAX_W = colW - 10;

  function metaLabel(label, x, yTop) {
    if (!draw) return;
    doc.font('Helvetica').fontSize(8).fillColor(ACCENT);
    doc.text(label.toUpperCase(), x, yTop, { lineBreak: false });
  }
  function metaLine(text, x, yTop, opts = {}) {
    if (!draw || !text) return;
    const font = opts.font || 'Helvetica', size = opts.size || 9.3;
    const safe = truncateToFit(doc, text, font, size, META_COL_MAX_W);
    doc.font(font).fontSize(size).fillColor(opts.color || INK);
    doc.text(safe, x, yTop, { lineBreak: false });
    if (opts.link) doc.link(x, yTop - 2, doc.widthOfString(safe), 11, opts.link);
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

  function sectionHeading(label, yTop) {
    if (draw) {
      doc.font('Helvetica').fontSize(11.5).fillColor(INK);
      doc.text(label.toUpperCase(), CONTENT_LEFT, yTop + 1, { lineBreak: false });
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
      // Org name and the "Role — dateRange" line both stay single-line by
      // design (the bullets below carry the detail), so a value too long
      // to fit is truncated rather than left to run off the page — the
      // same reasoning as the meta-strip columns above.
      if (draw) {
        const orgSafe = truncateToFit(doc, exp.org || '', 'Helvetica', 9.7, TEXT_COL_W);
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        doc.text(orgSafe, TEXT_COL_X, y + 1, { lineBreak: false });
        const roleDate = `${exp.role || ''} — ${exp.dateRange || ''}`;
        const roleDateSafe = truncateToFit(doc, roleDate, 'Helvetica-Oblique', 8.8, TEXT_COL_W);
        doc.font('Helvetica-Oblique').fontSize(8.8).fillColor(MUTED);
        doc.text(roleDateSafe, TEXT_COL_X, y + 14, { lineBreak: false });
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

  // ── Custom sections ───────────────────────────────────────────────────
  // A user can ask the AI to add a section not in the fixed schema (e.g.
  // "Academic Projects", "Hobbies"). This template has a single column —
  // no sidebar/main split — so every entry in content.customSections
  // (regardless of any placement hint) lands here, via the same
  // sectionHeading/bodyBullets/bodyParagraph helpers as every built-in
  // section, getting the same width-safe wrapping.
  (content.customSections || []).forEach(cs => {
    y = sectionHeading((cs.title || 'Section'), y + GAP);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = bodyBullets(cs.items, y);
      y = r.y;
      linesUsed = r.lines;
    } else if (cs.text) {
      const r = bodyParagraph(cs.text, y);
      y = r.y;
      linesUsed = r.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
  });

  // References: content.references is an array (1, 2, 3+ — no cap). Name
  // now wraps (up to 2 lines) instead of running unbounded, role wraps
  // against the full text-column width, and each reference's actual
  // measured height (not a fixed 46pt constant) determines how far y
  // advances — so a wrapped name/role can no longer overlap the next
  // reference below it. Email/Phone stay side-by-side as designed, but
  // are now truncated to fit their fixed sub-columns instead of being
  // drawn with no width bound at all — which is what let a long email
  // run straight into "PHONE" next to it.
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    y = sectionHeading(refList.length > 1 ? 'References' : 'Reference', y + GAP);
    let linesUsed = 0;
    const EMAIL_LABEL_X = TEXT_COL_X, EMAIL_VALUE_X = TEXT_COL_X + 40;
    const PHONE_LABEL_X = TEXT_COL_X + 230, PHONE_VALUE_X = TEXT_COL_X + 272;
    const EMAIL_VALUE_MAX_W = PHONE_LABEL_X - EMAIL_VALUE_X - 6;
    const PHONE_VALUE_MAX_W = CONTENT_RIGHT - PHONE_VALUE_X - 2;

    refList.forEach((ref, i) => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica', 9.7, TEXT_COL_W).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Helvetica', 9, TEXT_COL_W).slice(0, 2) : [];

      if (draw) {
        doc.font('Helvetica').fontSize(9.7).fillColor(INK);
        let ny = y + 1;
        nameLines.forEach(ln => { doc.text(ln, TEXT_COL_X, ny, { lineBreak: false }); ny += 14; });

        let ly = ny + 1;
        if (roleLines.length) {
          doc.font('Helvetica').fontSize(9).fillColor(BODY_GRY);
          roleLines.forEach(ln => { doc.text(ln, TEXT_COL_X, ly, { lineBreak: false }); ly += 13; });
        }

        const fieldY = ly + 3;
        if (ref.email) {
          const emailSafe = truncateToFit(doc, ref.email, 'Helvetica', 9.3, EMAIL_VALUE_MAX_W);
          doc.font('Helvetica').fontSize(9.3).fillColor(MUTED);
          doc.text('EMAIL', EMAIL_LABEL_X, fieldY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(emailSafe, EMAIL_VALUE_X, fieldY, { lineBreak: false });
        }
        if (ref.phone) {
          const phoneSafe = truncateToFit(doc, ref.phone, 'Helvetica', 9.3, PHONE_VALUE_MAX_W);
          doc.fillColor(MUTED);
          doc.text('PHONE', PHONE_LABEL_X, fieldY, { lineBreak: false });
          doc.fillColor(INK);
          doc.text(phoneSafe, PHONE_VALUE_X, fieldY, { lineBreak: false });
        }
      }

      // Height for this entry: name lines (14pt each) + role lines (13pt
      // each, plus a small gap) + the email/phone row (if either present)
      // + trailing breathing room — mirrors exactly what was drawn above.
      let entryH = nameLines.length * 14 + 1;
      if (roleLines.length) entryH += roleLines.length * 13 + 1;
      if (ref.email || ref.phone) entryH += 3 + 13;
      entryH += tightLeading ? 10 : 16;

      y += entryH;
      linesUsed += nameLines.length + roleLines.length + (ref.email ? 1 : 0) + (ref.phone ? 1 : 0);
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