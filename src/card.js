import sharp from 'sharp';
import { clampScore, verdictBand, verdictFor, scoreColor } from './verdict.js';
// Re-exported so existing importers (emails, tests) keep one band source.
export { verdictFor, scoreColor };

/**
 * Shareable result card — server-side rendered PNG per scan (the viral loop).
 *
 * Approach: compose a deterministic SVG string and rasterize it to PNG with
 * sharp (libvips' built-in SVG loader). No headless browser, no screenshots:
 * cheap, fast, deterministic (same inputs -> identical PNG bytes), and works
 * anywhere sharp's prebuilt binaries run (Node 20 / linux-x64, glibc + musl).
 * Detached from the OS font story: text renders with the system sans-serif
 * (DejaVu on Alpine via the `font-dejavu` package in the Dockerfile).
 */

/** Card size — the standard Open Graph / social preview ratio (1200 x 630). */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Mandated disclaimer, verbatim (same string as the HTML report). */
export const DISCLAIMER =
  'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';

/** Disclaimer wrapped into two fixed lines that fit the footer at 12px. */
const DISCLAIMER_LINES = [
  'This tool identifies writing and design patterns commonly associated with generic or templated content.',
  'It does not detect AI authorship and is not proof that any content was AI-generated.',
];

/**
 * Verdict bands live in src/verdict.js — the single source of truth for grade
 * labels + band colors (shared with the JSON API, HTML report and emails).
 * card.js only re-exports the helpers it used to own (verdictFor/scoreColor)
 * so existing importers keep working; ALL band logic is in verdict.js.
 * Score direction: PUBLIC score, 0-100, higher = better. The caller (the
 * routes layer, via toPublicScan) passes the FLIPPED public score here.
 */

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
 * Display form of a scanned URL for the card: host (+port) and path/query
 * (trailing "/" on the bare root is dropped), truncated to fit one line.
 * The host is always kept; only the tail is elided with '…'.
 */
export function displayUrl(url, maxLen = 52) {
  let host = '';
  let rest = '';
  try {
    const u = new URL(url);
    host = u.host;
    rest = (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    const raw = String(url);
    return raw.length <= maxLen ? raw : raw.slice(0, Math.max(0, maxLen - 1)) + '…';
  }
  const full = host + rest;
  if (full.length <= maxLen) return full;
  const keepTail = Math.max(0, maxLen - host.length - 1);
  return host + rest.slice(0, keepTail) + '…';
}

/** Truncate a single-line string with an ellipsis (for the agency line). */
function elide(value, maxLen) {
  const v = String(value);
  return v.length <= maxLen ? v : `${v.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Build the card as an SVG string. Fully deterministic — no timestamps, no
 * randomness: same (score, url, agencyName, roast) -> byte-identical SVG. All
 * variable text is entity-escaped (URL, verdict, roast, agency name,
 * disclaimer); the score is a validated integer via clampScore().
 *
 * `agencyName` is the white-label report option: when present, a small agency
 * line renders under the product brand row. When absent, the SVG is exactly
 * the default A.S.S. Score card.
 *
 * `roast` (optional) is the Slop Roast line: rendered under the one-line
 * verdict, elided to fit the 1072px text column at 20px — the roast never
 * overflows the card. When absent, the layout is byte-identical to the
 * pre-roast card.
 */
export function buildCardSvg({ score, url, agencyName, roast }) {
  const s = clampScore(score);
  const band = verdictBand(s);
  const color = band.color;
  const verdict = band.shortLabel; // the uppercase grade label (same as the API `verdict`)
  const scanned = escapeXml(displayUrl(url));
  const footer = escapeXml('ass-score.com · A.S.S. Score (AI Slop Score)');
  const dl1 = escapeXml(DISCLAIMER_LINES[0]);
  const dl2 = escapeXml(DISCLAIMER_LINES[1]);
  // Agency line: elided so it always fits one line (max 120 chars input).
  const agencyLine = agencyName
    ? `\n  <text x="64" y="92" font-family="'DejaVu Sans', sans-serif" font-size="14" font-weight="600" letter-spacing="1" fill="#94a3b8">${escapeXml(elide(agencyName, 48))}</text>`
    : '';
  // Slop Roast: one elided line under the verdict (fits: 88 chars at 20px in
  // the 1072px text column; reacts to no layout below it until the 560px footer).
  const roastLine = roast
    ? `\n  <text x="64" y="514" font-family="'DejaVu Sans', sans-serif" font-size="20" font-weight="600" fill="#cbd5e1">${escapeXml(elide(roast, 88))}</text>`
    : '';
  // Score bar: fills from the LEFT (low, bad — red bands) toward the RIGHT
  // (high, good — green bands), colored by the score's band. A red sliver says
  // "bad" at a glance; a long green fill says "good". Direction is the public
  // scale: 0 on the left, 100 at the right edge.
  const barX = 64;
  const barW = 1072;
  const barY = 418;
  const barH = 10;
  const fillW = Math.round((barW * s) / 100);
  const scoreBar = `
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="rgba(255,255,255,0.08)"/>
  <rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="5" fill="${color}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="A.S.S. Score ${s} out of 100 for ${escapeXml(String(url))}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#251b4e"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f59e0b"/>
      <stop offset="1" stop-color="#fbbf24"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
  <rect width="${CARD_WIDTH}" height="6" fill="url(#accent)"/>
  <text x="64" y="64" font-family="'DejaVu Sans', sans-serif" font-size="26" font-weight="700" letter-spacing="6" fill="#f8fafc">A.S.S. SCORE</text>
  <text x="1136" y="64" text-anchor="end" font-family="'DejaVu Sans', sans-serif" font-size="17" letter-spacing="1" fill="#94a3b8">ass-score.com</text>${agencyLine}
  <text x="64" y="128" font-family="'DejaVu Sans', sans-serif" font-size="13" font-weight="600" letter-spacing="3" fill="#64748b">SCANNED WEBSITE</text>
  <text x="64" y="170" font-family="'DejaVu Sans', sans-serif" font-size="32" font-weight="600" fill="#e2e8f0">${scanned}</text>
  <rect x="64" y="196" width="1072" height="1" fill="rgba(255,255,255,0.08)"/>
  <text x="64" y="250" font-family="'DejaVu Sans', sans-serif" font-size="22" font-weight="700" letter-spacing="3" fill="#fbbf24">A.S.S. SCORE</text>
  <text x="64" y="398" font-family="'DejaVu Sans', sans-serif" font-size="150" font-weight="800" fill="${color}">${s}<tspan dx="26" dy="-34" font-size="54" font-weight="600" fill="#cbd5e1">/ 100</tspan></text>${scoreBar}
  <text x="64" y="472" font-family="'DejaVu Sans', sans-serif" font-size="34" font-weight="600" fill="${color}">${verdict}</text>${roastLine}
  <text x="64" y="560" font-family="'DejaVu Sans', sans-serif" font-size="17" font-weight="600" fill="#94a3b8">${footer}</text>
  <text x="64" y="584" font-family="'DejaVu Sans', sans-serif" font-size="12" fill="#64748b">${dl1}</text>
  <text x="64" y="602" font-family="'DejaVu Sans', sans-serif" font-size="12" fill="#64748b">${dl2}</text>
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