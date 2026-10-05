import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runScan } from '../src/scan.js';
import { analyzeCrossPage } from '../src/rules/crossPage.js';

/**
 * Redirect / canonical-URL deduplication (owner PROMPT 1, 2026-10-05).
 *
 * THE BUG (measured on TechBullion, cap 25): the rotiform sitemap exposes both
 * /category/cryptocurrency/ and a spelling that 301-converges onto it. The
 * fetcher follows the redirect and records the FINAL URL, so TWO candidate
 * entries landed on ONE final document; the engine then compared that document
 * against ITSELF → "100.0% similar" → crossPage 100 → composite inflated
 * 13 → 43 (deterministic across runs).
 *
 * THE FIX (two layers):
 *   1. scan.js — dedupe the whole scanned page set by FINAL fetched URL
 *      (res.url = post-redirect) BEFORE any cross-page comparison, first
 *      occurrence wins in deterministic order (target first). Converged
 *      duplicates leave `pages`, so they never enter crossPage, the worst-page
 *      panel, or the v1 per-page loop.
 *   2. crossPage.js — belt-and-braces identity guard: a pair where
 *      pageA === pageB (same URL) is skipped, so a document can literally
 *      never be scored against itself.
 *
 * These tests pin BOTH layers and reproduce the exact TechBullion shape
 * offline: a fixture sitemap/HTML pair where two distinct candidate URLs
 * converge (via a real 301 the fetcher follows) onto one final document.
 */
const words = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// --- fixture content (genuinely distinct pages; no shared boilerplate in
// --- <main>, no repeated template phrases on the target) --------------------
const HOME_TEXT = [
  'The operations desk publishes a daily queue report before the first standup.',
  'Every shift hands off unresolved tickets with a written note.',
  'We track delivery times against the service target every week.',
  'The roster rotates on a fixed two-week cycle.',
  'Warehouse audits happen quarterly and the findings are public.',
].join(' ');

const CRYPTO_TEXT = [
  'Digital asset markets moved sideways through the morning session.',
  'Regulators published a consultation paper on stablecoin settlement rules.',
  'Exchange trading volumes dipped below the weekly average.',
  'Custody providers announced support for a new token standard.',
  'Analysts noted that liquidity remained thin across major pairs.',
].join(' ');

const html = (title, mainText) => `<!doctype html><html><head><title>${title}</title></head><body>
  <main><p>${mainText}</p></main>
  <footer>Made with care.</footer>
</body></html>`;

/**
 * Local fixture site. `includeTypo` reproduces the TechBullion rotiform shape:
 * the sitemap exposes BOTH the canonical spelling AND a misspelled sibling
 * that 301-converges onto it.
 *   /cat-crypto-typo/  -> 301 -> /cat-crypto/   (converges)
 *   /home-twin/        -> 301 -> /              (converges onto the TARGET)
 */
function buildHandler(port, { includeTypo = false, includeHomeTwin = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const locs = [`<url><loc>${base}/</loc></url>`];
  if (includeTypo) {
    // The TechBullion rotiform order: canonical first, misspelled sibling second.
    locs.push(`<url><loc>${base}/cat-crypto/</loc></url>`);
    locs.push(`<url><loc>${base}/cat-crypto-typo/</loc></url>`);
  } else if (!includeHomeTwin) {
    // Control / plain site: sitemap lists ONLY the canonical crypto page.
    locs.push(`<url><loc>${base}/cat-crypto/</loc></url>`);
  }
  if (includeHomeTwin) locs.push(`<url><loc>${base}/home-twin/</loc></url>`);
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.join('')}</urlset>`;
  const send = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  return (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/sitemap.xml') return send(res, sitemap);
    if (p === '/') return send(res, html('Converge Co', HOME_TEXT));
    if (p === '/cat-crypto/') return send(res, html('Crypto Desk', CRYPTO_TEXT));
    if (p === '/cat-crypto-typo/') {
      res.writeHead(301, { location: '/cat-crypto/' });
      return res.end();
    }
    if (p === '/home-twin/') {
      res.writeHead(301, { location: '/' });
      return res.end();
    }
    return send(res, 'not found', 404);
  };
}

/** Test-only fetcher that behaves like the production Fetcher's redirect
 *  contract: follows 301s and records res.url = FINAL post-redirect URL. */
function redirectAwareFetcher() {
  return {
    async fetchHtml(rawUrl, { signal } = {}) {
      const res = await fetch(String(rawUrl).trim(), { signal, redirect: 'follow' });
      return { status: res.status, url: res.url, body: await res.text() };
    },
  };
}

let typoSrv, typoBase, typoPort;
let ctrlSrv, ctrlBase;       // control: same site, NO duplicate spelling
let targetSrv, targetBase;   // sitemap exposes a spelling that 301s onto the target

before(async () => {
  typoSrv = http.createServer((req, res) => buildHandler(typoSrv.address().port, { includeTypo: true })(req, res));
  await new Promise((r) => typoSrv.listen(0, '127.0.0.1', r));
  typoPort = typoSrv.address().port;
  typoBase = `http://127.0.0.1:${typoPort}`;

  ctrlSrv = http.createServer((req, res) => buildHandler(ctrlSrv.address().port, { includeTypo: false })(req, res));
  await new Promise((r) => ctrlSrv.listen(0, '127.0.0.1', r));
  ctrlBase = `http://127.0.0.1:${ctrlSrv.address().port}`;

  targetSrv = http.createServer((req, res) => buildHandler(targetSrv.address().port, { includeHomeTwin: true })(req, res));
  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  targetBase = `http://127.0.0.1:${targetSrv.address().port}`;
});

after(() => {
  for (const s of [typoSrv, ctrlSrv, targetSrv]) {
    s.closeAllConnections?.();
    s.close();
  }
});

const scan = (url) =>
  runScan({ db: { insertScan: () => {} }, fetcher: redirectAwareFetcher(), url, scanBudgetMs: 8000 });

// ---------------------------------------------------------------------------
// Layer 2 unit: crossPage identity guard (belt-and-braces)
// ---------------------------------------------------------------------------
test('crossPage identity guard: a same-URL pair is skipped, never 100, never a self-comparison', () => {
  const dupWords = words(CRYPTO_TEXT);
  const res = analyzeCrossPage({
    pages: [
      { url: 'https://example.com/cat-crypto/', main: { words: dupWords } },
      { url: 'https://example.com/cat-crypto/', main: { words: dupWords } },
    ],
  });
  // The two entries are the SAME document (identical URL + identical words).
  // Without the guard the pair would be 1.0 → flagged → score 100 + a
  // "near-identical page pair: A ~ A" receipt.
  assert.equal(res.score, 0, 'identity pair must not produce any duplication score');
  assert.ok(!res.findings.some((f) => f.includes('near-identical page pair') || f.includes('100.0%')), 'no self-comparison receipt');
  assert.ok(Array.isArray(res.pairs) && res.pairs.length === 0, 'identity pair is excluded from pairs');
});

// ---------------------------------------------------------------------------
// Layer 1 integration: the exact TechBullion shape (two candidates -> one doc)
// ---------------------------------------------------------------------------
test('redirect convergence: pages hold the canonical URL ONCE, crossPage not inflated, rollup == no-duplicate control', async () => {
  const dup = await scan(`${typoBase}/`);
  assert.equal(dup.ok, true, 'dup-spelling scan succeeds');
  const cryptoUrl = `${typoBase}/cat-crypto/`;
  assert.ok(dup.payload.pages.includes(cryptoUrl), 'canonical page present');
  assert.equal(
    dup.payload.pages.filter((u) => u === cryptoUrl).length,
    1,
    `canonical final URL appears exactly once (got ${JSON.stringify(dup.payload.pages)})`,
  );
  assert.ok(
    !dup.payload.pages.some((u) => u.includes('cat-crypto-typo')),
    'the redirect-converged duplicate spelling never reaches the scanned set',
  );

  // Control: the SAME site whose sitemap lists only the canonical spelling.
  const ctrl = await scan(`${ctrlBase}/`);
  assert.equal(ctrl.ok, true, 'control scan succeeds');

  // The converge pair must NOT produce the self-comparison receipt or 100.
  assert.ok(
    !dup.payload.breakdown.crossPage.findings.some((f) => f.includes('near-identical page pair')),
    'no "near-identical page pair" receipt after dedupe',
  );
  assert.notEqual(dup.payload.breakdown.crossPage.score, 100, 'crossPage is not 100 from the convergence');

  // Convergence no longer inflates: same crossPage, same rollup as the control.
  assert.equal(
    dup.payload.breakdown.crossPage.score,
    ctrl.payload.breakdown.crossPage.score,
    `crossPage matches the no-duplicate site (${dup.payload.breakdown.crossPage.score} vs ${ctrl.payload.breakdown.crossPage.score})`,
  );
  assert.equal(
    dup.payload.slopScore,
    ctrl.payload.slopScore,
    `rollup matches the no-duplicate site (${dup.payload.slopScore} vs ${ctrl.payload.slopScore})`,
  );
  assert.equal(dup.payload.crawlFetched, ctrl.payload.crawlFetched, 'one converged slot is freed, matching the control page count');
});

// ---------------------------------------------------------------------------
// Layer 1 integration: an additional page that redirects ONTO THE TARGET
// ---------------------------------------------------------------------------
test('redirect onto the target: the additional page is dropped, target is never compared with itself', async () => {
  const res = await scan(`${targetBase}/`);
  assert.equal(res.ok, true);
  assert.equal(res.payload.crawlFetched, 1, 'the twin that 301s onto the target collapses into the target');
  assert.equal(res.payload.crawlDiscovered, 2, 'still reported as discovered (target + the twin candidate)');
  assert.ok(!('pages' in res.payload), 'single distinct page -> no page list (scan is single-page after dedupe)');
  // Single distinct page, no in-page phrase signal -> crossPage is null
  // (nothing to compare), NOT 100.
  assert.equal(res.payload.breakdown.crossPage.score, null, 'crossPage has nothing to compare, never 100');
  assert.ok(
    !res.payload.breakdown.crossPage.findings.some((f) => f.includes('near-identical page pair')),
    'no self-comparison receipt',
  );
});