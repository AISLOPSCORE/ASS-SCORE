import * as cheerio from 'cheerio';

/**
 * Cross-page discovery: find up to 4 additional same-origin pages for a scan
 * (TOTAL pages per scan = 5 — target + up to 4 additional; MAX_TOTAL_PAGES).
 *
 * Pipeline (documented):
 *   1. Prefer `/sitemap.xml`. If it is a sitemap INDEX (lists <sitemap>
 *      children, no <url> entries) also try `/sitemap_index.xml` (a common
 *      convention). <loc> entries are parsed with cheerio.
 *   2. If fewer than the cap were found, the remaining slots are filled from
 *      same-origin <a href> links in the target page's HTML.
 *   3. Candidates are deduped (https preferred over http), fragments stripped,
 *      obvious non-HTML extensions dropped, sorted deterministically, capped
 *      at 4.
 *
 * EVERY fetch goes through the same injected Fetcher as the target page, so
 * the SSRF protections (validateUrl + resolveAndCheck per hop) apply to every
 * additional page — they are never bypassed.
 */

export const MAX_TOTAL_PAGES = 5;
export const MAX_ADDITIONAL_PAGES = MAX_TOTAL_PAGES - 1;

// Obvious non-HTML resources. Conservative list — only clearly non-HTML
// extensions; content-negotiated paths (/, /blog) are kept.
const NON_HTML_EXT = /\.(?:pdf|jpg|jpeg|png|gif|webp|svg|ico|avif|zip|tar|gz|7z|mp4|mp3|ogg|wav|mov|avi|mkv|woff2?|ttf|eot|otf|css|js|mjs|wasm|xml|json|rss|atom|docx?|xlsx?|pptx?|csv)(?:[?#].*)?$/i;

/** True if the path portion looks like a non-HTML resource. */
export function isNonHtmlPath(pathname) {
  return NON_HTML_EXT.test(pathname);
}

/**
 * Normalize a candidate href against the target URL to a same-host candidate.
 * Returns a URL (or null when out of scope). Rules (documented):
 *   - must be http(s);
 *   - host must equal the target host (case-insensitive);
 *   - fragment stripped;
 *   - obvious non-HTML extensions dropped;
 *   - https preferred over http: when the target is https, an http:// link to
 *     the same host is upgraded to https (standard behavior for sites serving
 *     both schemes; deterministic).
 */
export function normalizeCandidate(rawHref, targetUrl) {
  let u;
  try {
    u = new URL(String(rawHref).trim(), targetUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== targetUrl.hostname.toLowerCase()) return null;
  if (isNonHtmlPath(u.pathname)) return null;
  u.hash = '';
  if (targetUrl.protocol === 'https:' && u.protocol === 'http:') {
    u.protocol = 'https:';
  }
  return u;
}

/** True when the URL identifies the target page itself (same path + search). */
function isSamePage(u, targetUrl) {
  return u.pathname === targetUrl.pathname && u.search === targetUrl.search;
}

/**
 * Parse a sitemap document.
 * @returns {{ urls: string[], isIndex: boolean }}
 *   urls — raw <loc> text values from <url> entries, document order
 *   isIndex — document is a sitemap INDEX (has <sitemap> children, no <url> entries)
 */
export function parseSitemap(xml) {
  const $ = cheerio.load(String(xml), { xmlMode: true });
  const urls = [];
  $('url > loc').each((_, el) => {
    const t = $(el).text().trim();
    if (t) urls.push(t);
  });
  const sitemapLocs = [];
  $('sitemap > loc').each((_, el) => {
    const t = $(el).text().trim();
    if (t) sitemapLocs.push(t);
  });
  return { urls, isIndex: sitemapLocs.length > 0 && urls.length === 0 };
}

/**
 * Discover additional pages for a scan.
 *
 * @param {object} opts
 * @param {string} opts.targetUrl  absolute URL of the fetched target page
 * @param {string} opts.targetHtml raw HTML of the target page
 * @param {{ fetchHtml: (url, opts?: {signal}) => Promise<{status,url,body,contentType?}> }} opts.fetcher
 *        the SAME SSRF-protected fetcher used for the target (never bypassed)
 * @param {AbortSignal} [opts.signal] budget abort signal (shared with pipeline)
 *
 * @returns {Promise<{ additional: string[], source: 'sitemap'|'links'|'none',
 *                      sitemapErrors: string[], totalDiscovered: number }>}
 *   additional — up to 4 absolute URLs in deterministic order.
 *   totalDiscovered — the FULL count of deduped same-host candidate pages this
 *   site exposed (sitemap entries + target-page link candidates), BEFORE the
 *   MAX_ADDITIONAL_PAGES slice. It is exactly "how many additional pages this
 *   site showed us" — the target page itself is excluded, duplicates/external/
 *   non-HTML are dropped (the same seen-set logic that builds `additional`).
 *   The cap (MAX_ADDITIONAL_PAGES = 4) NEVER reduces it: a 24-entry sitemap
 *   reports totalDiscovered 23 while `additional` stays 4. A site that
 *   exposed nothing (no sitemap entries, no same-host links) reports 0.
 *   NOTE: candidates are the pages REACHABLE FROM WHAT WE FETCHED — the target
 *   page + sitemap. Pages deeper than one hop (linked only from additional
 *   pages we never fetched) are not counted, so totalDiscovered is a floor of
 *   the site's real size, not an upper bound.
 */
export async function discoverPages({ targetUrl, targetHtml, fetcher, signal } = {}) {
  const base = new URL(targetUrl);
  const sitemapErrors = [];
  let usedSitemap = null; // parsed doc we actually took <url> entries from

  // --- 1. Sitemap-first discovery -------------------------------------------
  const trySitemap = async (path) => {
    const u = new URL(path, base.origin);
    let res;
    try {
      res = await fetcher.fetchHtml(u.href, { signal });
    } catch (err) {
      sitemapErrors.push(`${u.pathname}: ${err?.message ?? err}`);
      return null;
    }
    if (res.status < 200 || res.status >= 300) return null;
    return res.body;
  };

  const first = await trySitemap('/sitemap.xml');
  if (first !== null) {
    const parsed = parseSitemap(first);
    if (parsed.urls.length > 0) {
      usedSitemap = parsed;
    } else if (parsed.isIndex) {
      // Index at /sitemap.xml: try the conventional /sitemap_index.xml.
      const second = await trySitemap('/sitemap_index.xml');
      if (second !== null && parseSitemap(second).urls.length > 0) {
        usedSitemap = parseSitemap(second);
      }
    }
  }

  // --- 2. Build the candidate list -------------------------------------------
  const seen = new Set();
  const sitemapCands = [];
  if (usedSitemap) {
    for (const loc of usedSitemap.urls) {
      const u = normalizeCandidate(loc, base);
      if (!u) continue;
      if (isSamePage(u, base)) continue; // never the target page itself
      const href = u.href;
      if (seen.has(href)) continue;
      seen.add(href);
      sitemapCands.push(href);
    }
  }

  const linkCands = [];
  if (sitemapCands.length < MAX_ADDITIONAL_PAGES && targetHtml) {
    const $ = cheerio.load(String(targetHtml));
    $('a[href]').each((_, el) => {
      const u = normalizeCandidate($(el).attr('href'), base);
      if (!u) return;
      if (isSamePage(u, base)) return; // self-link
      const href = u.href;
      if (seen.has(href)) return;
      seen.add(href);
      linkCands.push(href);
    });
    // Deterministic order: https before http, then lexicographic.
    linkCands.sort((a, b) => {
      const aHttp = a.startsWith('https://') ? 0 : 1;
      const bHttp = b.startsWith('https://') ? 0 : 1;
      if (aHttp !== bHttp) return aHttp - bHttp;
      return a.localeCompare(b);
    });
  }

  const candidates = [...sitemapCands, ...linkCands];
  const additional = candidates.slice(0, MAX_ADDITIONAL_PAGES);
  const source = usedSitemap ? 'sitemap' : (additional.length > 0 ? 'links' : 'none');
  // Full discovery count BEFORE the cap: every deduped same-host candidate the
  // site exposed (sitemap + target-page links), excluding the target itself.
  // seen.size === candidates.length — every href in `seen` was pushed into
  // exactly one of the two candidate lists (both add to the same set).
  const totalDiscovered = seen.size;

  return { additional, source, sitemapErrors, totalDiscovered };
}