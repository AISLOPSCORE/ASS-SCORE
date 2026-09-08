import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

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

function startApp(dbPath, fetcher) {
  const app = createApp({ dbPath, fetcher });
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

test('POST /api/v1/scan: valid URL -> 200 with id, slopScore, breakdown', async () => {
  const res = await post(api.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.id === 'string' && json.id.length > 0);
  assert.equal(json.url, 'https://example.com/');
  assert.ok(Number.isInteger(json.slopScore) && json.slopScore >= 0 && json.slopScore <= 100);
  assert.ok(typeof json.createdAt === 'string');
  for (const rule of ['filler', 'boilerplate', 'infoDensity', 'repetitive']) {
    assert.ok(rule in json.breakdown, `breakdown.${rule}`);
    assert.ok(Number.isInteger(json.breakdown[rule].score));
    assert.ok(Array.isArray(json.breakdown[rule].findings));
  }
  // Row persisted
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT id, url, score, breakdown FROM scans WHERE id = ?').get(json.id);
  assert.ok(row, 'row should exist in sqlite');
  assert.equal(row.url, 'https://example.com/');
  assert.equal(row.score, json.slopScore);
  assert.deepEqual(JSON.parse(row.breakdown), json.breakdown);
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
  assert.equal(json.slopScore, created.slopScore);

  const resHtml = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } });
  assert.equal(resHtml.status, 200);
  assert.match(resHtml.headers.get('content-type'), /text\/html/);
  const html = await resHtml.text();
  assert.match(html, /<!doctype html/i);
  // Branding: the user-facing report names the product A.S.S. Score, renders
  // emoji-tagged category labels, and carries the mandated disclaimer verbatim.
  assert.match(html, /A\.S\.S\. Score: /);
  assert.ok(html.includes('🤖 AI-like copy'), 'report shows branded emoji category labels');
  assert.ok(html.includes('🔁 Duplicate language across pages'), 'report shows crossPage under its branded label');
  assert.ok(
    html.includes(
      'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.'
    ),
    'report carries the mandated disclaimer'
  );
});

test('GET /api/v1/scans/:id missing -> 404', async () => {
  const res = await fetch(`${api.base}/api/v1/scans/does-not-exist`);
  assert.equal(res.status, 404);
});