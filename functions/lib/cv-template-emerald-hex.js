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
    // The photo is clipped to the SAME hexagon shape as its frame (via the
    // shared hexPoints() helper), not a circle — a circular clip left
    // visible gaps at the hexagon's six corners since a circle never
    // reaches the corners of the hexagon it sits inside. The bounding box
    // passed to doc.image (still 2*PHOTO_R square, with cover:true) is
    // unchanged — it's exactly big enough to fully cover the hexagon,
    // which is inscribed within a circle of that same radius.
    if (content.photoBase64) {
      try {
        const buf = Buffer.from(content.photoBase64, 'base64');
        doc.save();
        doc.polygon(...hexPoints(photoCx, photoCy, PHOTO_R)).clip();
        doc.image(buf, photoCx - PHOTO_R, photoCy - PHOTO_R, { width: PHOTO_R * 2, height: PHOTO_R * 2, cover: [PHOTO_R * 2, PHOTO_R * 2] });
        doc.restore();
      } catch (e) { console.error('emerald-hex photo error:', e.message); }
    } else {
      doc.fillColor('#D5D9E0');
      doc.polygon(...hexPoints(photoCx, photoCy, PHOTO_R)).fill();
    }

    const hx = SIDEBAR_W + 24;
    const NAME_TOP = 24;
    // The decorative hexagons and the divider both stop at PAGE_W - 80,
    // not the header's true right edge — so that's the real available
    // width for the name/subtitle too, not R_END/PAGE_W-18.
    const headerAvailW = (PAGE_W - 80) - hx;

    // ── Name: wrap/shrink instead of running off the header ────────────
    // Previously drawn with lineBreak:false and no width, so a long name
    // just ran straight through the decorative hexagons and off the page.
    // Same fix as the other templates: try a size ladder first (a
    // slightly smaller single line beats an early wrap), then wrap onto a
    // second line — capped at 2 — only if even the smallest size can't
    // fit it on one line.
    const NAME_SIZE_LADDER = [32, 28, 24, 22];
    const upperName = (content.name || '').toUpperCase();
    let nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
    let nameLines = null;
    for (const size of NAME_SIZE_LADDER) {
      doc.font('Helvetica-Bold').fontSize(size);
      if (doc.widthOfString(upperName) <= headerAvailW) {
        nameSize = size;
        nameLines = [upperName];
        break;
      }
    }
    if (!nameLines) {
      nameSize = NAME_SIZE_LADDER[NAME_SIZE_LADDER.length - 1];
      doc.font('Helvetica-Bold').fontSize(nameSize);
      nameLines = wrapLines(doc, upperName, 'Helvetica-Bold', nameSize, headerAvailW).slice(0, 2);
    }
    doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(WHITE);
    const nameLineH = doc.currentLineHeight(true);
    let nameBottomY = NAME_TOP;
    nameLines.forEach((ln, i) => {
      const lineY = NAME_TOP + i * nameLineH;
      doc.text(ln, hx, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
      nameBottomY = lineY + nameLineH;
    });

    // This template's header order is name → divider → subtitle → contact
    // (unlike teal-gold's name → subtitle → divider) — kept exactly as
    // designed, just with each piece now cascading off the ACTUAL measured
    // bottom of the one before it instead of a fixed y offset.
    const DIVIDER_Y = nameBottomY + 3;
    doc.strokeColor(GOLD).lineWidth(2).moveTo(hx, DIVIDER_Y).lineTo(PAGE_W - 80, DIVIDER_Y).stroke();

    // ── Subtitle: letter-spaced text, wrapped like the divider's own
    // width instead of running off unbounded ─────────────────────────
    // The letter-spacing (a space inserted between every character)
    // roughly doubles rendered width, so the ORIGINAL text is wrapped
    // first with a conservative shrink factor (breaking at real word
    // boundaries), then letter-spacing is applied per finished line —
    // same approach already used for teal-gold's subtitle. Capped at 2
    // lines; width+ellipsis is a hard backstop underneath this estimate.
    const SUBTITLE_TOP = DIVIDER_Y + 10;
    doc.font('Helvetica').fontSize(10.5).fillColor(GOLD_LT);
    const subtitleLineH = doc.currentLineHeight(true);
    const rawSubtitleLines = wrapLines(doc, content.subtitle || '', 'Helvetica', 10.5, headerAvailW / 1.9).slice(0, 2);
    const spacedSubtitleLines = rawSubtitleLines.map(ln => ln.split('').join(' ').toUpperCase());
    let subtitleBottomY = SUBTITLE_TOP;
    if (spacedSubtitleLines.length) {
      spacedSubtitleLines.forEach((ln, i) => {
        const lineY = SUBTITLE_TOP + i * subtitleLineH;
        doc.text(ln, hx, lineY, { lineBreak: false, width: headerAvailW, ellipsis: true });
        subtitleBottomY = lineY + subtitleLineH;
      });
    } else {
      subtitleBottomY = SUBTITLE_TOP + subtitleLineH;
    }

    // Contact row: any missing field (phone/email/location) is simply
    // absent from content.contact, so .filter(Boolean) already drops it
    // and no orphan label/icon is drawn for it. Its row position now
    // derives from subtitleBottomY instead of a fixed constant, so it
    // moves down together with a wrapped name/subtitle rather than
    // overlapping them — and the hex bullet and its text still share this
    // one cy2 value, so they can never end up out of sync with each other.
    const cy2 = subtitleBottomY + 12;
    let cx = hx;
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
  // Bulleted list in the sidebar — same small-hexagon-plus-wrapped-text
  // shape as SKILLS — used for any custom sidebar section given as a list
  // rather than a paragraph. Every line goes through wrapLines against
  // the real sidebar width, so it can't overflow the sidebar.
  function lbullets(items, yTop) {
    const size = 8.5;
    let cur = yTop, total = 0;
    (items || []).forEach(item => {
      const lines = wrapLines(doc, String(item), 'Helvetica', size, SIDEBAR_W - L_PAD * 2 - 12);
      if (draw) {
        hexagon(doc, L_PAD + 4, cur + 5, 3, GOLD);
        doc.font('Helvetica').fontSize(size).fillColor(WHITE);
        let ly = cur;
        lines.forEach(ln => { doc.text(ln, L_PAD + 13, ly, { lineBreak: false }); ly += size * 1.45; });
        cur = ly;
      } else {
        cur += lines.length * size * 1.45;
      }
      cur += 2;
      total += lines.length;
    });
    return { y: cur, lines: total };
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
  y += 6;

  // ── Custom sidebar sections ──────────────────────────────────────────
  // A user can ask the AI to add a section not in the fixed schema (e.g.
  // "Academic Projects", "Hobbies"). Entries in content.customSections
  // with placement:'sidebar' get their own heading + wrapped content here,
  // via the same lsec/lnorm/lbullets helpers (and therefore the same
  // width-safe wrapping) as every built-in sidebar section — so they
  // can't overflow the sidebar any more than SKILLS or LANGUAGES can.
  (content.customSections || []).filter(cs => cs && cs.placement === 'sidebar').forEach(cs => {
    y = lsec((cs.title || 'Section').toUpperCase(), y) + 4;
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r = lbullets(cs.items, y);
      y = r.y;
      linesUsed = r.lines;
    } else if (cs.text) {
      const before = y;
      y = lnorm(cs.text, y);
      linesUsed = Math.round((y - before) / (8.5 * 1.4)) || 1;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    y += 6 + stretchPerGap;
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

  // ── Custom main-column sections ──────────────────────────────────────
  // Same idea as the sidebar version above, but for content that fits
  // better in the wide right column. Every entry with placement !==
  // 'sidebar' (including no placement at all — main is the default) lands
  // here, via rsec/rpara/rbullets so it gets the same wrapping, leading
  // and tight-leading/compaction behavior as EXPERIENCE/ACHIEVEMENT, and
  // the same per-section line tracking so overflow detection and the fit
  // recommendation both already account for it automatically.
  (content.customSections || []).filter(cs => cs && cs.placement !== 'sidebar').forEach(cs => {
    ry = rsec((cs.title || 'Section').toUpperCase(), ry);
    let linesUsed = 0;
    if (cs.items && cs.items.length) {
      const r4 = rbullets(cs.items, ry);
      ry = r4.y;
      linesUsed = r4.lines;
    } else if (cs.text) {
      const r4 = rpara(cs.text, ry);
      ry = r4.y;
      linesUsed = r4.lines;
    }
    track(`custom:${cs.title || 'Section'}`, linesUsed, true);
    ry += tightenGap(12) + GS;
  });

  // References: content.references is an array (1, 2, 3+ — no cap).
  // Cards are laid out side by side, own width dividing evenly by count.
  //
  // Each card now measures its OWN real content height instead of a fixed
  // 58pt — a long role/title used to run straight into the Email/Phone
  // lines below it (fixed offsets: ry+29, ry+42) since neither the box
  // nor those offsets accounted for wrapping. Role now wraps properly;
  // Email/Phone now wrap onto additional lines too (instead of being
  // truncated with "…" via PDFKit's lineBreak:false+width+ellipsis, which
  // turned out to still wrap unpredictably once a width was supplied —
  // same fix already applied to copper-diagonal). And a long field in one
  // card no longer forces the shorter cards next to it to stretch to
  // match — only the row's overall footprint (rowH, used to advance ry
  // afterward) uses the max; each card is drawn at its own height.
  const refList = normalizeReferences(content.references || content.reference);
  if (refList.length) {
    ry = rsec('REFERENCE' + (refList.length > 1 ? 'S' : ''), ry);
    const gap = 8;
    const cardW = (RIGHT_W + 8 - gap * (refList.length - 1)) / refList.length;
    const PAD = 12;
    const NAME_SIZE = 10.5, ROLE_SIZE = 9.5, FIELD_SIZE = 9;
    const NAME_LH = NAME_SIZE * 1.3, ROLE_LH = ROLE_SIZE * 1.35, FIELD_LH = 13.5;
    const EMAIL_OFFSET_X = 40, PHONE_OFFSET_X = 42;

    function wrapField(value, offsetX) {
      if (!value) return [];
      return wrapLines(doc, String(value), 'Helvetica', FIELD_SIZE, cardW - PAD - offsetX);
    }

    const refBlocks = refList.map(ref => {
      const nameLines = wrapLines(doc, ref.name || '', 'Helvetica-Bold', NAME_SIZE, cardW - PAD).slice(0, 2);
      const roleLines = ref.role ? wrapLines(doc, ref.role, 'Helvetica', ROLE_SIZE, cardW - PAD).slice(0, 4) : [];
      const emailLines = wrapField(ref.email, EMAIL_OFFSET_X);
      const phoneLines = wrapField(ref.phone, PHONE_OFFSET_X);
      let h = 5 + nameLines.length * NAME_LH + 3;
      if (roleLines.length) h += roleLines.length * ROLE_LH + 4;
      h += emailLines.length * FIELD_LH;
      h += phoneLines.length * FIELD_LH;
      return { ref, nameLines, roleLines, emailLines, phoneLines, h: Math.max(h, 54) };
    });
    const rowH = Math.max(...refBlocks.map(b => b.h));

    refBlocks.forEach((block, i) => {
      const { nameLines, roleLines, emailLines, phoneLines, h } = block;
      const bx = R_START - 8 + i * (cardW + gap);
      if (draw) {
        doc.roundedRect(bx, ry - 4, cardW, h, 5).fill(WHITE);
        doc.roundedRect(bx, ry - 4, cardW, h, 5).lineWidth(0.6).stroke(EMERALD);
        doc.roundedRect(bx, ry - 4, 5, h, 3).fill(EMERALD);

        let cy = ry + 1;
        doc.font('Helvetica-Bold').fontSize(NAME_SIZE).fillColor(EMERALD);
        nameLines.forEach(ln => { doc.text(ln, bx + 8, cy, { lineBreak: false }); cy += NAME_LH; });
        cy += 3;

        if (roleLines.length) {
          doc.font('Helvetica').fontSize(ROLE_SIZE).fillColor(BODY);
          roleLines.forEach(ln => { doc.text(ln, bx + 8, cy, { lineBreak: false }); cy += ROLE_LH; });
          cy += 4;
        }

        if (emailLines.length) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(EMERALD);
          doc.text('Email:', bx + 8, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          emailLines.forEach(ln => { doc.text(ln, bx + EMAIL_OFFSET_X, cy, { lineBreak: false }); cy += FIELD_LH; });
        }
        if (phoneLines.length) {
          doc.font('Helvetica-Bold').fontSize(FIELD_SIZE).fillColor(EMERALD);
          doc.text('Phone:', bx + 8, cy, { lineBreak: false });
          doc.font('Helvetica').fontSize(FIELD_SIZE).fillColor(BODY);
          phoneLines.forEach(ln => { doc.text(ln, bx + PHONE_OFFSET_X, cy, { lineBreak: false }); cy += FIELD_LH; });
        }
      }
    });

    const linesUsed = refBlocks.reduce((sum, b) =>
      sum + b.nameLines.length + b.roleLines.length + b.emailLines.length + b.phoneLines.length, 0);
    track('references', linesUsed, true);
    ry += rowH;
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