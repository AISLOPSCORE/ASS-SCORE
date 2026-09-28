import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import Database from 'better-sqlite3';
import { Fetcher } from '../src/fetch/client.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createApp } from '../src/app.js';
import { runScan } from '../src/scan.js';

// ---------------------------------------------------------------------------
// Free-scan audit defects D1 + D2 (owner-approved fix):
//  D1 — an HTTP error status (4xx/5xx) response must fail the scan with the
//       existing 502 fetch_failed shape instead of being scored as content.
//  D2 — a non-HTML Content-Type (PDF/PNG/...) must fail the scan with the
//       existing 422 parse_failed shape instead of being scored as "clean";
//       an ABSENT Content-Type keeps today's parse attempt (zero-word gate).
//  Both failure paths must persist NO scan row (consistent with every other
//  fetch/parse failure).
// Route-level tests run a REAL Fetcher with a mocked fetchImpl + mocked DNS
// (same convention as retryWww.test.js), so the client.js contentType
// propagation is exercised end-to-end. Unit tests pin the exact error shape
// at the runScan boundary.
// ---------------------------------------------------------------------------
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gates-')), 'test.db');
const mockDns = (t) =>
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
// DNS-skipping route guard (same convention as retryWww.test.js): the mocked
// fetchImpl owns all network behavior; the guard must only reject shapes.
const offlineValidateTarget = async (raw) => validateUrl(raw);
const HTML_BODY = '<!doctype html><html><head><title>Acme</title></head><body><p>Ordinary company page with real content.</p></body></html>';

function startApp(dbPath, fetchImpl, t) {
  mockDns(t);
  const app = createApp({
    dbPath,
    fetcher: new Fetcher({ fetchImpl }),
    validateTarget: offlineValidateTarget,
    reportTokenSecret: 'gates-test-secret',
    scanBudgetMs: 5000,
    maxScansPerDay: 100, // keep the per-IP cap out of these tests' way
  });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, url) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
const countScans = (dbPath) =>
  new Database(dbPath, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM scans').get().n;

// ---------------------------------------------------------------------------
// runScan unit: exact failure shapes + never persist
// ---------------------------------------------------------------------------
test('D1 unit: HTTP error status -> exact 502 fetch_failed shape, no insertScan', async () => {
  let inserts = 0;
  const result = await runScan({
    db: { insertScan: () => { inserts += 1; } },
    fetcher: { fetchHtml: async (raw) => ({ status: 418, url: new URL(raw).href, body: HTML_BODY, contentType: 'text/html' }) },
    url: 'https://example.com/',
    scanBudgetMs: 5000,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 502,
    json: { error: { code: 'fetch_failed', message: 'Target returned HTTP 418' } },
  });
  assert.equal(inserts, 0, 'no scan row for an error-status response');
});

test('D2 unit: non-HTML Content-Type -> exact 422 parse_failed shape, no insertScan', async () => {
  let inserts = 0;
  const result = await runScan({
    db: { insertScan: () => { inserts += 1; } },
    fetcher: { fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '%PDF-1.4 trailer<<>>', contentType: 'application/pdf' }) },
    url: 'https://example.com/report.pdf',
    scanBudgetMs: 5000,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 422,
    json: { error: { code: 'parse_failed', message: 'Target is not an HTML page (Content-Type: application/pdf)' } },
  });
  assert.equal(inserts, 0, 'no scan row for a non-HTML payload');
});

test('D2 unit: absent Content-Type keeps today\'s parse behavior (scan succeeds)', async () => {
  // A fake fetcher omitting the key entirely (the long-standing mock contract
  // in every existing test) AND one that reports the header as explicitly
  // null (what the real Fetcher returns) must both parse normally.
  for (const page of [
    { status: 200, url: 'https://example.com/', body: HTML_BODY }, // no contentType key
    { status: 200, url: 'https://example.com/', body: HTML_BODY, contentType: null },
  ]) {
    const result = await runScan({
      db: { insertScan: () => {} },
      fetcher: { fetchHtml: async () => page },
      url: 'https://example.com/',
      scanBudgetMs: 5000,
    });
    assert.equal(result.ok, true, 'absent Content-Type must not be rejected');
  }
});

// ---------------------------------------------------------------------------
// Fetcher unit: contentType propagation
// ---------------------------------------------------------------------------
test('Fetcher: contentType is null when the server sends none, raw value when present', async (t) => {
  mockDns(t);
  // NOTE: undici auto-injects "text/plain;charset=UTF-8" for string bodies, so
  // the header-less case needs a null body (this test only asserts the header
  // propagation, never parses the body).
  const fetcher = new Fetcher({ fetchImpl: async () => new Response(null) });
  const res = await fetcher.fetchHtml('https://example.com/');
  assert.equal(res.contentType, null, 'no Content-Type header -> null');

  const fetcher2 = new Fetcher({
    fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const res2 = await fetcher2.fetchHtml('https://example.com/');
  assert.equal(res2.contentType, 'text/html; charset=utf-8', 'final response header propagated verbatim');
});

// ---------------------------------------------------------------------------
// Route-level: D1 — error status responses
// ---------------------------------------------------------------------------
for (const status of [404, 500]) {
  test(`route: HTTP ${status} response -> 502 fetch_failed, no scan row`, async (t) => {
    const dbPath = tmpDb();
    const { server, base } = startApp(dbPath, async () => new Response(`<!doctype html><html>${status} page</html>`, { status }), t);
    try {
      const res = await post(base, 'https://example.com/');
      assert.equal(res.status, 502);
      const json = await res.json();
      assert.equal(json.error.code, 'fetch_failed');
      assert.match(json.error.message, new RegExp(`HTTP ${status}`));
      assert.equal(countScans(dbPath), 0, 'no scan row persisted');
    } finally {
      server.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Route-level: D2 — non-HTML Content-Types
// ---------------------------------------------------------------------------
for (const ct of ['image/png', 'application/pdf']) {
  test(`route: Content-Type ${ct} -> 422 parse_failed, no scan row`, async (t) => {
    const dbPath = tmpDb();
    const { server, base } = startApp(
      dbPath,
      async () => new Response('\u0089PNG\r\n\u001a\nbinary', { status: 200, headers: { 'content-type': ct } }),
      t,
    );
    try {
      const res = await post(base, 'https://example.com/asset');
      assert.equal(res.status, 422);
      const json = await res.json();
      assert.equal(json.error.code, 'parse_failed');
      assert.match(json.error.message, new RegExp(`Content-Type: ${ct}`));
      assert.equal(countScans(dbPath), 0, 'no scan row persisted');
    } finally {
      server.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Route-level: allowed HTML-family types still scan (charset params and
// case must not trip the gate). NOTE: an absent-Content-Type route case is
// unrepresentable here — undici always injects text/plain for string bodies;
// that path is pinned by the runScan unit test above (no key / explicit
// null) plus the Fetcher propagation test.
// ---------------------------------------------------------------------------
const allowed = [
  ['text/html', 'plain text/html passes'],
  ['text/html; charset=utf-8', 'charset param passes'],
  ['TEXT/HTML ; CHARSET=UTF-8', 'case-insensitive + spaced params pass'],
  ['application/xhtml+xml', 'xhtml passes'],
  ['text/xml', 'xml passes'],
];
for (const [ct, label] of allowed) {
  test(`route: Content-Type ${ct} -> 200 (${label})`, async (t) => {
    const dbPath = tmpDb();
    const { server, base } = startApp(dbPath, async () => new Response(HTML_BODY, { status: 200, headers: { 'content-type': ct } }), t);
    try {
      const res = await post(base, 'https://example.com/');
      assert.equal(res.status, 200, `${ct} must scan normally`);
      const json = await res.json();
      assert.equal(typeof json.score, 'number');
      assert.equal(countScans(dbPath), 1, 'exactly one scan row persisted');
    } finally {
      server.close();
    }
  });
}