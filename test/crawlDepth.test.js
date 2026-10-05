import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { SsrfError } from '../src/fetch/ssrf.js';
import { discoverPages, MAX_ADDITIONAL_PAGES } from '../src/rules/discover.js';
import { createReportToken } from '../src/paywall.js';

/**
 * Crawl-depth disclosure (owner decision 2026-10-05, option a):
 * keep MAX_TOTAL_PAGES = 5, disclose "we evaluated N of M pages".
 *
 *   fetched    = pages actually analyzed (target + additional that fetched OK)
 *   discovered = target + deduped same-host candidates the site exposed via
 *                sitemap/links BEFORE the cap (never sliced)
 *
 * N is stored as crawl_fetched, M as crawl_discovered (nullable ints). The
 * paid report's Methodology gains a scope line and the free surfaces (result
 * page + free JSON) surface the same two numbers — old rows (nulls) render
 * NO line and NO crawl field.
 */

const SECRET = 'crawl-depth-test-secret';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-depth-')), 'test.db');

// --- Fixture fetchers (offline; keep the app's SSRF shape) ------------------

/** Test-only fetcher that routes to a local fixture server (phase2 pattern). */
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

const fixtureTarget = async (raw) => {
  const u = new URL(String(raw).trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('Only http(s) URLs allowed');
  return u;
};

function startApp(dbPath, fetcher) {
  const app = createApp({ dbPath, fetcher, validateTarget: fixtureTarget, reportTokenSecret: SECRET });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const postScan = (base, url) => fetch(`${base}/api/v1/scan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url }),
});

const freeHtml = (base, id) => fetch(`${base}/report/${id}`).then((r) => r.text());
const freeJson = (base, id) => fetch(`${base}/api/v1/scans/${id}`).then((r) => r.json());
const paidHtml = (base, id) => fetch(
  `${base}/api/v1/report/${id}?token=${createReportToken(SECRET, id)}`,
).then((r) => r.text());

/**
 * A "blog-like" fixture site: sitemap exposes 24 pages total (the target home +
 * 23 posts) but the scanner is capped at 5. The real-world analogy is
 * blog2posts.com, whose sitemap exposes 23 non-target pages (1 + 23 = 24).
 */
const BLOG_PAGE_TEXT = [
  'Every morning the operations team reviews the queue and assigns tasks before nine.',
  'The scheduling rules prefer the shortest job first when two jobs arrive together.',
  'Metrics are collected from every worker every fifteen minutes and stored in the central log.',
  'The postmortem process documents each incident with a root cause and an owner.',
  'Capacity planning happens each quarter and feeds directly into the hiring plan.',
].join(' ');

function buildBlogFixture(port) {
  const sitemapEntries = [`http://127.0.0.1:${port}/`];
  for (let i = 1; i <= 23; i += 1) sitemapEntries.push(`http://127.0.0.1:${port}/p/${String(i).padStart(2, '0')}`);
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapEntries
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;
  return (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/sitemap.xml') return res.end(sitemap);
    if (p === '/') {
      return res.end(`<!doctype html><html><head><title>Blog Home</title></head><body>
        <main><p>${BLOG_PAGE_TEXT}</p></main>
        <footer>Made with care.</footer>
      </body></html>`);
    }
    if (p.startsWith('/p/')) {
      return res.end(`<!doctype html><html><head><title>Post ${p}</title></head><body>
        <main><p>${BLOG_PAGE_TEXT} Post ${p} details.</p></main>
      </body></html>`);
    }
    res.writeHead(404).end('not found');
  };
}

/** A single-page fixture: no sitemap, no internal links. */
function singlePageHandler(req, res) {
  if (req.url.split('?')[0] === '/') {
    return res.end(`<!doctype html><html><head><title>Single</title></head><body>
      <main><p>${BLOG_PAGE_TEXT}</p></main>
      <footer>Made with care.</footer>
    </body></html>`);
  }
  res.writeHead(404).end('not found');
}

let blogSrv, blogBase, blogPort;
let singleSrv, singleBase, singlePort;

before(async () => {
  blogSrv = http.createServer((req, res) => buildBlogFixture(blogSrv.address().port)(req, res));
  await new Promise((r) => blogSrv.listen(0, '127.0.0.1', r));
  blogPort = blogSrv.address().port;
  blogBase = `http://127.0.0.1:${blogPort}`;

  singleSrv = http.createServer(singlePageHandler);
  await new Promise((r) => singleSrv.listen(0, '127.0.0.1', r));
  singlePort = singleSrv.address().port;
  singleBase = `http://127.0.0.1:${singlePort}`;
});

after(() => {
  for (const s of [blogSrv, singleSrv]) {
    s.closeAllConnections?.();
    s.close();
  }
});

// ---------------------------------------------------------------------------
// Unit: discoverPages totalDiscovered
// ---------------------------------------------------------------------------

test('discoverPages: 10-entry sitemap -> totalDiscovered 9 after target exclusion, additional capped at 4', async () => {
  const fetcher = {
    async fetchHtml(u) {
      if (new URL(u).pathname === '/sitemap.xml') {
        const entries = ['http://example.com/'];
        for (let i = 1; i <= 9; i += 1) entries.push(`http://example.com/page${i}`);
        return {
          status: 200,
          url: u,
          body: `<?xml version="1.0"?><urlset>${entries.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`,
        };
      }
      return { status: 404, url: u, body: '' };
    },
  };
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml: '<html></html>', fetcher });
  assert.equal(res.source, 'sitemap');
  assert.equal(res.additional.length, MAX_ADDITIONAL_PAGES, `additional capped at ${MAX_ADDITIONAL_PAGES}`);
  assert.equal(res.totalDiscovered, 9, 'target excluded; all 9 others counted despite the cap');
  assert.ok(!res.additional.includes('http://example.com/'), 'target never in additional');
});

test('discoverPages: link fallback counts sitemap + link candidates together', async () => {
  const fetcher = {
    async fetchHtml(u) {
      if (new URL(u).pathname === '/sitemap.xml') {
        return {
          status: 200,
          url: u,
          body: '<?xml version="1.0"?><urlset><url><loc>http://example.com/</loc></url><url><loc>http://example.com/a</loc></url></urlset>',
        };
      }
      return { status: 404, url: u, body: '' };
    },
  };
  const targetHtml = `<html><body>
    <a href="/b">b</a>
    <a href="/c">c</a>
    <a href="/a">dup of sitemap entry</a>
    <a href="http://external.org/">out</a>
    <a href="/">self</a>
  </body></html>`;
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml, fetcher });
  assert.equal(res.source, 'sitemap');
  assert.equal(res.totalDiscovered, 3, '1 sitemap entry (/a) + 2 unique links (/b, /c) — deduped, external/self dropped');
  assert.equal(res.additional.length, 3);
  assert.deepEqual(res.additional, ['http://example.com/a', 'http://example.com/b', 'http://example.com/c']);
});

test('discoverPages: nothing exposed -> totalDiscovered 0', async () => {
  const fetcher = { async fetchHtml(u) { return { status: 404, url: u, body: '' }; } };
  const res = await discoverPages({ targetUrl: 'http://example.com/', targetHtml: '<html><body><a href="/x.pdf">pdf</a></body></html>', fetcher });
  assert.equal(res.additional.length, 0);
  assert.equal(res.source, 'none');
  assert.equal(res.totalDiscovered, 0, 'non-HTML candidate dropped, target excluded');
});

// ---------------------------------------------------------------------------
// Integration: blog-like site with a 24-page sitemap (the honest "5 of 24")
// ---------------------------------------------------------------------------

test('scan of a 24-page site: row stores crawl_fetched 5 / crawl_discovered 24; free POST JSON carries crawl', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, fixtureFetcher());
  try {
    const res = await postScan(app.base, `${blogBase}/`);
    assert.equal(res.status, 200, 'scan succeeds');
    const body = await res.json();
    // Free JSON surfaces the two numbers and NOTHING else about the crawl.
    assert.deepEqual(body.crawl, { fetched: 5, discovered: 24 });
    assert.ok(!('pages' in body), 'page lists stay behind the paywall');
    assert.ok(!('worstPage' in body), 'worstPage stays behind the paywall');

    // Row-level persistence.
    const repository = openDb(dbPath);
    try {
      const row = repository.getScan(body.id);
      assert.equal(row.crawlFetched, 5, 'crawl_fetched stored');
      assert.equal(row.crawlDiscovered, 24, 'crawl_discovered stored');
      assert.equal(row.url, `${blogBase}/`, 'target url stored');
    } finally {
      repository.close();
    }
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

test('paid report Methodology contains the scope line with the right N/M (5 of 24)', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, fixtureFetcher());
  try {
    const res = await postScan(app.base, `${blogBase}/`);
    const { id } = await res.json();
    const paid = await paidHtml(app.base, id);
    assert.ok(
      paid.includes('Scope: this report evaluated 5 of the 24 pages found on this site (the scanner reviews up to 5 pages per scan by design).'),
      'paid report discloses the honest 5-of-24 scope',
    );
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

test('free result page surfaces the same honesty (5 of 24) without any page lists', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, fixtureFetcher());
  try {
    const res = await postScan(app.base, `${blogBase}/`);
    const { id } = await res.json();
    const html = await freeHtml(app.base, id);
    assert.ok(
      html.includes('This scan evaluated 5 of the 24 pages found on this site (up to 5 pages are reviewed per scan by design).'),
      'free page discloses the scope',
    );
    assert.ok(!html.includes('Pages scanned:'), 'free page never lists the fetched pages');
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

test('single-page site: fetched 1 of discovered 1 (honest floor)', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, fixtureFetcher());
  try {
    const res = await postScan(app.base, `${singleBase}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.crawl, { fetched: 1, discovered: 1 });
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Old rows (nulls): no line, no crawl field — graceful everywhere
// ---------------------------------------------------------------------------

const MINIMAL_BREAKDOWN = {
  filler: { score: 0, findings: [] },
  boilerplate: { score: 0, findings: [] },
  infoDensity: { score: 0, findings: [] },
  repetitive: { score: 0, findings: [] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: [] },
};

test('old rows (no crawl columns data): free JSON has NO crawl field, no page lists', async () => {
  const dbPath = tmpDb();
  const repository = openDb(dbPath);
  repository.insertScan({
    id: 'legacy-row-0001',
    url: 'https://legacy.example/',
    score: 7,
    breakdown: MINIMAL_BREAKDOWN,
    createdAt: new Date().toISOString(),
  });
  repository.close();

  const app = startApp(dbPath, fixtureFetcher());
  try {
    const json = await freeJson(app.base, 'legacy-row-0001');
    assert.ok(!('crawl' in json), 'old row -> no crawl field');
    assert.equal(json.score, 7);
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

test('old rows: paid report renders NO scope line, free page renders NO line', async () => {
  const dbPath = tmpDb();
  const repository = openDb(dbPath);
  repository.insertScan({
    id: 'legacy-row-0002',
    url: 'https://legacy.example/',
    score: 7,
    breakdown: MINIMAL_BREAKDOWN,
    createdAt: new Date().toISOString(),
  });
  repository.close();

  const app = startApp(dbPath, fixtureFetcher());
  try {
    const paid = await paidHtml(app.base, 'legacy-row-0002');
    assert.ok(paid.includes('Methodology'), 'methodology section still renders');
    assert.ok(!paid.includes('Scope: this report evaluated'), 'old row -> no scope line in paid report');

    const html = await freeHtml(app.base, 'legacy-row-0002');
    assert.ok(!html.includes('This scan evaluated'), 'old row -> no scope line on the free page');
  } finally {
    app.server.closeAllConnections?.();
    app.server.close();
  }
});

test('DB migration: guarded ALTER adds crawl columns to a v1-era DB without touching existing rows', async () => {
  const dbPath = tmpDb();
  // Simulate a database created before this feature: create the scans table
  // WITHOUT the crawl columns and insert a row, using raw SQL.
  const repository = openDb(dbPath);
  repository.raw.exec('DROP TABLE IF EXISTS scans');
  repository.raw.exec(`CREATE TABLE scans (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, score INTEGER NOT NULL,
    breakdown TEXT NOT NULL, created_at TEXT NOT NULL,
    partial INTEGER, note TEXT, worst_page TEXT,
    branding TEXT, roast TEXT, business_name TEXT, internal INTEGER NOT NULL DEFAULT 0
  )`);
  repository.raw.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at, internal) VALUES (?, ?, ?, ?, ?, 0)',
  ).run('pre-migration-row', 'https://old.example/', 12, JSON.stringify(MINIMAL_BREAKDOWN), '2026-09-01T00:00:00.000Z');
  repository.close();

  // Reopen: openDb must ALTER-add the crawl columns (guarded), keep the row.
  const reopened = openDb(dbPath);
  try {
    const cols = reopened.raw.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
    assert.ok(cols.includes('crawl_fetched'), 'crawl_fetched column added');
    assert.ok(cols.includes('crawl_discovered'), 'crawl_discovered column added');
    const old = reopened.getScan('pre-migration-row');
    assert.equal(old.url, 'https://old.example/', 'pre-migration row intact');
    assert.equal(old.crawlFetched, undefined, 'old row reads crawlFetched as undefined');
    assert.equal(old.crawlDiscovered, undefined, 'old row reads crawlDiscovered as undefined');
    // And a fresh insert with counts works on the migrated schema.
    reopened.insertScan({
      id: 'fresh-row-0001',
      url: 'https://fresh.example/',
      score: 7,
      breakdown: MINIMAL_BREAKDOWN,
      createdAt: '2026-10-05T00:00:00.000Z',
      crawlFetched: 5,
      crawlDiscovered: 24,
    });
    const fresh = reopened.getScan('fresh-row-0001');
    assert.equal(fresh.crawlFetched, 5);
    assert.equal(fresh.crawlDiscovered, 24);
  } finally {
    reopened.close();
  }
});