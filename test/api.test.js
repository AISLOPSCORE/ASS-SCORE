import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken, DISCLAIMER } from '../src/paywall.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-test-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

// Fake fetcher: lets the API pipeline run without touching the network.
const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

// Route-level SSRF guard, DNS-skipping variant (same convention as
// webhookFulfillment.test.js): the fake fetchers own all network behavior, so
// the guard must reject blocked shapes without resolving hostnames.
const offlineValidateTarget = async (raw) => validateUrl(raw);

// Fixed paywall secret so tests can mint report tokens (createReportToken).
const TOKEN_SECRET = 'api-test-secret';

function startApp(dbPath, fetcher) {
  const app = createApp({ dbPath, fetcher, validateTarget: offlineValidateTarget, reportTokenSecret: TOKEN_SECRET });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

let api; // success-path app with fake fetcher
let blockedApi; // SSRF-path app with the real Fetcher (validation fails before any network I/O)
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath, fakeFetcher(SLOP_HTML));
  blockedApi = startApp(tmpDb(), undefined);
});

after(() => {
  api.server.close();
  blockedApi.server.close();
});

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('POST /api/v1/scan: valid URL -> 200 with id, score (0-100 higher=worse), verdict, breakdown — FREE payload contract', async () => {
  const res = await post(api.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.id === 'string' && json.id.length > 0);
  assert.equal(json.url, 'https://example.com/');
  assert.ok(Number.isInteger(json.score) && json.score >= 0 && json.score <= 100, `public score ${json.score}`);
  assert.ok(!('slopScore' in json), 'internal field name is not exposed');
  assert.equal(typeof json.verdict, 'string', 'grade label present');
  assert.ok(typeof json.createdAt === 'string');
  assert.equal(typeof json.roast, 'string', 'roast line always present');
  assert.equal(json.disclaimer, DISCLAIMER, 'mandated disclaimer rides the free payload');
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive', 'crossPage', 'fingerprints', 'assets']) {
    assert.ok(rule in json.breakdown, `breakdown.${rule}`);
    const entry = json.breakdown[rule];
    // FREE contract: per-category NUMBERS (+note for skipped modules) ONLY —
    // the findings/insights arrays are the PAID content and never leave here.
    assert.ok('score' in entry, `breakdown.${rule}.score present`);
    assert.ok(!('findings' in entry), `breakdown.${rule}.findings stripped from free payload`);
    assert.ok(!('insights' in entry), `breakdown.${rule}.insights stripped from free payload`);
  }
  assert.equal(typeof json.breakdown.crossPage.note, 'string', 'skipped-module note passes through');
  // teasers: 1-2 findings in full three-layer format, seeded per scan id.
  assert.ok(Array.isArray(json.teasers) && json.teasers.length >= 1 && json.teasers.length <= 2, `1-2 teasers, got ${json.teasers?.length}`);
  for (const t of json.teasers) {
    assert.ok(typeof t.key === 'string' && t.key.length > 0);
    assert.ok(typeof t.roast === 'string' && t.roast.length > 0, 'teaser roast layer');
    assert.ok(typeof t.why === 'string' && t.why.length > 0, 'teaser why layer');
    assert.ok(typeof t.fix === 'string' && t.fix.length > 0, 'teaser fix layer');
    assert.ok(typeof t.evidence === 'string' && t.evidence.length > 0, 'teaser evidence/receipt');
  }
  // Row persisted: the DB keeps the slop score (higher = worse) which IS the
  // public direction — the response reads it unchanged (no inversion). The
  // full findings live in the DB row (paid content), not the free response.
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT id, url, score, breakdown FROM scans WHERE id = ?').get(json.id);
  assert.ok(row, 'row should exist in sqlite');
  assert.equal(row.url, 'https://example.com/');
  assert.equal(row.score, json.score, 'stored score == public score (same direction)');
  const stored = JSON.parse(row.breakdown);
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive']) {
    assert.equal(stored[rule].score, json.breakdown[rule].score, `breakdown.${rule} equal at rest`);
    assert.ok(Array.isArray(stored[rule].findings) && stored[rule].findings.length > 0,
      `breakdown.${rule} findings stay in the DB (paid content)`);
  }
});

test('POST /api/v1/scan: missing/invalid url -> 400', async () => {
  for (const body of [{}, { url: '' }, { url: '   ' }, { url: 42 }]) {
    const res = await post(api.base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_request');
  }
  // A JSON `null` body is rejected by the JSON parser (strict mode) -> 400 too.
  const resNull = await post(api.base, null);
  assert.equal(resNull.status, 400);
});

test('POST /api/v1/scan: malformed JSON body -> 400', async () => {
  const res = await post(api.base, '{nope', { 'content-type': 'application/json' });
  assert.equal(res.status, 400);
});

test('POST /api/v1/scan: SSRF-blocked targets -> 400 before any fetch', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost:3000/', 'http://localhost/',
    'http://169.254.169.254/', 'http://10.0.0.5/', 'http://192.168.1.1/']) {
    const res = await post(blockedApi.base, { url });
    assert.equal(res.status, 400, url);
    const json = await res.json();
    assert.ok(json.error.message.includes('not allowed') || json.error.message.includes('blocked'),
      `expected a clear blocked message for ${url}, got: ${json.error.message}`);
  }
});

test('POST /api/v1/scan: bogus URL string -> 400', async () => {
  for (const url of ['not a url', 'httpx://example.com/', 'file:///etc/passwd', 'http://']) {
    const res = await post(blockedApi.base, { url });
    assert.equal(res.status, 400, url);
  }
});

test('GET /api/v1/scans/:id returns the FREE scan (JSON + teaser HTML); token unlocks the full report', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();

  const resJson = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'application/json' } });
  assert.equal(resJson.status, 200);
  const json = await resJson.json();
  assert.equal(json.id, created.id);
  assert.equal(json.score, created.score, 'GET matches POST public score');
  assert.equal(json.verdict, created.verdict, 'GET carries the same grade label');
  assert.deepEqual(json.teasers, created.teasers, 'teasers stable for the same scan id');
  // FREE JSON: scores only — no findings/insights/pages/worstPage/branding.
  for (const entry of Object.values(json.breakdown)) {
    assert.ok(!('findings' in entry) && !('insights' in entry), 'free JSON breakdown carries numbers only');
  }
  assert.ok(!('pages' in json) && !('worstPage' in json), 'paid-side analysis (pages/worstPage) is not on the free payload');
  assert.ok(!('branding' in json), 'branding is not on the free payload');

  const resHtml = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } });
  assert.equal(resHtml.status, 200);
  assert.match(resHtml.headers.get('content-type'), /text\/html/);
  const html = await resHtml.text();
  assert.match(html, /<!doctype html/i);
  // Branding: the user-facing result page names the product A.S.S. Score,
  // renders the customer-facing category names, and carries the mandated
  // disclaimer verbatim.
  assert.match(html, /A\.S\.S\. Score: /);
  // The free page headline shows the score (higher = worse) + verdict label.
  assert.ok(html.includes(`A.S.S. Score: ${created.score} / 100`), `headline shows public score ${created.score}`);
  assert.ok(html.includes(created.verdict), 'free page shows the verdict grade label');
  for (const name of ['COPY', 'MESSAGING', 'ORIGINALITY', 'STRUCTURE', 'REPETITION', 'DESIGN', 'IMAGERY']) {
    assert.ok(html.includes(name), `free page shows the ${name} category`);
  }
  // FREE page shape: teaser samples + $12 CTA — NOT the paid narrative report.
  assert.ok(html.includes('Free samples'), 'free page shows the teaser samples block');
  assert.ok(html.includes('Unlock the full report'), 'free page carries the $12 checkout CTA');
  assert.ok(!html.includes('<div class="cat-sources" hidden>'), 'full findings section never renders on the free page');
  assert.ok(
    html.includes(
      'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.'
    ),
    'free page carries the mandated disclaimer'
  );

  // PAID HTML (valid token): the full narrative report, every section verbatim.
  const token = createReportToken(TOKEN_SECRET, created.id);
  const paidRes = await fetch(`${api.base}/api/v1/scans/${created.id}?token=${token}`, { headers: { accept: 'text/html' } });
  assert.equal(paidRes.status, 200);
  const paid = await paidRes.text();
  assert.ok(paid.includes('Your Breakdown') && paid.includes("What's Working") && paid.includes('Methodology'), 'narrative sections present');
  assert.ok(paid.includes('<div class="cat-sources" hidden>'), 'findings section present');
  assert.ok(paid.includes('What To Fix First') && paid.includes('Final Verdict'), 'fix + verdict sections present');
  assert.ok(
    paid.includes(
      'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.'
    ),
    'paid report carries the mandated disclaimer'
  );
});

test('pre-flip stored rows read correctly with NO migration: stored 30 -> public 30 + verdict', async () => {
  // Simulate a scan row written BEFORE the earlier score-flip experiment: the
  // DB always stored the slop score (higher = worse), which IS the current
  // public direction — e.g. 30 — with an internal-direction breakdown and no
  // roast column value (pre-roast shape).
  const row = new (await import('better-sqlite3')).default(dbPath);
  const oldId = 'pre-flip-0000-0000-000000000001';
  // The row SHAPE is what this test pins (pre-flip, pre-roast) — the timestamp
  // is kept inside the 30-day report-access window (src/ttl.js) so the token'd
  // render below succeeds; the paid-report access gate is covered separately in
  // paywall.test.js.
  const legacyCreatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  row.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    oldId,
    'https://legacy.example/',
    30,
    JSON.stringify({
      filler: { score: 30, findings: ['legacy finding'] },
      boilerplate: { score: 50, findings: [] },
      infoDensity: { score: 10, findings: [] },
      repetitive: { score: 0, findings: [] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: [], hits: [] },
      assets: { score: 0, findings: [] },
    }),
    legacyCreatedAt
  );
  row.close();

  const res = await fetch(`${api.base}/api/v1/scans/${oldId}`, { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.score, 30, 'stored 30 reads as public 30 (same direction, no inversion)');
  assert.equal(json.verdict, 'ASSY', '30 falls in the 30-39 assy band');
  assert.equal(json.breakdown.filler.score, 30, 'per-category scores read straight from the row');
  assert.equal(json.breakdown.boilerplate.score, 50);
  assert.equal(json.breakdown.crossPage.score, null, 'skipped module passes through');
  // FREE contract: the legacy finding stays OUT of the free payload (it is
  // the paid content) — only the score rides through to free surfaces.
  assert.ok(!('findings' in json.breakdown.filler), 'legacy findings are not on the free payload');
  assert.ok(typeof json.roast === 'string' && json.roast.length > 0, 'roast derived for legacy rows');

  // HTML on the old row (free page): headline + verdict label.
  const html = await (await fetch(`${api.base}/api/v1/scans/${oldId}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(html.includes('A.S.S. Score: 30 / 100'), 'old row headline shows the score');
  assert.ok(html.includes('ASSY'), 'old row report shows the verdict label');

  // The legacy finding surfaces ONLY via the token'd full report.
  const token = createReportToken(TOKEN_SECRET, oldId);
  const paid = await (await fetch(`${api.base}/api/v1/scans/${oldId}?token=${token}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(paid.includes('legacy finding'), 'legacy finding renders in the paid report');
});

test('GET /api/v1/scans/:id missing -> 404', async () => {
  const res = await fetch(`${api.base}/api/v1/scans/does-not-exist`);
  assert.equal(res.status, 404);
});