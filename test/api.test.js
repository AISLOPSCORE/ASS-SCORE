import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';

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

function startApp(dbPath, fetcher) {
  const app = createApp({ dbPath, fetcher, validateTarget: offlineValidateTarget });
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

test('POST /api/v1/scan: valid URL -> 200 with id, score (0-100 higher=better), verdict, breakdown', async () => {
  const res = await post(api.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.id === 'string' && json.id.length > 0);
  assert.equal(json.url, 'https://example.com/');
  assert.ok(Number.isInteger(json.score) && json.score >= 0 && json.score <= 100, `public score ${json.score}`);
  assert.ok(!('slopScore' in json), 'internal field name is not exposed');
  assert.equal(typeof json.verdict, 'string', 'grade label present');
  assert.ok(typeof json.createdAt === 'string');
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive']) {
    assert.ok(rule in json.breakdown, `breakdown.${rule}`);
    assert.ok(Number.isInteger(json.breakdown[rule].score));
    assert.ok(Array.isArray(json.breakdown[rule].findings));
  }
  // Row persisted: the DB keeps the INTERNAL slop score (higher = worse) and
  // the internal breakdown; the response is the flip (100 - internal).
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT id, url, score, breakdown FROM scans WHERE id = ?').get(json.id);
  assert.ok(row, 'row should exist in sqlite');
  assert.equal(row.url, 'https://example.com/');
  assert.equal(row.score, 100 - json.score, 'stored internal score == flipped public score');
  const stored = JSON.parse(row.breakdown);
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive']) {
    assert.equal(stored[rule].score + json.breakdown[rule].score, 100, `breakdown.${rule} flipped at rest`);
    assert.deepEqual(stored[rule].findings, json.breakdown[rule].findings, `breakdown.${rule} findings untouched`);
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

test('GET /api/v1/scans/:id returns the scan and renders HTML on request', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();

  const resJson = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'application/json' } });
  assert.equal(resJson.status, 200);
  const json = await resJson.json();
  assert.equal(json.id, created.id);
  assert.equal(json.score, created.score, 'GET matches POST public score');
  assert.equal(json.verdict, created.verdict, 'GET carries the same grade label');

  const resHtml = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } });
  assert.equal(resHtml.status, 200);
  assert.match(resHtml.headers.get('content-type'), /text\/html/);
  const html = await resHtml.text();
  assert.match(html, /<!doctype html/i);
  // Branding: the user-facing report names the product A.S.S. Score, renders
  // emoji-tagged category labels, and carries the mandated disclaimer verbatim.
  assert.match(html, /A\.S\.S\. Score: /);
  // The report headline shows the FLIPPED public score (higher = better) and
  // the verdict grade label.
  assert.ok(html.includes(`A.S.S. Score: ${created.score} / 100`), `headline shows public score ${created.score}`);
  assert.ok(html.includes(created.verdict), 'report shows the verdict grade label');
  assert.ok(html.includes('🤖 AI-like copy'), 'report shows branded emoji category labels');
  assert.ok(html.includes('🔁 Duplicate language across pages'), 'report shows crossPage under its branded label');
  assert.ok(
    html.includes(
      'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.'
    ),
    'report carries the mandated disclaimer'
  );
});

test('pre-flip stored rows read correctly with NO migration: internal 30 -> public 70 + verdict', async () => {
  // Simulate a scan row written BEFORE the score-direction flip: the DB always
  // stored the internal slop score (higher = worse) — e.g. 30 — with an
  // internal-direction breakdown and no roast column value (pre-roast shape).
  const row = new (await import('better-sqlite3')).default(dbPath);
  const oldId = 'pre-flip-0000-0000-000000000001';
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
    '2026-08-01T00:00:00.000Z'
  );
  row.close();

  const res = await fetch(`${api.base}/api/v1/scans/${oldId}`, { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.score, 70, 'stored internal 30 reads as public 70 (100 - 30)');
  assert.equal(json.verdict, 'VERY ASS', '70 falls in the 55-74 very ass band');
  assert.equal(json.breakdown.filler.score, 70, 'per-category flip applies to old rows too');
  assert.equal(json.breakdown.boilerplate.score, 50);
  assert.equal(json.breakdown.crossPage.score, null, 'skipped module passes through');
  assert.deepEqual(json.breakdown.filler.findings, ['legacy finding'], 'findings untouched');
  assert.ok(typeof json.roast === 'string' && json.roast.length > 0, 'roast derived for legacy rows');

  // HTML report on the old row: flipped headline + verdict label.
  const html = await (await fetch(`${api.base}/api/v1/scans/${oldId}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(html.includes('A.S.S. Score: 70 / 100'), 'old row headline shows the flipped score');
  assert.ok(html.includes('VERY ASS'), 'old row report shows the verdict label');
});

test('GET /api/v1/scans/:id missing -> 404', async () => {
  const res = await fetch(`${api.base}/api/v1/scans/does-not-exist`);
  assert.equal(res.status, 404);
});