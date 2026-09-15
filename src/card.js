import fs from 'node:fs';
import sharp from 'sharp';
import { clampScore, verdictBand } from './verdict.js';

/**
 * Share card — "A.S.S. SCORE" branded 16:9 poster (1600×900), server-side
 * rendered as deterministic PNG per scan (the viral loop).
 *
 * Approach: compose a deterministic SVG string and rasterize it to PNG with
 * sharp (libvips' built-in librsvg SVG loader). No headless browser, no
 * screenshot: cheap, fast, deterministic (same inputs -> identical PNG bytes),
 * and works anywhere sharp's prebuilt binaries run (Node 20 / linux-x64).
 *
 * FONTS (owner re-spec 2026-09-15): the poster uses Anton (display), Caveat
 * (annotations) and Inter (body). librsvg does NOT load @font-face data-URI
 * fonts, so these ship as committed TTF files (src/assets/fonts/) that the
 * Dockerfile registers with fontconfig (`/usr/share/fonts/assscore` +
 * `fc-cache -f`); the SVG references them by family name + font-weight, and
 * librsvg resolves them through fontconfig at render time. On hosts where the
 * fonts are not installed the card still renders deterministically, just with
 * the fallback sans (DejaVu) — the layout is font-independent.
 *
 * Direction (product-locked): HIGHER score = WORSE. 0 = clean/good, 100 =
 * maximum ass. The poster says so four ways at once: score color (green→red),
 * the band stamp, the `0 = LEAST ASS / 100 = MAX ASS` scale strip with the
 * you-are-here marker, and the donkey's message on the paper sign.
 *
 * NO report content is ever rendered: no categories, findings, roasts, scan
 * ids, timestamps, pricing or agency branding (owner hard requirement).
 */

/** Poster size — 16:9 (owner re-spec 2026-09-15). */
export const CARD_WIDTH = 1600;
export const CARD_HEIGHT = 900;

/** Mandated disclaimer, verbatim (same string as the HTML report). */
export const DISCLAIMER =
  'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';

/** Disclaimer wrapped into two fixed lines that fit the poster footer at 10px. */
const DISCLAIMER_LINES = [
  'This tool identifies writing and design patterns commonly associated with generic or templated content.',
  'It does not detect AI authorship and is not proof that any content was AI-generated.',
];

/**
 * Donkey mascot (canonical bust, owner-locked). Embedded as a data-URI so the
 * card is fully self-contained and byte-deterministic on every host.
 * The same image is used for every band — never tinted or re-cropped.
 */
const MASCOT_B64 = fs.readFileSync(new URL('./assets/mascot-card.png', import.meta.url)).toString('base64');
const MASCOT_HREF = `data:image/png;base64,${MASCOT_B64}`;

/**
 * XML/SVG text escaping. Escapes the five XML entities and strips control
 * characters that are invalid in XML 1.0 (defense in depth — user-supplied
 * strings like the scanned URL must never be able to inject markup).
 */
export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Display form of a scanned URL for the card: host only (keep `www.` if
 * present; never render scheme, path or query — share cards leak browsing
 * paths), truncated to fit one line when pathological.
 * (Owner wording: "show www. if present; use new URL(url).host".)
 */
export function displayUrl(url, maxLen = 52) {
  let host = null;
  try {
    host = new URL(url).host;
  } catch {
    const raw = String(url);
    return raw.length <= maxLen ? raw : raw.slice(0, Math.max(0, maxLen - 1)) + '…';
  }
  return host.length <= maxLen ? host : host.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/* ------------------------------------------------------------------ */
/* Hand-drawn accent recipes — ALL real SVG paths, zero filters (librsvg
 * determinism). These are copied verbatim from the designer mock
 * (mock-sources/share-card-mock.html). */
/* ------------------------------------------------------------------ */

/** C1/C2 scribble underline — 2-pass lime (w2) or single-pass pink. */
function scrib(hex, w2) {
  return '<path d="M3 9 C 25 3, 55 11, 80 7 S 130 3, 147 8" stroke="' + hex + '" stroke-width="5" stroke-linecap="round" fill="none"/>' +
    (w2 ? '<path d="M8 10 C 35 5, 65 12, 95 8 S 138 5, 150 9" stroke="#d9ff3d" stroke-width="2" stroke-linecap="round" opacity=".8" fill="none"/>' : '');
}

/** C3 4-point lime star. */
function star() {
  return '<path d="M10 0 L12.5 7.5 L20 10 L12.5 12.5 L10 20 L7.5 12.5 L0 10 L7.5 7.5 Z" fill="#d4f000"/>';
}

/** C4/C5 spark ticks (white or tinted) or alarm ! ticks (hot pink). */
function ticks(pink, n, color) {
  const stroke = color || '#ffffff';
  if (pink) {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += '<g stroke="#ff3d8e" stroke-width="7" stroke-linecap="round"><path d="M14 8 L14 26"/><path d="M46 10 L46 28"/></g>' +
        '<text x="14" y="52" fill="#ff3d8e" font-family="Anton" font-size="24">!</text>' +
        '<text x="46" y="54" fill="#ff3d8e" font-family="Anton" font-size="24">!</text>';
    }
    return s;
  }
  return '<g stroke="' + stroke + '" stroke-width="5" stroke-linecap="round">' +
    '<path d="M10 8 L4 20"/><path d="M10 26 L4 34"/><path d="M52 6 L58 18"/><path d="M52 24 L58 32"/></g>';
}

/** C6 hand-drawn ellipse highlight around the stamp (warn/chaos/alarm only). */
function ellipseHighlight(hex, w, h, rot) {
  return '<ellipse cx="' + (w / 2) + '" cy="' + (h / 2) + '" rx="' + (w / 2 - 8) + '" ry="' + (h / 2 - 8) + '" stroke="' + hex + '" stroke-width="6" fill="none" transform="rotate(' + (rot || -3) + ' ' + (w / 2) + ' ' + (h / 2) + ')"/>';
}

/**
 * Build the poster as an SVG string. Fully deterministic — no timestamps, no
 * randomness: same (score, url) -> byte-identical SVG. All variable text is
 * entity-escaped (host, disclaimer, messages); the score is a validated
 * integer via clampScore().
 *
 * @param {{score: number, url: string}} opts score = PUBLIC A.S.S. Score
 *   (0-100, HIGHER = WORSE). Band label/color/messages all derive from the
 *   SHARED verdict module (src/verdict.js) — no band table lives here.
 */
export function buildCardSvg({ score, url }) {
  const s = clampScore(score);
  const band = verdictBand(s);
  const color = band.color; // band accent drives number, stamp, glow, sign strip
  const label = band.shortLabel; // exact band name on the stamp (e.g. CLEANEST)
  const l1 = band.line1; // donkey sign line 1 (e.g. GOOD JOB.)
  const l2 = band.line2; // donkey sign line 2 (e.g. (RARE THESE DAYS))
  const treat = band.treat; // accent set per band (celebrate/positive/mixed/warn/chaos/alarm)
  const host = escapeXml(displayUrl(url));
  const dl1 = escapeXml(DISCLAIMER_LINES[0]);
  const dl2 = escapeXml(DISCLAIMER_LINES[1]);
  const ariaUrl = escapeXml(String(url));

  const numSize = s >= 100 ? 280 : s >= 10 ? 300 : 330;
  const digits = String(s);
  const numW = digits.length * 0.6 * numSize; // Anton is condensed (~.60em/digit incl ls)
  const NUM_X = 84; const NUM_BASE = 560;                 // giant number baseline
  const OF_X = NUM_X + numW + 22; const OF_BASE = NUM_BASE + 26; // /100 baseline
  const TRACK_X = 84; const TRACK_Y = 610; const TRACK_W = 640;
  const M_X = TRACK_X + Math.max(0, Math.min(1, s / 100)) * TRACK_W; // you-are-here marker
  const STAMP_FS = 34; const STAMP_PAD_X = 42; const STAMP_H = 64;
  const stampW = label.length * 0.6 * STAMP_FS + STAMP_PAD_X * 2;
  const STAMP_X = 84; const STAMP_Y = 700;
  const D_X = 940; const D_Y = 70; const D_W = 620; const D_H = 729; // donkey bust
  const SIGN_X = 818; const SIGN_Y = 538; const SIGN_W = 396; const SIGN_H = 236; // paper sign
  const DISC_Y = 846;

  /* accents per treatment (corners of the donkey zone) */
  const TL = '<g transform="translate(880,96)">' + ticks(false) + '</g>'; // white spark ticks
  const TRstar = '<g transform="translate(1470,60) scale(1.4)">' + star() + '</g>' +
    '<g transform="translate(1516,136) scale(.9)">' + star() + '</g>';
  const TRstar1 = '<g transform="translate(1484,70) scale(1.2)">' + star() + '</g>';
  const TRpink1 = '<g transform="translate(1480,84)">' + ticks(true, 1) + '</g>';
  const TRpink2 = '<g transform="translate(1462,64) scale(1.25)">' + ticks(true, 2) + '</g>';
  const TLpink2 = '<g transform="translate(872,80) scale(1.15)">' + ticks(true, 2) + '</g>';
  const TLyellow = '<g transform="translate(884,96)">' + ticks(false, 1, '#facc15') + '</g>';
  let accents = '';
  if (treat === 'celebrate') accents = TL + TRstar;
  else if (treat === 'positive') accents = TL + TRstar1;
  else if (treat === 'mixed') accents = TL;
  else if (treat === 'warn') accents = TLyellow + TRpink1;
  else if (treat === 'chaos') accents = TL + TRpink2;
  else /* alarm */ accents = TLpink2 + TRpink2;

  const stampEllipse = treat === 'alarm'
    ? '<svg x="' + (STAMP_X - 26) + '" y="' + (STAMP_Y - 30) + '" width="' + (stampW + 52) + '" height="124" viewBox="0 0 ' + (stampW + 52) + ' 124" overflow="visible">' +
      ellipseHighlight('#f87171', stampW + 52, 124, 1.5) + '</svg>'
    : (treat === 'chaos' || treat === 'warn'
      ? '<svg x="' + (STAMP_X - 22) + '" y="' + (STAMP_Y - 26) + '" width="' + (stampW + 44) + '" height="116" viewBox="0 0 ' + (stampW + 44) + ' 116" overflow="visible">' +
        ellipseHighlight('#ff3d8e', stampW + 44, 116, 2) + '</svg>'
      : '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${s} out of 100 for ${ariaUrl}">

  <defs>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="1230" cy="440" r="600" fx="1230" fy="440">
      <stop offset="0" stop-color="${color}" stop-opacity=".20"/>
      <stop offset=".55" stop-color="${color}" stop-opacity=".06"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ramp" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4ade80"/><stop offset=".23" stop-color="#a3e635"/>
      <stop offset=".47" stop-color="#facc15"/><stop offset=".70" stop-color="#fb923c"/>
      <stop offset=".86" stop-color="#f97316"/><stop offset="1" stop-color="#f87171"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="1600" height="900" fill="#000000"/>
  <rect x="860" y="0" width="740" height="900" fill="url(#glow)"/>

  <g transform="rotate(-1.2 84 86)">
    <text x="82" y="88" font-family="Anton" font-size="54" fill="#d4f000" letter-spacing="2">A.S.S. SCORE</text>
    <g transform="translate(84,104)"><svg width="430" height="16" viewBox="0 0 150 16" preserveAspectRatio="none">${scrib('#d4f000', true)}</svg></g>
  </g>
  <text x="1516" y="84" text-anchor="end" font-family="Inter" font-weight="700" font-size="16" fill="rgba(255,255,255,.38)" letter-spacing="1.5">ass-score.com</text>

  <text x="86" y="168" font-family="Caveat" font-weight="600" font-size="24" fill="rgba(255,255,255,.55)" letter-spacing="1">SCANNED WEBSITE</text>
  <text x="84" y="216" font-family="Inter" font-weight="800" font-size="34" fill="#ffffff">${host}</text>
  <g transform="translate(86,230)"><svg width="640" height="16" viewBox="0 0 150 16" preserveAspectRatio="none">${scrib('#d4f000', true)}</svg></g>

  <text x="${NUM_X}" y="${NUM_BASE}" font-family="Anton" font-size="${numSize}" fill="${color}" letter-spacing="1">${digits}</text>
  <text x="${OF_X}" y="${OF_BASE}" font-family="Inter" font-weight="800" font-size="52" fill="rgba(255,255,255,.38)">/ 100</text>

  <rect x="${TRACK_X}" y="${TRACK_Y}" width="${TRACK_W}" height="12" rx="6" fill="url(#ramp)" opacity=".92"/>
  <text x="${M_X}" y="${TRACK_Y - 14}" text-anchor="middle" font-family="Caveat" font-weight="700" font-size="21" fill="#ffffff">you are here</text>
  <path d="M${M_X - 9} ${TRACK_Y - 4} L${M_X} ${TRACK_Y + 8} L${M_X + 9} ${TRACK_Y - 4} Z" fill="#ffffff"/>
  <text x="84" y="${TRACK_Y + 38}" font-family="Caveat" font-weight="600" font-size="20" fill="rgba(255,255,255,.6)">0 = LEAST ASS</text>
  <text x="724" y="${TRACK_Y + 38}" text-anchor="end" font-family="Caveat" font-weight="600" font-size="20" fill="rgba(255,255,255,.8)">100 = MAX ASS</text>

  ${stampEllipse}
  <g transform="rotate(-2.5 ${STAMP_X + stampW / 2} ${STAMP_Y + STAMP_H / 2})">
    <rect x="${STAMP_X}" y="${STAMP_Y}" width="${stampW}" height="${STAMP_H}" rx="${STAMP_H / 2}" fill="${color}"/>
    <rect x="${STAMP_X - 3}" y="${STAMP_Y - 3}" width="${stampW + 6}" height="${STAMP_H + 6}" rx="${STAMP_H / 2 + 3}" fill="none" stroke="#000" stroke-width="2"/>
    <text x="${STAMP_X + stampW / 2}" y="${STAMP_Y + STAMP_H / 2 + 12}" text-anchor="middle" font-family="Anton" font-size="${STAMP_FS}" fill="#0b0c0c" letter-spacing="3">${label}</text>
  </g>

  <image href="${MASCOT_HREF}" x="${D_X}" y="${D_Y}" width="${D_W}" height="${D_H}" preserveAspectRatio="xMidYMid slice"/>
  <g transform="rotate(3 ${SIGN_X + SIGN_W / 2} ${SIGN_Y + SIGN_H / 2})">
    <rect x="${SIGN_X + 8}" y="${SIGN_Y + 10}" width="${SIGN_W}" height="${SIGN_H}" rx="18" fill="rgba(0,0,0,.45)"/>
    <rect x="${SIGN_X}" y="${SIGN_Y}" width="${SIGN_W}" height="${SIGN_H}" rx="18" fill="#f2f1ea"/>
    <rect x="${SIGN_X}" y="${SIGN_Y}" width="${SIGN_W}" height="46" rx="18" fill="${color}"/>
    <rect x="${SIGN_X}" y="${SIGN_Y + 24}" width="${SIGN_W}" height="22" fill="${color}"/>
    <text x="${SIGN_X + 24}" y="${SIGN_Y + 30}" font-family="Anton" font-size="17" fill="#0b0c0c" letter-spacing="3">A.S.S. SCORE</text>
    <text x="${SIGN_X + SIGN_W - 24}" y="${SIGN_Y + 30}" text-anchor="end" font-family="Anton" font-size="17" fill="#0b0c0c" letter-spacing="3">OFFICIAL</text>
    <text x="${SIGN_X + 28}" y="${SIGN_Y + 108}" font-family="Caveat" font-weight="700" font-size="46" fill="#0b0c0c">${escapeXml(l1)}</text>
    <text x="${SIGN_X + 28}" y="${SIGN_Y + 142}" font-family="Inter" font-weight="800" font-size="15" fill="rgba(11,12,12,.62)" letter-spacing="1.5">${escapeXml(l2)}</text>
    <path d="M${SIGN_X + 28} ${SIGN_Y + 160} C ${SIGN_X + 70} ${SIGN_Y + 154}, ${SIGN_X + 130} ${SIGN_Y + 162}, ${SIGN_X + 168} ${SIGN_Y + 157}" stroke="#ff3d8e" stroke-width="5" stroke-linecap="round" fill="none"/>
    <text x="${SIGN_X + 28}" y="${SIGN_Y + 208}" font-family="Anton" font-size="38" fill="#0b0c0c">${s} / 100</text>
  </g>

  ${accents}

  <text x="86" y="${DISC_Y}" font-family="Inter" font-size="10" fill="rgba(255,255,255,.38)">${dl1}</text>
  <text x="86" y="${DISC_Y + 15}" font-family="Inter" font-size="10" fill="rgba(255,255,255,.38)">${dl2}</text>
</svg>`;
}

/** Rasterize the card SVG to a PNG buffer (sharp; no headless browser). */
export function renderCardPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** One-shot: score + url -> PNG buffer. */
export function cardPng({ score, url }) {
  return renderCardPng(buildCardSvg({ score, url }));
}

// Re-exported so existing importers (emails, tests) keep one band source.
export { verdictFor, scoreColor } from './verdict.js';