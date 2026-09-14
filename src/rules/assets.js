import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

/**
 * Asset Slop rule — stock/placeholder imagery on the scanned page.
 *
 * HTML-only, deterministic, no image downloads and no image analysis: we look
 * at <img> element attributes (src / data-src / srcset, filename stems, alt
 * text) and the image hostname. Signals:
 *
 *   1. Stock-image CDN origins (table in assets.json): hostname (or the last
 *      2+ labels of it) ends with a configured origin. Only absolute
 *      http(s) URLs are checked — a relative path has no host to judge.
 *   2. Placeholder/generic filenames (regex patterns in assets.json, matched
 *      case-insensitively against the filename stem): "placeholder*",
 *      "dummy*", "screenshot", "imageN / photoN / imgN", a bare "logo",
 *      "spacer", "1x1", "blank", "pixel", "transparent".
 *   3. Missing or generic alt text:
 *      - alt attribute absent,
 *      - alt empty (whitespace-only counts as empty; decorative logic is
 *        deliberately NOT applied — simple and deterministic),
 *      - alt exactly one of the generic strings in assets.json (case and
 *        whitespace-insensitive after trim).
 *
 * Scoring (documented, deterministic): each signal's share of the page's
 * images is weighted and summed — 50% stock-CDN share, 25% placeholder-
 * filename share, 25% bad-alt share — then scaled to 0–100:
 *   score = round(clamp(100 × (0.50·stock + 0.25·filename + 0.25·alt), 0, 100))
 * A page whose images are ALL flagged on all three signals scores 100; a page
 * with half its images from a stock CDN scores 25. Pages with no <img> tags
 * score 0 with no findings. Deterministic: same HTML -> same result, always.
 *
 * Wording rule: pattern-evidence only ("stock/placeholder CDN", "generic
 * filename", "missing/generic alt") — never an assertion about how an image
 * was produced. stockImageHosts is the editable list (add/remove origins with
 * NO code change), mirrored in README.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets.json');
const CONFIG = Object.freeze(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')));

/** Stock/placeholder CDN host suffixes (lowercase, e.g. "unsplash.com"). */
export const STOCK_IMAGE_HOSTS = Object.freeze([...(CONFIG.stockImageHosts ?? [])]);

/** Filename-stem regex patterns (strings compiled case-insensitively). */
export const PLACEHOLDER_FILENAME_PATTERNS = Object.freeze([...(CONFIG.placeholderFilenamePatterns ?? [])]);

/** Exact alt-text values considered generic (compared after trim + lowercase). */
export const GENERIC_ALT_TEXTS = Object.freeze([...(CONFIG.genericAltTexts ?? [])]);

const PLACEHOLDER_RE = Object.freeze(
  PLACEHOLDER_FILENAME_PATTERNS.map((p) => new RegExp(p, 'i')),
);
const GENERIC_ALT_SET = new Set(GENERIC_ALT_TEXTS.map((a) => a.toLowerCase()));

/** Max per-signal detail findings (report stays bounded; aggregate counts always exact). */
const MAX_DETAIL_FINDINGS = 8;

function isStockHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  for (const entry of STOCK_IMAGE_HOSTS) {
    const e = entry.toLowerCase();
    if (host === e || host.endsWith(`.${e}`)) return e;
  }
  return null;
}

/** Pull the image URL out of an <img> element (src -> data-src -> first srcset candidate). */
function imgSrcUrl($, el) {
  const src = $(el).attr('src') ?? '';
  if (src.trim()) return src.trim();
  const dataSrc = $(el).attr('data-src') ?? '';
  if (dataSrc.trim()) return dataSrc.trim();
  const srcset = $(el).attr('srcset') ?? '';
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first ? first.trim() : '';
}

/** Basename (filename stem) of a URL path — "image1.jpg?x=1#f" -> "image1". */
function filenameStem(src) {
  try {
    const withoutQuery = String(src).split(/[?#]/)[0];
    const basename = withoutQuery.split('/').pop() ?? '';
    return basename.replace(/\.[a-z0-9]+$/i, '');
  } catch {
    return '';
  }
}

/**
 * @param {string} html raw HTML of the scanned page
 * @returns {{ score: number, findings: string[] }}
 */
export function analyzeAssets(html = '') {
  if (!html) return { score: 0, findings: [] };

  const $ = cheerio.load(String(html));
  const imgs = $('img').toArray();
  const total = imgs.length;
  if (total === 0) return { score: 0, findings: [] };

  let stockCount = 0;
  let filenameCount = 0;
  let altCount = 0;
  const stockDetail = [];
  const fileDetail = [];
  const altDetail = [];

  imgs.forEach((el, i) => {
    const src = imgSrcUrl($, el);

    // 1. stock/placeholder CDN host (absolute http(s) URLs only)
    if (/^https?:\/\//i.test(src)) {
      try {
        const host = new URL(src).hostname;
        const matched = isStockHost(host);
        if (matched) {
          stockCount += 1;
          if (stockDetail.length < MAX_DETAIL_FINDINGS) {
            stockDetail.push(`img[${i}] stock/placeholder CDN «${matched}» (${src.length > 70 ? `${src.slice(0, 70)}…` : src})`);
          }
        }
      } catch {
        // unparseable URL -> not a CDN match, never fatal
      }
    }

    // 2. placeholder/generic filename (any src form, even relative)
    const stem = filenameStem(src);
    if (stem && PLACEHOLDER_RE.some((re) => re.test(stem))) {
      filenameCount += 1;
      if (fileDetail.length < MAX_DETAIL_FINDINGS) {
        fileDetail.push(`img[${i}] generic filename "${stem}" (${src.length > 70 ? `${src.slice(0, 70)}…` : src})`);
      }
    }

    // 3. missing / empty / generic alt
    const altRaw = $(el).attr('alt');
    if (altRaw === undefined) {
      altCount += 1;
      if (altDetail.length < MAX_DETAIL_FINDINGS) altDetail.push(`img[${i}] missing alt attribute`);
    } else {
      const alt = altRaw.trim().toLowerCase();
      if (alt === '') {
        altCount += 1;
        if (altDetail.length < MAX_DETAIL_FINDINGS) altDetail.push(`img[${i}] empty alt attribute`);
      } else if (GENERIC_ALT_SET.has(alt)) {
        altCount += 1;
        if (altDetail.length < MAX_DETAIL_FINDINGS) altDetail.push(`img[${i}] generic alt "${alt}"`);
      }
    }
  });

  const stockRatio = stockCount / total;
  const fileRatio = filenameCount / total;
  const altRatio = altCount / total;
  const score = clamp(Math.round(100 * (0.5 * stockRatio + 0.25 * fileRatio + 0.25 * altRatio)), 0, 100);

  const findings = [];
  if (stockCount === 0 && filenameCount === 0 && altCount === 0) {
    findings.push(`0 of ${total} images flagged for stock/placeholder signals`);
    return { score, findings };
  }
  findings.push(`${stockCount} of ${total} images from stock/placeholder CDNs`);
  findings.push(`${filenameCount} of ${total} images with placeholder/generic filenames`);
  findings.push(`${altCount} of ${total} images with missing or generic alt text`);
  findings.push(...stockDetail, ...fileDetail, ...altDetail);

  return { score, findings };
}