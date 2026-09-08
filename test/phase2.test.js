import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { Fetcher } from '../src/fetch/client.js';
import { SsrfError } from '../src/fetch/ssrf.js';
import { extractMainText } from '../src/text.js';
import { shingleJaccard } from '../src/rules/similarity.js';
import { analyzeCrossPage, DUPLICATION_THRESHOLD } from '../src/rules/crossPage.js';
import { analyzeFingerprints, FINGERPRINTS, CONFIDENCE_WEIGHT } from '../src/rules/fingerprints.js';
import { parseSitemap, normalizeCandidate, discoverPages, MAX_ADDITIONAL_PAGES, MAX_TOTAL_PAGES } from '../src/rules/discover.js';
import { computeSlopScore, RULE_WEIGHTS, FULL_RULE_WEIGHTS } from '../src/scorer.js';
import { runRules } from '../src/rules/index.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-p2-')), 'test.db');

// ---------------------------------------------------------------------------
// Fixture site: 3 pages (two near-identical main contents) + a sitemap.
// The v0.dev asset on the target page gives the fingerprints rule real evidence.
// ---------------------------------------------------------------------------

const SHARED_MAIN = [
  'Every morning the operations team reviews the queue and assigns tasks before nine.',
  'The scheduling rules prefer the shortest job first when two jobs arrive together.',
  'Metrics are collected from every worker every fifteen minutes and stored in the central log.',
  'The postmortem process documents each incident with a root cause and an owner.',
  'Capacity planning happens each quarter and feeds directly into the hiring plan.',
  'The on-call roster rotates weekly and every engineer participates at least once.',
].join(' ');

const DISTINCT_MAIN = [
  'The company sells accounting software to mid-size firms.',
  'Customers import their ledgers and reconcile accounts daily.',
  'The dashboard shows invoices, expenses, and cash flow in real time.',
  'Support is available every weekday from eight to six.',
  'Each account has a dedicated analyst who answers within two hours.',
  'The product roadmap is published quarterly and shaped by customer interviews.',
].join(' ');

const NAV = (port) => `
  <nav>
    <a href="http://127.0.0.1:${port}/">Home</a>
    <a href="http://127.0.0.1:${port}/about">About</a>
    <a href="http://127.0.0.1:${port}/contact#top">Contact</a>
    <a href="http://www.iana.org/domains/example">External</a>
  </nav>`;

const page = (port, title, mainHtml) => `<!doctype html><html><head>
  <title>${title}</title>
  <script src="https://v0.dev/chat.js"></script>
</head><body>
  ${NAV(port)}
  <main>${mainHtml}</main>
  <footer>Made with care and coffee.</footer>
</body></html>`;

const SITEMAP = (port) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/</loc></url>
  <url><loc>http://127.0.0.1:${port}/about</loc></url>
  <url><loc>http://127.0.0.1:${port}/contact</loc></url>
</urlset>`;

/** Route a path to fixture HTML (or 404). */
function fixtureHandler(port) {
  return (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/sitemap.xml') return res.end(SITEMAP(port));
    if (p === '/') return res.end(page(port, 'Acme Home', `  <p>${SHARED_MAIN}</p>`));
    if (p === '/about') return res.end(page(port, 'About Acme', `  <p>${SHARED_MAIN}</p><p>The team meets on Thursdays.</p>`));
    if (p === '/contact') return res.end(page(port, 'Contact Acme', `  <p>${DISTINCT_MAIN}</p>`));
    res.writeHead(404).end('not found');
  };
}

/**
 * Test-only fetcher that routes to the fixture. The production Fetcher blocks
 * loopback targets (SSRF) by design; the injectable fetcher is how the codebase
 * supports end-to-end tests against a local fixture (same pattern as api.test.js).
 * SSRF-on-every-page is a property of the shared Fetcher object — asserted in
 * the dedicated "SSRF applies to discovery" test below.
 */
function fixtureFetcher() {
  return {
    async fetchHtml(rawUrl, { signal } = {}) {
      const u = new URL(String(rawUrl).trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('Only http(s) URLs allowed');
      if (u.hostname !== '127.0.0.1') throw new SsrfError(`test fetcher refuses non-fixture host ${u.hostname}`);
      const res = await fetch(u.href, { signal });
      return { status: res.status, url: u.href, body: await res.text() };
    },
  };
}

function startApp(dbPath, fetcher, scanBudgetMs) {
  const app = createApp({ dbPath, fetcher, scanBudgetMs });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

function postScan(base, url, extra = {}) {
  return fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, ...extra }),
  });
}

// ---------------------------------------------------------------------------
// Fixture servers (started once for all integration tests)
// ---------------------------------------------------------------------------
let multiSrv;   // 3 pages + sitemap
let multiBase;
let multiPort;

let singleSrv;  // single page, no sitemap, no internal links
let singleBase;
let singlePort;

let slowSrv;    // sitemap lists /slow which never responds
let slowBase;
let slowPort;

before(async () => {
  multiSrv = http.createServer((req, res) => fixtureHandler(multiSrv.address().port)(req, res));
  await new Promise((r) => multiSrv.listen(0, '127.0.0.1', r));
  multiPort = multiSrv.address().port;
  multiBase = `http://127.0.0.1:${multiPort}`;

  singleSrv = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/') {
      // NO internal links on purpose: discovery must find 0 additional pages.
      res.end(`<!doctype html><html><head><title>Single Page</title></head><body>
        <main><p>${SHARED_MAIN}</p></main>
        <footer>Made with care.</footer>
      </body></html>`);
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => singleSrv.listen(0, '127.0.0.1', r));
  singlePort = singleSrv.address().port;
  singleBase = `http://127.0.0.1:${singlePort}`;

  slowSrv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/sitemap.xml') {
      const port = slowSrv.address().port;
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://127.0.0.1:${port}/</loc></url>
        <url><loc>http://127.0.0.1:${port}/fast</loc></url>
        <url><loc>http://127.0.0.1:${port}/slow</loc></url>
      </urlset>`);
    } else if (p === '/') {
      const port = slowSrv.address().port;
      res.end(`<!doctype html><html><body><main><p>${SHARED_MAIN}</p></main></body></html>`);
    } else if (p === '/fast') {
      const port = slowSrv.address().port;
      res.end(`<!doctype html><html><body><main><p>${DISTINCT_MAIN}</p></main></body></html>`);
    } else if (p === '/slow') {
      // Never respond — exercises the budget-expiry abort. The client's
      // AbortController destroys the TCP connection; after() force-closes any
      // remaining sockets. No timer here: a pending timer would keep the test
      // process's event loop alive after the suite finishes.
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
  slowPort = slowSrv.address().port;
  slowBase = `http://127.0.0.1:${slowPort}`;
});

after(() => {
  // closeAllConnections: undici keeps completed-response sockets alive (keep-alive),
  // which would otherwise make server.close() (and thus node --test) hang.
  for (const s of [multiSrv, singleSrv, slowSrv]) {
    s.closeAllConnections?.();
    s.close();
  }
});

// ---------------------------------------------------------------------------
// Unit: similarity (word 4-gram Jaccard)
// ---------------------------------------------------------------------------

test('similarity: identical -> 1.0, disjoint -> 0, symmetric', () => {
  const a = 'alpha beta gamma delta epsilon zeta eta theta'.split(' ');
  const b = [...a];
  assert.equal(shingleJaccard(a, b), 1);
  assert.equal(shingleJaccard(a, 'w x y z'.split(' ')), 0);
  assert.equal(shingleJaccard(a, a), 1);
  const c = 'alpha beta gamma delta omega psi chi rho'.split(' ');
  assert.equal(shingleJaccard(a, c), shingleJaccard(c, a), 'symmetric');
  assert.equal(shingleJaccard(a, []), 0);
  assert.equal(shingleJaccard([], []), 0);
  assert.equal(shingleJaccard(['only', 'three', 'words'], ['only', 'three', 'words']), 0, 'fewer than 4 words -> 0');
});

test('similarity: shared 4-grams are the unit of similarity', () => {
  const base = 'one two three four five six seven eight nine ten'.split(' ');
  const samePrefix = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
  const j = shingleJaccard(base, samePrefix);
  assert.ok(j > 0.5 && j < 0.85, `expected partial similarity, got ${j}`);
});

// ---------------------------------------------------------------------------
// Unit: scorer weights + renormalization
// ---------------------------------------------------------------------------

test('scorer: full phase-2 weights sum to 1.00 with crossPage the largest', () => {
  const total = Object.values(FULL_RULE_WEIGHTS).reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(total - 1.0) < 1e-9, `sum ${total}`);
  for (const [k, w] of Object.entries(FULL_RULE_WEIGHTS)) {
    assert.ok(w <= FULL_RULE_WEIGHTS.crossPage, `${k} weight ${w} must not exceed crossPage`);
  }
  const v1Keys = Object.keys(RULE_WEIGHTS);
  const v1Ratio = v1Keys.map((k) => FULL_RULE_WEIGHTS[k] / RULE_WEIGHTS[k]);
  assert.ok(v1Ratio.every((r) => Math.abs(r - v1Ratio[0]) < 1e-9), 'v1 modules keep v1 relative ratios');
});

test('scorer: crossPage skipped (null) -> renormalized 4-cat weights EQUAL v1 weights', () => {
  const six = {
    filler: { score: 100 }, boilerplate: { score: 50 }, infoDensity: { score: 0 },
    repetitive: { score: 40 }, crossPage: { score: 90 }, fingerprints: { score: 100 },
  };
  const withCross = computeSlopScore(six);
  assert.equal(withCross.components.crossPage.weight, FULL_RULE_WEIGHTS.crossPage);
  assert.equal(withCross.components.fingerprints.weight, FULL_RULE_WEIGHTS.fingerprints);

  const skipped = { ...six, crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' } };
  const renorm = computeSlopScore(skipped);
  // The four v1 categories hold EXACTLY their v1 weights (single-page scans
  // reproduce v1 scoring bit-identically).
  for (const [k, w] of Object.entries(RULE_WEIGHTS)) {
    assert.equal(renorm.components[k].weight, w, `${k} weight should equal v1 ${w}`);
  }
  assert.equal(renorm.components.fingerprints.weight, 0, 'fingerprints excluded when crossPage skipped');
  // Score equals a pure v1 computation (fingerprint evidence does not move it).
  const v1Only = computeSlopScore({
    filler: { score: 100 }, boilerplate: { score: 50 }, infoDensity: { score: 0 }, repetitive: { score: 40 },
  });
  assert.equal(renorm.slopScore, v1Only.slopScore, 'single-page score == v1 score');
});

test('scorer: full 6-cat composite respects weights', () => {
  const r = computeSlopScore({
    filler: { score: 100 }, boilerplate: { score: 100 }, infoDensity: { score: 100 },
    repetitive: { score: 100 }, crossPage: { score: 100 }, fingerprints: { score: 100 },
  });
  assert.equal(r.slopScore, 100);
  const zero = computeSlopScore({
    filler: { score: 0 }, boilerplate: { score: 0 }, infoDensity: { score: 0 },
    repetitive: { score: 0 }, crossPage: { score: 0 }, fingerprints: { score: 0 },
  });
  assert.equal(zero.slopScore, 0);
  const onlyCross = computeSlopScore({ crossPage: { score: 100 } });
  assert.equal(onlyCross.slopScore, 30, 'crossPage alone contributes its 0.30 weight');
});

// ---------------------------------------------------------------------------
// Unit: fingerprints
// ---------------------------------------------------------------------------

const V0_HTML = `<!doctype html><html><head>
  <meta name="generator" content="Framer" />
  <script src="https://v0.dev/chat.js"></script>
</head><body>
  <p>Welcome to our platform.</p>
  <footer>Made with Framer</footer>
</body></html>`;

const CLEAN_HTML = `<!doctype html><html><head><title>Plain</title></head><body>
  <p>Real engineering documentation with specific details and code examples.</p>
</body></html>`;

test('fingerprints: known builder marker hit + wording rule', () => {
  const r = analyzeFingerprints({
    html: V0_HTML,
    head: '<meta name="generator" content="Framer" /><script src="https://v0.dev/chat.js"></script>',
    text: 'Welcome to our platform. Made with Framer',
  });
  assert.ok(r.score > 0, `score ${r.score}`);
  const ids = r.hits.map((h) => h.id);
  assert.ok(ids.includes('v0.dev'), `hits: ${ids.join(', ')}`);
  assert.ok(ids.includes('named-builder-generator'), `hits: ${ids.join(', ')}`);
  for (const f of r.findings) {
    assert.match(f, /template-like|AI-builder-associated|unmodified-template marker/, `wording: ${f}`);
    assert.ok(!/AI-?generated/i.test(f), 'never asserts AI authorship');
  }
  // confidence weight ordering: high > medium > low
  assert.ok(CONFIDENCE_WEIGHT.high > CONFIDENCE_WEIGHT.medium && CONFIDENCE_WEIGHT.medium > CONFIDENCE_WEIGHT.low);
  // one finding per fingerprint id (dedupe)
  assert.equal(r.hits.length, new Set(r.hits.map((h) => h.id)).size);
});

test('fingerprints: clean page -> score 0, no hits', () => {
  const r = analyzeFingerprints({ html: CLEAN_HTML, head: '', text: 'Real engineering documentation with specific details and code examples.' });
  assert.equal(r.score, 0);
  assert.equal(r.hits.length, 0);
});

test('fingerprints: patterns are compiled from fingerprints.json (extensible, no code change)', () => {
  assert.ok(Array.isArray(FINGERPRINTS) && FINGERPRINTS.length >= 10);
  for (const fp of FINGERPRINTS) {
    assert.ok(typeof fp.id === 'string' && fp.id.length > 0);
    assert.ok(['high', 'medium', 'low'].includes(fp.confidence));
    assert.ok(['head', 'html', 'text'].includes(fp.scope));
    assert.ok(Array.isArray(fp.patterns) && fp.patterns.length > 0);
    for (const p of fp.patterns) new RegExp(p, 'i'); // must compile
  }
});

// ---------------------------------------------------------------------------
// Unit: sitemap parser + discovery
// ---------------------------------------------------------------------------

test('parseSitemap: urlset entries and index detection', () => {
  const urlset = parseSitemap('<?xml version="1.0"?><urlset><url><loc>https://a.com/</loc></url><url><loc>https://a.com/x</loc></url></urlset>');
  assert.deepEqual(urlset.urls, ['https://a.com/', 'https://a.com/x']);
  assert.equal(urlset.isIndex, false);
  const index = parseSitemap('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(index.urls.length, 0);
  assert.equal(index.isIndex, true);
  assert.deepEqual(parseSitemap('not xml at all').urls, []);
});

test('normalizeCandidate: origin rules, fragments, non-HTML, https preference', () => {
  const target = new URL('https://example.com/');
  assert.equal(normalizeCandidate('https://example.com/about', target).href, 'https://example.com/about');
  assert.equal(normalizeCandidate('/about#team', target).href, 'https://example.com/about', 'fragment stripped');
  assert.equal(normalizeCandidate('http://example.com/about', target).href, 'https://example.com/about', 'https preferred on https target');
  assert.equal(normalizeCandidate('https://other.org/', target), null);
  assert.equal(normalizeCandidate('mailto:x@y.z', target), null);
  assert.equal(normalizeCandidate('/docs/paper.pdf', target), null);
  assert.equal(normalizeCandidate('/img/photo.PNG?w=100', target), null);
  assert.equal(normalizeCandidate('/blog/', target).href, 'https://example.com/blog/', 'trailing slash preserved');
  const httpTarget = new URL('http://example.com/');
  assert.equal(normalizeCandidate('http://example.com/x', httpTarget).href, 'http://example.com/x', 'http kept on http target');
});

test('discovery: sitemap dedupe/cap/origin + target exclusion, deterministic order', async () => {
  const fetcher = {
    async fetchHtml(rawUrl) {
      const u = new URL(rawUrl);
      if (u.pathname === '/sitemap.xml') {
        return { status: 200, url: u.href, body: `<?xml version="1.0"?><urlset>
          <url><loc>http://example.com/</loc></url>
          <url><loc>http://example.com/</loc></url>
          <url><loc>http://example.com/a</loc></url>
          <url><loc>http://example.com/b</loc></url>
          <url><loc>http://example.com/c</loc></url>
          <url><loc>http://example.com/d</loc></url>
          <url><loc>http://example.com/e</loc></url>
          <url><loc>http://external.org/f</loc></url>
          <url><loc>http://example.com/report.pdf</loc></url>
          <url><loc>http://example.com/a#frag</loc></url>
        </urlset>` };
      }
      return { status: 404, url: u.href, body: '' };
    },
  };
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml: '<html></html>', fetcher });
  assert.equal(res.source, 'sitemap');
  assert.equal(res.additional.length, MAX_ADDITIONAL_PAGES, `capped at ${MAX_ADDITIONAL_PAGES}`);
  assert.equal(new Set(res.additional).size, res.additional.length, 'deduped');
  for (const u of res.additional) assert.ok(u.startsWith('http://example.com/'), u);
  assert.ok(!res.additional.includes('http://example.com/'), 'target excluded');
  assert.ok(!res.additional.includes('http://example.com/report.pdf'), 'non-HTML dropped');
  assert.ok(!res.additional.includes('http://external.org/f'), 'external dropped');
  // deterministic: same input -> same output
  const again = await discoverPages({ targetUrl: 'http://example.com/', targetHtml: '<html></html>', fetcher });
  assert.deepEqual(again.additional, res.additional);
});

test('discovery: sitemap index at /sitemap.xml resolves /sitemap_index.xml', async () => {
  const fetcher = {
    async fetchHtml(rawUrl) {
      const u = new URL(rawUrl);
      if (u.pathname === '/sitemap.xml') {
        return { status: 200, url: u.href, body: '<sitemapindex><sitemap><loc>http://example.com/s1.xml</loc></sitemap></sitemapindex>' };
      }
      if (u.pathname === '/sitemap_index.xml') {
        return { status: 200, url: u.href, body: '<urlset><url><loc>http://example.com/p1</loc></url></urlset>' };
      }
      return { status: 404, url: u.href, body: '' };
    },
  };
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml: '', fetcher });
  assert.deepEqual(res.additional, ['http://example.com/p1']);
  assert.equal(res.source, 'sitemap');
});

test('discovery: link fallback fills slots with https-first deterministic order', async () => {
  const fetcher = {
    async fetchHtml(_rawUrl) { return { status: 404, url: '', body: '' }; },
  };
  // Target is http, so http links are NOT upgraded: the https-first deterministic
  // sort must place https candidates before http ones.
  const targetHtml = `<html><body>
    <a href="/a">a</a>
    <a href="/b#x">b</a>
    <a href="http://example.com/a">dup</a>
    <a href="https://example.com/z">z</a>
    <a href="http://example.com/m">m</a>
    <a href="http://external.org/">out</a>
    <a href="/doc.pdf">pdf</a>
    <a href="mailto:x@y.z">mail</a>
    <a href="/c">c</a>
    <a href="/">self</a>
  </body></html>`;
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml, fetcher });
  assert.equal(res.source, 'links');
  assert.deepEqual(res.additional, [
    'https://example.com/z',
    'http://example.com/a',
    'http://example.com/b',
    'http://example.com/c',
  ]);
});

test('SSRF applies to discovery pages too (same Fetcher object, never bypassed)', async () => {
  // A real Fetcher (validateUrl + resolveAndCheck) must refuse to even attempt
  // loopback URLs during discovery AND for every discovered additional page.
  const spy = { hits: 0 };
  const fetcher = new Fetcher({
    fetchImpl: async () => { spy.hits += 1; throw new Error('must not be reached'); },
  });
  const res = await discoverPages({
    targetUrl: 'http://127.0.0.1:9999/',
    targetHtml: '<a href="http://127.0.0.1:9999/x">x</a>',
    fetcher,
  });
  assert.ok(res.sitemapErrors.length > 0, 'sitemap fetch was refused: ' + res.sitemapErrors.join(', '));
  // Link fallback still discovers the same-host candidate...
  assert.deepEqual(res.additional, ['http://127.0.0.1:9999/x']);
  // ...but fetching it with the shared Fetcher is SSRF-blocked (zero network I/O):
  await assert.rejects(() => fetcher.fetchHtml('http://127.0.0.1:9999/x'), SsrfError);
  assert.equal(spy.hits, 0, 'no network I/O happened: SSRF blocks each additional-page fetch');
});

// ---------------------------------------------------------------------------
// Unit: crossPage analyzers
// ---------------------------------------------------------------------------

test('crossPage: <2 pages -> score null + note (graceful skip)', () => {
  const r = analyzeCrossPage({ pages: [{ url: 'http://x/', main: { words: 'a b c d e'.split(' ') } }] });
  assert.equal(r.score, null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.note, 'insufficient pages for cross-page analysis');
  const r0 = analyzeCrossPage({ pages: [] });
  assert.equal(r0.score, null);
});

test('crossPage: flags near-identical main content >= 0.80 and scores from max similarity', () => {
  // 30 DISTINCT tokens -> 27 unique 4-grams; near appends 5 tokens -> union 32
  // shingles (all 27 shared still present); Jaccard = 27/32 = 0.844 >= 0.80.
  const shared = Array.from({ length: 30 }, (_, i) => `w${i}`);
  const near = [...shared, 'extra', 'words', 'here', 'and', 'there'];
  const other = Array.from({ length: 9 }, (_, i) => `y${i}`);
  const r = analyzeCrossPage({
    pages: [
      { url: 'http://x/a', main: { words: shared } },
      { url: 'http://x/b', main: { words: near } },
      { url: 'http://x/c', main: { words: other } },
    ],
  });
  const flagged = r.pairs.filter((p) => p.similarity >= DUPLICATION_THRESHOLD);
  assert.ok(flagged.length >= 1, JSON.stringify(r.pairs));
  const maxSim = Math.max(...flagged.map((p) => p.similarity));
  const expected = Math.round(((maxSim - DUPLICATION_THRESHOLD) / (1 - DUPLICATION_THRESHOLD)) * 100);
  assert.equal(r.score, expected);
  assert.ok(r.score > 0 && r.score <= 100);
  assert.ok(r.findings.some((f) => /near-identical page pair/.test(f)));
  assert.deepEqual(r.pages, ['http://x/a', 'http://x/b', 'http://x/c']);
  // deterministic
  const again = analyzeCrossPage({
    pages: [
      { url: 'http://x/a', main: { words: shared } },
      { url: 'http://x/b', main: { words: near } },
      { url: 'http://x/c', main: { words: other } },
    ],
  });
  assert.deepEqual(again, r);
});

// ---------------------------------------------------------------------------
// Integration: multi-page fixture scan
// ---------------------------------------------------------------------------

test('integration: multi-page scan flags duplication, runs fingerprints, reports worstPage + Templated Content, deterministic', async () => {
  const api = startApp(tmpDb(), fixtureFetcher(), undefined);

  const res = await postScan(api.base, `${multiBase}/`);
  assert.equal(res.status, 200);
  const json = await res.json();

  // full breakdown shape
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive', 'crossPage', 'fingerprints']) {
    assert.ok(rule in json.breakdown, `breakdown.${rule}`);
  }
  // crossPage: flagged near-identical pair (home ~ about, main content)
  assert.ok(json.breakdown.crossPage.score > 0, `crossPage.score ${json.breakdown.crossPage.score}`);
  const flagged = json.breakdown.crossPage.pairs.filter((p) => p.similarity >= DUPLICATION_THRESHOLD);
  assert.ok(flagged.length >= 1, JSON.stringify(json.breakdown.crossPage.pairs));
  const hit = flagged.find((p) => p.pageA.endsWith('/') && p.pageB.includes('/about'));
  assert.ok(hit, 'target page ~ /about flagged');
  assert.ok(hit.similarity >= 0.8, `similarity ${hit.similarity}`);
  // fingerprints evidence on the target page
  assert.ok(json.breakdown.fingerprints.score > 0);
  assert.ok(json.breakdown.fingerprints.findings.some((f) => f.includes('v0.dev')));
  // multi-page metadata
  assert.ok(Array.isArray(json.pages) && json.pages.length === 3, JSON.stringify(json.pages));
  assert.equal(json.partial, undefined);
  assert.ok(json.worstPage && typeof json.worstPage.score === 'number' && json.worstPage.score >= 0 && json.worstPage.score <= 100);
  assert.ok(json.worstPage.url.endsWith('/') || json.worstPage.url.includes('/about'));

  // persisted + HTML report sections
  const resHtml = await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'text/html' } });
  assert.equal(resHtml.status, 200);
  const html = await resHtml.text();
  assert.match(html, /A\.S\.S\. Score: /);
  assert.ok(
    html.includes(
      'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.'
    ),
    'report carries the mandated disclaimer'
  );
  assert.ok(html.includes('🔁 Duplicate language across pages'), 'crossPage renders under its branded emoji label');
  assert.match(html, /Worst Page/);
  assert.match(html, /Templated Content/);
  assert.match(html, /similar/);

  // determinism: two consecutive runs produce identical scores + pairs
  const res2 = await postScan(api.base, `${multiBase}/`);
  const json2 = await res2.json();
  assert.equal(json2.slopScore, json.slopScore);
  assert.deepEqual(json2.breakdown.crossPage.pairs, json.breakdown.crossPage.pairs);
  assert.equal(json2.breakdown.fingerprints.score, json.breakdown.fingerprints.score);
  assert.deepEqual(json2.worstPage, json.worstPage);

  api.server.close();
});

test('integration: single-page fixture -> graceful crossPage skip + 4-cat scoring', async () => {
  const api = startApp(tmpDb(), fixtureFetcher(), undefined);

  const res = await postScan(api.base, `${singleBase}/`);
  assert.equal(res.status, 200);
  const json = await res.json();

  const cross = json.breakdown.crossPage;
  assert.equal(cross.score, null);
  assert.equal(cross.note, 'insufficient pages for cross-page analysis');
  assert.equal(json.pages, undefined, 'no pages key for single-page scans (v1 shape preserved)');

  // score equals the pure v1 four-rule computation
  const body = await (await fetch(`${singleBase}/`)).text();
  const text = (await import('../src/text.js')).extractText(body);
  const v1 = computeSlopScore(runRules(text));
  assert.equal(json.slopScore, v1.slopScore, 'single-page score == v1 score');

  api.server.close();
});

test('integration: budget expiry yields partial results without hanging', async () => {
  const api = startApp(tmpDb(), fixtureFetcher(), 500);

  const started = Date.now();
  const res = await postScan(api.base, `${slowBase}/`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.ok(elapsed < 5000, `must not hang (elapsed ${elapsed}ms)`);
  assert.equal(json.partial, true);
  assert.ok(json.note.includes('/slow'), `note: ${json.note}`);
  assert.ok(json.pages.length >= 2, 'fast page completed, slow page dropped');
  assert.ok(!json.pages.some((u) => u.includes('/slow')), 'stalled page never returned');
  assert.equal(json.breakdown.crossPage.score, 0, '2 completed pages -> crossPage ran without flagged pairs');
  assert.ok(json.breakdown.crossPage.pairs.length === 1);

  api.server.close();
});