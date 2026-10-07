import { randomUUID } from 'node:crypto';
import { extractText, extractMainText, extractHead, extractReadableText } from './text.js';
import { runRules } from './rules/index.js';
import { computeSlopScore } from './scorer.js';
import { discoverPages } from './rules/discover.js';
import { analyzeCrossPage, DUPLICATION_THRESHOLD } from './rules/crossPage.js';
import { detectSkeleton } from './rules/skeletonFamily.js';
import { analyzeFingerprints } from './rules/fingerprints.js';
import { visualRepetitionHits } from './rules/visualRepetition.js';
import { analyzeAssets } from './rules/assets.js';
import { createBudget } from './budget.js';
import { SsrfError, InvalidUrlError } from './fetch/ssrf.js';
import { FetchError } from './fetch/client.js';
import { selectRoast } from './roast.js';
import { withInsights } from './threeLayer.js';
import { attachSources } from './groupFindings.js';

/** Per-scan time budget (ms): target fetch + discovery + additional fetches +
 *  similarity. When it elapses, in-flight work is aborted and whatever
 *  completed is used (partial mode recorded). Injectable for tests. */
export const SCAN_BUDGET_MS = 25_000;

/** Worst-page blend: 70% the page's own v1 score + 30% its duplication score. */
export const WORST_PAGE_V1_WEIGHT = 0.7;
export const WORST_PAGE_DUP_WEIGHT = 0.3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Run one full deterministic scan (the same pipeline both `POST /api/v1/scan`
 * and `POST /api/v1/webhook` execute). Pure rule-based analysis only — no AI
 * models, no external scoring. Same input -> same score, every time.
 *
 * Validation of optional webhook/branding/email inputs is the CALLER's job
 * (fail-fast before any network I/O, per route). This function assumes `url`
 * is a non-empty string and runs the fetch with the SSRF-safe Fetcher.
 *
 * @param {object} deps
 * @param {object} deps.db              sqlite handle (from openDb)
 * @param {object} deps.fetcher         SSRF-safe Fetcher (fetchHtml(rawUrl, {signal}))
 * @param {string} deps.url             target URL to scan
 * @param {object|null} [deps.branding] normalized white-label branding (or null)
 * @param {string|null} [deps.businessName] normalized client business name (or null)
 * @param {() => string} [deps.now]     ISO timestamp provider
 * @param {number} [deps.scanBudgetMs]  per-scan time budget
 * @param {boolean|null} [deps.internal] mark the persisted row as admin-internal
 *   (the /admin/share-card tool — excluded from every public read surface and
 *   the admin-stats counts). Default null keeps the public path byte-identical.
 * @returns {Promise<{ok: true, payload: object} | {ok: false, status: number, json: object}>}
 *   - { ok: true, payload } — persisted scan result (also the bytes returned to
 *     API callers and delivered to webhooks/email). `payload.id` is the scan id.
 *   - { ok: false, status, json } — client-correctable failure (400 blocked,
 *     422 parse_failed, 502 fetch_failed): the caller maps it to its own
 *     response. No row is persisted for these outcomes. Failure paths:
 *     - 400 blocked — SSRF/invalid target (pre-fetch);
 *     - 502 fetch_failed — transport error, timeout, oversize body, too many
 *       redirects, or the target answered with an HTTP error status (>= 400);
 *     - 422 parse_failed — non-HTML Content-Type (binary payload), unparseable
 *       HTML, or no extractable text.
 *   Genuine internal errors REJECT — callers route them to the centralized
 *   error handler (500), exactly like the scan route always did.
 */
export async function runScan({ db, fetcher, url, branding = null, businessName = null, now = () => new Date().toISOString(), scanBudgetMs = SCAN_BUDGET_MS, internal = null }) {
  // --- time budget (covers target fetch + discovery + additional fetches) ---
  const budget = createBudget(scanBudgetMs);
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), Math.max(1, budget.remainingMs()));

  let page;
  try {
    page = await fetcher.fetchHtml(url, { signal: abortCtrl.signal });
  } catch (err) {
    clearTimeout(abortTimer);
    if (err instanceof SsrfError || err instanceof InvalidUrlError) {
      return { ok: false, status: 400, json: { error: { code: 'blocked', message: err.message } } };
    }
    if (err instanceof FetchError) {
      return { ok: false, status: 502, json: { error: { code: 'fetch_failed', message: err.message } } };
    }
    throw err;
  }

  // --- HTTP-status gate (audit D1) -----------------------------------------
  // A 4xx/5xx page is the ERROR page, not the site: scoring it would report
  // the site itself as "CLEAN". Same shape as the other fetch-failure
  // returns (502 fetch_failed) so client handling stays uniform; no row.
  if (page.status >= 400) {
    clearTimeout(abortTimer);
    return { ok: false, status: 502, json: { error: { code: 'fetch_failed', message: `Target returned HTTP ${page.status}` } } };
  }

  // --- Content-Type gate (audit D2) ----------------------------------------
  // Binary/foreign payloads (PDF, PNG, JSON, ...) would otherwise be
  // stream-decoded into garbage text and scored as "clean". Reject any
  // PRESENT header whose mime essence (params like ;charset= stripped,
  // case-insensitive) is not an HTML-family type. Absent header keeps today's
  // behavior: attempt the parse (the zero-word gate below still applies).
  const contentType = page.contentType ?? null;
  if (contentType !== null) {
    const essence = contentType.split(';')[0].trim().toLowerCase();
    if (essence !== 'text/html' && essence !== 'application/xhtml+xml' && essence !== 'text/xml') {
      clearTimeout(abortTimer);
      return { ok: false, status: 422, json: { error: { code: 'parse_failed', message: `Target is not an HTML page (Content-Type: ${contentType})` } } };
    }
  }

  let text;
  try {
    text = extractText(page.body);
  } catch (err) {
    clearTimeout(abortTimer);
    return { ok: false, status: 422, json: { error: { code: 'parse_failed', message: 'Could not parse the HTML response' } } };
  }
  // Zero-text page — the JS-only-shell case. Owner-approved copy (2026-10-07):
  // the message reads as THE FINDING ("this site renders via JavaScript"), NOT
  // a scan failure, so a JS-only site no longer looks broken to the user. The
  // code/status stay parse_failed/422 (tests + consumers depend on them), and
  // this stays a NON-gate failure (it never matched the D2 'Target is not an
  // HTML page' prefix in src/routes/scan.js) — the request keeps its quota
  // slot, exactly as before.
  if (!text.text || text.words.length === 0) {
    clearTimeout(abortTimer);
    return { ok: false, status: 422, json: { error: { code: 'parse_failed', message: 'This site renders all content with JavaScript, so nothing readable is served to search engines or scanners without a browser. Not a scan failure — that IS the finding.' } } };
  }

  // --- readable variant (owner-approved Option B, 2026-10-07) -----------------
  // Boundary-spaced extraction consumed ONLY by quote/evidence strings
  // (findings that quote page text read like the page: "Advertise now $29.99"
  // instead of "advertise now 29 99 30"). NEVER feeds a score: every rule's
  // detection and score math reads the analysis corpus `text` above; the
  // readable variant is passed alongside for quote-building only. Same input
  // as extractText, so a parse that already succeeded cannot fail here; a
  // defensive null fallback keeps the current (normalized-quote) behavior.
  let readable = null;
  try {
    readable = extractReadableText(page.body);
  } catch {
    readable = null;
  }

  // --- discovery + additional fetches (budget-aware, concurrent) -------------
  let pages = [{ url: page.url, html: page.body }]; // target first, deterministic order
  const skipped = [];
  // Candidates the site exposed, BEFORE the MAX_ADDITIONAL_PAGES slice
  // (see discoverPages' totalDiscovered). 0 when discovery never ran (budget
  // expired first), so crawl_discovered always stays >= 1 and honest.
  let totalDiscovered = 0;

  try {
    if (budget.expired()) {
      skipped.push('<discovery: budget expired before additional-page discovery>');
    } else {
      const discovery = await discoverPages({
        targetUrl: page.url,
        targetHtml: page.body,
        fetcher,
        signal: abortCtrl.signal,
      });
      totalDiscovered = discovery.totalDiscovered;
      const additional = discovery.additional; // <= 4, deterministic order
      if (additional.length > 0) {
        // Concurrent; budget expiry aborts whatever is still in flight.
        const settled = await Promise.allSettled(
          additional.map((u) => fetcher.fetchHtml(u, { signal: abortCtrl.signal })),
        );
        for (let i = 0; i < additional.length; i += 1) {
          if (settled[i].status === 'fulfilled') {
            pages.push({ url: settled[i].value.url, html: settled[i].value.body });
          } else {
            skipped.push(additional[i]);
          }
        }
      }
    }
  } finally {
    clearTimeout(abortTimer);
  }

  // --- redirect/canonical-URL deduplication (owner PROMPT 1, 2026-10-05) -------
  // The fetcher follows redirects and records the FINAL fetched URL
  // (res.url = post-redirect), so two DISTINCT candidate URLs can converge onto
  // ONE final document (a sitemap spelling that 301s to the canonical URL —
  // the TechBullion case: /category/cryptocurrency/ and a misspelled sibling
  // both resolved to https://techbullion.com/cryptocurrency/, which was then
  // compared against ITSELF → "100.0% similar" → crossPage 100 → composite
  // inflated 13 → 43). Dedupe the WHOLE scanned set by final URL, FIRST
  // occurrence wins in deterministic order (pages[0] — the target — is always
  // kept; then additional pages in discovered order). A converged duplicate is
  // dropped from `pages`, so it never enters crossPage, the worst-page panel,
  // or the v1 per-page loop. crawlFetched therefore counts DISTINCT final
  // documents actually analyzed.
  const seenFinalUrls = new Set();
  const dedupedPages = [];
  for (const p of pages) {
    if (seenFinalUrls.has(p.url)) continue;
    seenFinalUrls.add(p.url);
    dedupedPages.push(p);
  }
  pages = dedupedPages;

  // Crawl-depth disclosure counts (owner 10-05, option a — keep MAX_TOTAL_PAGES
  // = 5, disclose what was and wasn't evaluated):
  //   crawlFetched    = pages actually included in this scan (target +
  //                     additional pages that fetched successfully) — always
  //                     >= 1 and <= MAX_TOTAL_PAGES.
  //   crawlDiscovered = the target + every deduped same-host candidate the
  //                     site exposed via sitemap/links BEFORE the cap — the
  //                     honest "N of M" denominator. NEVER reduced by the cap.
  // Both persist so every read surface (paid report methodology, free result
  // page, free JSON) can state the scope; old rows (null) render no line.
  const crawlFetched = pages.length;
  const crawlDiscovered = 1 + totalDiscovered;

  // --- per-page main content + v1 rules (Worst Page needs them) -------------
  const perPage = new Map(); // url -> { rules, main }
  for (const p of pages) {
    const main = extractMainText(p.html);
    // Readable variant for quote strings (boundary-spaced; scores untouched).
    let pReadable = null;
    try {
      pReadable = extractReadableText(p.html);
    } catch {
      pReadable = null;
    }
    perPage.set(p.url, { rules: runRules(main, pReadable), main, readable: pReadable });
  }

  // --- phase-2 rules -----------------------------------------------------------
  // crossPage: similarity over MAIN content of every fetched page + the
  // in-page repeated-phrase component (pass 2, 2026-10-01) which measures the
  // TARGET page's own sentences + the round-2 DOM-skeleton component
  // (owner-approved 2026-10-06; src/rules/skeletonFamily.js) which runs on
  // the deduped pages' HTML — the structural twin of duplicated body copy
  // (extractMainText strips chrome, so a shared DOM template is invisible to
  // the pairwise text term by construction). See src/rules/crossPage.js.
  // pages[0] is always the target (pushed first above); its extractText
  // context is passed along so the REPETITION card's phrase signal fires even
  // on single-page scans. The skeleton detector is null (E1) below 2 pages —
  // single-page scans reproduce the pre-round-2 pipeline byte-for-byte.
  const skeleton = detectSkeleton(pages.map((p) => ({ url: p.url, html: p.html })));
  const crossPage = analyzeCrossPage({
    pages: pages.map((p, i) => ({
      url: p.url,
      main: perPage.get(p.url).main,
      ...(i === 0 ? { sentences: text.sentences, paragraphs: text.paragraphs, title: text.title, readable } : {}),
    })),
    skeleton,
  });
  // fingerprints: evidence on the target page (the URL the customer asked about).
  // Round-1 DESIGN signals (2026-10-05) run as extra count-rule hits on the
  // target page's HTML only — same scope as the rest of DESIGN.
  const fingerprints = analyzeFingerprints({
    html: page.body,
    head: extractHead(page.body),
    text: text.text,
    extraHits: visualRepetitionHits(page.body),
  });
  // assets: stock/placeholder imagery on the target page (HTML-only, no downloads).
  const assets = analyzeAssets(page.body);

  // --- v1 breakdown on the target + new categories ---------------------------
  const breakdown = {
    ...runRules(text, readable),
    crossPage,
    fingerprints,
    assets,
  };

  // ONE PROBLEM = ONE FINDING (owner 2026-10-07): attach the phase-B component
  // key (src) for every finding, computed on the TARGET page HTML. Purely
  // additive (`breakdown.<cat>.sources[i]` parallel to findings[i]) — scores,
  // findings and insights are untouched; legacy rows simply lack `sources` and
  // get within-category grouping only (see src/groupFindings.js).
  attachSources(page.body, breakdown);

  const { slopScore } = computeSlopScore(breakdown);

  // --- Worst Page: highest per-page combined score -----------------------------
  // combined = 0.7 * (page's own v1 score) + 0.3 * (its duplication score,
  // where duplication score reuses the crossPage mapping 0.80 -> 0, 1.00 -> 100
  // for the page's worst flagged pair; 0 when the page is in no flagged pair).
  // Deterministic tie-break: lowest URL (lexicographic).
  // DELIBERATE (pass 2, owner 2026-10-01): in-page repeated-PHRASE receipts
  // live under crossPage (the REPETITION card), so they do NOT surface in the
  // worst-page panel — the panel's evidence collectors are the four v1 rules
  // (below) and its page choice never considered the phrase signal; showing
  // phrase receipts here would double-report the same evidence in the paid
  // report's ACTUAL FINDINGS. Documented in the PR body.
  let worstPage = null;
  if (pages.length >= 2) {
    const dupByUrl = new Map();
    const pairByUrl = new Map();
    for (const p of crossPage.pairs ?? []) {
      if (p.similarity < DUPLICATION_THRESHOLD) continue;
      const dup = clamp(Math.round(((p.similarity - DUPLICATION_THRESHOLD) / (1 - DUPLICATION_THRESHOLD)) * 100), 0, 100);
      dupByUrl.set(p.pageA, Math.max(dupByUrl.get(p.pageA) ?? 0, dup));
      dupByUrl.set(p.pageB, Math.max(dupByUrl.get(p.pageB) ?? 0, dup));
      // Report-trust fix 2026-10-07 (DEFECT 2): carry the REAL pair evidence
      // (other URL + raw similarity fraction) with the highest-similarity
      // flagged pair for each page, so the "Page That Needs The Most Work"
      // panel can name the duplication instead of hiding it behind a
      // category-findings list. Real data only — same pairs that scored the
      // dup term; no invented numbers.
      const rec = { otherUrl: p.pageB, similarity: p.similarity };
      if (!pairByUrl.has(p.pageA) || (pairByUrl.get(p.pageA).similarity ?? 0) < rec.similarity) pairByUrl.set(p.pageA, rec);
      const recB = { otherUrl: p.pageA, similarity: p.similarity };
      if (!pairByUrl.has(p.pageB) || (pairByUrl.get(p.pageB).similarity ?? 0) < recB.similarity) pairByUrl.set(p.pageB, recB);
    }
    let bestUrl = null;
    let bestScore = -1;
    let bestFindings = [];
    let bestDupPair = null;
    for (const p of pages) {
      const v1 = computeSlopScore(perPage.get(p.url).rules).slopScore;
      const dup = dupByUrl.get(p.url) ?? 0;
      const combined = clamp(Math.round(WORST_PAGE_V1_WEIGHT * v1 + WORST_PAGE_DUP_WEIGHT * dup), 0, 100);
      const better = combined > bestScore || (combined === bestScore && (bestUrl === null || p.url < bestUrl));
      if (better) {
        bestScore = combined;
        bestUrl = p.url;
        bestFindings = [
          ...perPage.get(p.url).rules.filler.findings,
          ...perPage.get(p.url).rules.boilerplate.findings,
          ...perPage.get(p.url).rules.infoDensity.findings,
          ...perPage.get(p.url).rules.repetitive.findings,
        ].slice(0, 6);
        bestDupPair = pairByUrl.get(p.url) ?? null;
      }
    }
    worstPage = { url: bestUrl, score: bestScore, findings: bestFindings };
    if (bestDupPair) worstPage.dupPair = bestDupPair;
  }

  const id = randomUUID();
  const createdAt = now();
  // Slop Roast: deterministic per scan id (same id -> same line, forever),
  // pool picked from the category that contributed the most to the score.
  const roast = selectRoast({ id, slopScore, breakdown });
  // Three-layer findings: every category finding gains { roast, why, fix,
  // evidence } (deterministic per scan id — see src/threeLayer.js). The
  // enriched breakdown rides into the stored JSON column AND the response
  // object, so every surface (JSON, HTML report, webhook, email) is stable.
  const enrichedBreakdown = withInsights(breakdown, id);
  // Response object AND webhook payload — delivered bytes-exact as returned.
  const payload = { id, url: page.url, slopScore, breakdown: enrichedBreakdown, roast, createdAt };
  if (branding) payload.branding = branding;
  // Crawl-depth disclosure counts ride the payload AND the DB row (only the
  // two numbers; page lists never leave the paid surfaces).
  payload.crawlFetched = crawlFetched;
  payload.crawlDiscovered = crawlDiscovered;
  if (pages.length >= 2) {
    payload.pages = pages.map((p) => p.url);
    payload.worstPage = worstPage;
  }
  if (skipped.length > 0) {
    payload.partial = true;
    payload.note = `skipped/dropped pages: ${skipped.join(', ')}`;
  }
  db.insertScan({
    id,
    url: page.url,
    score: slopScore,
    breakdown: enrichedBreakdown,
    createdAt,
    partial: payload.partial,
    note: payload.note,
    worstPage: payload.worstPage,
    branding: payload.branding,
    roast,
    // Optional client-provided business name (POST /api/v1/scan businessName).
    // Storage only — never part of the public/paid payload surfaces.
    businessName,
    // Admin-tool marker (the /admin/share-card flow): null/undefined keeps the
    // public path byte-identical; true excludes the row from public surfaces +
    // admin-stats counts.
    internal,
    // Crawl-depth disclosure: how many pages were evaluated vs how many the
    // site exposed (nullable ints — old rows render no scope line).
    crawlFetched,
    crawlDiscovered,
  });

  return { ok: true, payload };
}