// functions/lib/cv-template-emerald-hex.js
//
// "Emerald & Gold Hexagon" CV template — ported from the original
// ReportLab design: an emerald sidebar, a dark-emerald header with a
// diagonal cream cut and decorative hexagons, a hexagon-framed photo, and
// a timeline-styled experience section. Same measure()/render() contract
// as every other template.
//
// ── Fit escalation ladder ─────────────────────────────────────────────
// measure() tries three levels, LEAST visually invasive first, and only
// moves to the next if the previous one still overflows the page:
//   1. normal                        — template's default one-per-line skills
//   2. compact-skills                — skills flow side-by-side (flex-wrap)
//   3. compact-skills+tight-leading  — also tightens bullet/paragraph leading
// None of these change or remove any of the user's content — they're pure
// rendering-density choices. If even the most compact level still overflows
// by more than a small, genuinely-crowded threshold, render() REFUSES to
// produce a PDF (throws, rather than drawing overlapping/clipped text) and
// hands back a specific, concrete recommendation for what to cut.

const { PDFDocument, measureDoc, wrapLines, normalizeEducation, normalizeReferences, proficiencyToFill, flowItems, buildFitRecommendation } = require('./cv-shared');

const PAGE_W = 595.28, PAGE_H = 841.89;
const EMERALD = '#0D5447', EM_DARK = '#082E25', EM_MID = '#155B4E';
const CREAM = '#FAF2E0', GOLD = '#D1A633', GOLD_LT = '#F5E8B8';
const BODY = '#2E3339', MID = '#7A828C', WHITE = '#FFFFFF';

const HEADER_H = 185.0, SIDEBAR_W = 205.0, L_PAD = 20.0;
const R_START = SIDEBAR_W + 20.0, R_END = PAGE_W - 18.0, RIGHT_W = R_END - R_START;
const PHOTO_R = 58.0;
const AVAILABLE_BOTTOM = PAGE_H - 30;

function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return pts;
}
function hexagon(doc, cx, cy, r, color) {
  doc.polygon(...hexPoints(cx, cy, r)).fill(color);
}

function layout(doc, content, { draw, stretchPerGap = 0, compactSkills = false, tightLeading = false } = {}) {
  const sections = [];
  function track(name, linesUsed, present) { sections.push({ name, linesUsed, present }); }

  const tighten = (leading, size) => {
    if (!tightLeading) return leading;
    const floor = size + 2.2;
    return Math.max(floor, Math.round(leading * 0.86 * 10) / 10);
  };
  const tightenGap = (gap) => tightLeading ? Math.round(gap * 0.6) : gap;

  if (draw) {
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(CREAM);
    doc.rect(0, 0, SIDEBAR_W, PAGE_H).fill(EMERALD);
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(EM_DARK);
    doc.polygon([SIDEBAR_W, 0], [PAGE_W, 55], [PAGE_W, 0]).fill(CREAM);
    doc.rect(0, 0, SIDEBAR_W, HEADER_H).fill(EMERALD);
    doc.polygon([SIDEBAR_W, 0], [SIDEBAR_W + 6, 0], [PAGE_W, 59], [PAGE_W, 65]).fill(GOLD);

    hexagon(doc, PAGE_W - 38, 28, 22, EM_MID);
    hexagon(doc, PAGE_W - 22, 54, 14, EMERALD);
    hexagon(doc, PAGE_W - 58, 52, 12, '#0F6154');

    const photoCx = SIDEBAR_W / 2, photoCy = HEADER_H / 2 - 4;
    hexagon(doc, photoCx, photoCy, PHOTO_R + 10, GOLD);
    hexagon(doc, photoCx, photoCy, PHOTO_R + 6, WHITE);
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.circle(photoCx, photoCy, PHOTO_R).clip();
        doc.image(buf, photoCx - PHOTO_R, photoCy - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('emerald-hex photo error:', e.message); }
    } else {
      doc.fillColor('#D5D9E0').circle(photoCx, photoCy, PHOTO_R).fill();
    }

    const hx = SIDEBAR_W + 24;
    doc.font('Helvetica-Bold').fontSize(32).fillColor(WHITE);
    doc.text((content.name || '').toUpperCase(), hx, 24, { lineBreak: false });
    doc.strokeColor(GOLD).lineWidth(2).moveTo(hx, 64).lineTo(PAGE_W - 80, 64).stroke();
    doc.font('Helvetica').fontSize(10.5).fillColor(GOLD_LT);
    doc.text((content.subtitle || '').split('').join(' ').toUpperCase(), hx, 74, { lineBreak: false });

    let cx = hx, cy2 = 98;
    doc.font('Helvetica').fontSize(8.5);
    [content.contact?.phone, content.contact?.email, content.contact?.location].filter(Boolean).forEach(txt => {
      const tw = doc.widthOfString(txt);
      hexagon(doc, cx + 4, cy2 - 2, 3.5, GOLD);
      doc.fillColor(WHITE).text(txt, cx + 12, cy2 - 5, { lineBreak: false });
      cx += tw + 24;
    });
  }

  function lsec(label, yTop) {
    if (draw) {
      hexagon(doc, L_PAD + 4, yTop + 5, 5, GOLD);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(WHITE);
      doc.text(label, L_PAD + 14, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(0.8).moveTo(L_PAD, yTop + 14).lineTo(SIDEBAR_W - L_PAD, yTop + 14).stroke();
    }
    return yTop + 22;
  }
  function lbold(text, yTop) {
    const size = 9;
    const lines = wrapLines(doc, text, 'Helvetica-Bold', size, SIDEBAR_W - L_PAD * 2);
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(WHITE);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD, cur, { lineBreak: false }); cur += size * 1.4; });
    }
    return yTop + lines.length * size * 1.4;
  }
  function lnorm(text, yTop, indent = 0) {
    const size = 8.5;
    const lines = wrapLines(doc, text, 'Helvetica', size, SIDEBAR_W - L_PAD * 2 - indent);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(GOLD_LT);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, L_PAD + indent, cur, { lineBreak: false }); cur += size * 1.4; });
    }
    return yTop + lines.length * size * 1.4;
  }

  let y = HEADER_H + 16;
  y = lsec('EDUCATION', y) + 2;
  const eduList = normalizeEducation(content.education);
  eduList.slice(0, 2).forEach(edu => {
    if (draw) { doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD); doc.text(edu.dateRange || '', L_PAD, y + 7, { lineBreak: false }); }
    y += 12;
    y = lbold((edu.school || '').toUpperCase(), y);
    if (edu.degree) y = lnorm(edu.degree, y, 6);
    if (edu.extra) y = lnorm(edu.extra, y, 6);
    y += 10;
  });
  y += 4;

  y = lsec('SKILLS', y) + 4;
  if (compactSkills) {
    const skillsResult = flowItems(doc, content.skills || [], L_PAD + 8, y, SIDEBAR_W - L_PAD * 2 - 8, {
      font: 'Helvetica', size: 8.8, color: WHITE,
      gapX: 10, gapY: 13,
      bulletColor: GOLD, bulletSize: 4, bulletGap: 6,
      draw
    });
    y = skillsResult.y;
    track('skills', skillsResult.lines, (content.skills || []).length > 0);
  } else {
    let skillLines = 0;
    (content.skills || []).forEach(sk => {
      const lines = wrapLines(doc, sk, 'Helvetica', 8.8, SIDEBAR_W - L_PAD * 2 - 12);
      if (draw) {
        hexagon(doc, L_PAD + 4, y + 5, 3, GOLD);
        doc.font('Helvetica').fontSize(8.8).fillColor(WHITE);
        let cur = y;
        lines.forEach(ln => { doc.text(ln, L_PAD + 13, cur, { lineBreak: false }); cur += 12.5; });
        y = cur;
      } else { y += lines.length * 12.5; }
      y += 2;
      skillLines += lines.length;
    });
    track('skills', skillLines, (content.skills || []).length > 0);
  }
  y += 4 + stretchPerGap;

  y = lsec('LANGUAGES', y) + 4;
  (content.languages || []).forEach((l) => {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
      doc.text(l.name, L_PAD, y + 7.5, { lineBreak: false });
      const lw = doc.widthOfString(l.name);
      doc.font('Helvetica').fontSize(8).fillColor(GOLD_LT);
      doc.text(`(${l.level})`, L_PAD + lw + 5, y + 7, { lineBreak: false });
    }
    y += 13;
    const fillPct = proficiencyToFill(l.level);
    if (draw) {
      const bw = SIDEBAR_W - L_PAD * 2;
      doc.roundedRect(L_PAD, y + 5, bw, 5.5, 2.5).fill('#0A3F35');
      doc.roundedRect(L_PAD, y + 5, bw * fillPct, 5.5, 2.5).fill(GOLD);
    }
    y += 16;
  });

  function rsec(label, yTop) {
    if (draw) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(EMERALD);
      doc.text(label, R_START, yTop + 1, { lineBreak: false });
      doc.strokeColor(GOLD).lineWidth(1.5).moveTo(R_START, yTop + 14).lineTo(R_END, yTop + 14).stroke();
    }
    return yTop + 24;
  }
  function rpara(text, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 14.5, size);
    const lines = wrapLines(doc, text, 'Helvetica', size, RIGHT_W);
    if (draw) {
      doc.font('Helvetica').fontSize(size).fillColor(BODY);
      let cur = yTop;
      lines.forEach(ln => { doc.text(ln, R_START, cur, { lineBreak: false }); cur += leading; });
    }
    return { y: yTop + lines.length * leading, lines: lines.length };
  }
  function rbullets(items, yTop, opts = {}) {
    const size = opts.size || 9.5, leading = tighten(opts.leading || 13.5, size);
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, item, 'Helvetica', size, RIGHT_W - 14);
      if (draw) {
        hexagon(doc, R_START + 4, cur + size * 0.35, 3.5, EMERALD);
        doc.font('Helvetica').fontSize(size).fillColor(BODY);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, R_START + 14, ly, { lineBreak: false }); ly += leading; });
      }
      cur += lines.length * leading + (tightLeading ? 1.5 : 3.5);
      total += lines.length;
    });
    return { y: cur, lines: total };
  }

  let ry = HEADER_H + 18;
  const GS = stretchPerGap;

  if (content.profile) {
    ry = rsec('PROFILE', ry);
    if (draw) doc.fillColor(EMERALD).rect(R_START - 8, ry - 2, 3, 54).fill();
    const r = rpara(content.profile, ry);
    track('profile', r.lines, true);
    ry = r.y + tightenGap(14) + GS;
  } else track('profile', 0, false);

  if (content.experience && content.experience.length) {
    ry = rsec('EXPERIENCE', ry);
    let linesUsed = 0;
    content.experience.forEach(exp => {
      if (draw) {
        doc.fillColor(GOLD).circle(R_START - 3, ry + 9, 4.5).fill();
        doc.strokeColor(GOLD).lineWidth(1).dash(2, { space: 3 }).moveTo(R_START - 3, ry + 14).lineTo(R_START - 3, ry + 50).stroke();
        doc.undash();
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(EMERALD);
        doc.text(exp.org || '', R_START + 8, ry + 1, { lineBreak: false });
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MID);
        const dw = doc.widthOfString(exp.dateRange || '');
        doc.text(exp.dateRange || '', R_END - dw, ry + 1, { lineBreak: false });
      }
      ry += 13;
      if (draw) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(GOLD); doc.text(exp.role || '', R_START + 8, ry, { lineBreak: false }); }
      ry += 13;
      const r2 = rbullets(exp.bullets || [], ry);
      linesUsed += 2 + r2.lines;
      ry = r2.y;
    });
    track('experience', linesUsed, true);
    ry += tightenGap(12) + GS;
  } else track('experience', 0, false);

  if (content.achievements && content.achievements.length) {
    ry = rsec('ACHIEVEMENT', ry);
    const r3 = rbullets(content.achievements, ry);
    track('achievements', r3.lines, true);
    ry = r3.y + tightenGap(12) + GS;
  } else track('achievements', 0, false);

  if (content.certifications && content.certifications.length) {
    ry = rsec('CERTIFICATIONS & RECOGNITION', ry);
    let linesUsed = 0;
    const certLeading = tighten(13.5, 9.5);
    content.certifications.forEach((cert, i) => {
      const full = `${cert.title} | ${cert.issuer}`;
      const lines = wrapLines(doc, full, 'Helvetica', 9.5, RIGHT_W - 16);
      if (draw) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GOLD);
        doc.text(`${i + 1}.`, R_START, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        let ly = ry;
        lines.forEach(ln => { doc.text(ln, R_START + 16, ly, { lineBreak: false }); ly += certLeading; });
        ry = ly;
      } else { ry += lines.length * certLeading; }
      linesUsed += lines.length;
      ry += tightLeading ? 2 : 5;
    });
    track('certifications', linesUsed, true);
    ry += tightenGap(8) + GS;
  } else track('certifications', 0, false);

  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = rsec('REFERENCE' + (refList.length > 1 ? 'S' : ''), ry);
    const cardH = 58, gap = 8;
    const cardW = (RIGHT_W + 8 - gap * (refList.length - 1)) / refList.length;
    refList.forEach((ref, i) => {
      const bx = R_START - 8 + i * (cardW + gap);
      if (draw) {
        doc.roundedRect(bx, ry - 4, cardW, cardH + 4, 5).fill(WHITE);
        doc.roundedRect(bx, ry - 4, cardW, cardH + 4, 5).lineWidth(0.6).stroke(EMERALD);
        doc.roundedRect(bx, ry - 4, 5, cardH + 4, 3).fill(EMERALD);
        const nameLines = wrapLines(doc, ref.name, 'Helvetica-Bold', 10.5, cardW - 12);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(EMERALD);
        doc.text(nameLines[0] || '', bx + 8, ry + 1, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
        doc.text(ref.role || '', bx + 8, ry + 15, { lineBreak: false, width: cardW - 16, ellipsis: true });
        if (ref.email) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(EMERALD);
          doc.text('Email:', bx + 8, ry + 29, { lineBreak: false });
          doc.font('Helvetica').fontSize(9).fillColor(BODY);
          doc.text(ref.email, bx + 40, ry + 29, { lineBreak: false, width: cardW - 46, ellipsis: true });
        }
        if (ref.phone) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(EMERALD);
          doc.text('Phone:', bx + 8, ry + 42, { lineBreak: false });
          doc.font('Helvetica').fontSize(9).fillColor(BODY);
          doc.text(ref.phone, bx + 42, ry + 42, { lineBreak: false });
        }
      }
    });
    track('references', 4, true);
    ry += 60;
  } else track('references', 0, false);

  return { finalY: Math.max(y, ry), sections };
}

const FIT_LEVELS = [
  { name: 'normal', opts: { compactSkills: false, tightLeading: false } },
  { name: 'compact-skills', opts: { compactSkills: true, tightLeading: false } },
  { name: 'compact-skills+tight-leading', opts: { compactSkills: true, tightLeading: true } }
];
const HARD_OVERFLOW_LINE_THRESHOLD = 3;

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
        underflowPoints: Math.round(available - finalY), underflowLines: Math.round((available - finalY) / 13.5),
        sections, appliedLevel: level.name, hardOverflow: false
      };
    }
  }

  const overflowPt = last.finalY - available;
  const overflowLines = Math.round(overflowPt / 13.5);
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