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
//  PLUS the owner-approved D1/D2 QUOTA ROLLBACK (2026-09-28+): a gate
//  rejection consumes ZERO of the per-IP daily quota — the ledger row is
//  removed — while every other failure (transport, timeout, HTML parse
//  failure) still keeps its slot (row marked 'failed').
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
// A JS-only app shell: the server sends an empty <div id="root"> plus JS, and
// NOTHING else — extractText yields zero words, so the zero-text gate fires.
const NO_TEXT_BODY = '<!doctype html><html><head><title>Acme</title></head><body><div id="root"></div></body></html>';

function startApp(dbPath, fetchImpl, t, { maxScansPerDay = 100 } = {}) {
  mockDns(t);
  const app = createApp({
    dbPath,
    fetcher: new Fetcher({ fetchImpl }),
    validateTarget: offlineValidateTarget,
    reportTokenSecret: 'gates-test-secret',
    scanBudgetMs: 5000,
    maxScansPerDay, // quota tests pass 3 (the real production cap); the rest keep 100
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
// scan_events = the per-IP daily-quota ledger; gate-rejection rollback must
// leave it holding ONLY the completed scans.
const countScanEvents = (dbPath) =>
  new Database(dbPath, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM scan_events').get().n;
const scanEventRows = (dbPath) =>
  new Database(dbPath, { readonly: true }).prepare('SELECT status, scan_id FROM scan_events ORDER BY created_at').all();

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

test('zero-text HTML body -> 422 parse_failed with the owner finding copy, no insertScan', async () => {
  // Owner-approved copy (2026-10-07): a JS-only page is a FINDING, not a scan
  // failure — the exact message is pinned so the copy can never regress to
  // 'The page contained no extractable text'. code/status stay unchanged.
  let inserts = 0;
  const result = await runScan({
    db: { insertScan: () => { inserts += 1; } },
    fetcher: { fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: NO_TEXT_BODY, contentType: 'text/html' }) },
    url: 'https://example.com/',
    scanBudgetMs: 5000,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 422,
    json: {
      error: {
        code: 'parse_failed',
        message: 'This site renders all content with JavaScript, so nothing readable is served to search engines or scanners without a browser. Not a scan failure — that IS the finding.',
      },
    },
  });
  assert.equal(inserts, 0, 'no scan row for a zero-text page');
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
for (const status of [403, 404, 500]) {
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
      assert.equal(countScanEvents(dbPath), 0, 'D1 rejection rolled back: no quota ledger row (slot restored)');
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
      assert.equal(countScanEvents(dbPath), 0, 'D2 rejection rolled back: no quota ledger row (slot restored)');
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

// ---------------------------------------------------------------------------
// Redirect trio: the Fetcher follows redirects itself (re-validating every
// hop against SSRF rules); the D1/D2 gates apply to the FINAL response.
// Stateful fetchImpl: 302 (with Location) on the first call, then the final
// response — exactly how a redirecting origin behaves.
// ---------------------------------------------------------------------------
const htmlResponse = (status = 200, body = HTML_BODY) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirectResponse = (location) => new Response(null, { status: 302, headers: { location } });

test('redirect: plain HTTP -> HTTPS redirect ends in valid HTML -> scans normally (200 + score, one scans row)', async (t) => {
  const dbPath = tmpDb();
  const hops = [];
  const { server, base } = startApp(
    dbPath,
    async (href) => {
      hops.push(href);
      if (href === 'http://example.com/') return redirectResponse('https://example.com/');
      return htmlResponse(); // final https URL + any discovery probes
    },
    t,
  );
  try {
    const res = await post(base, 'http://example.com/');
    assert.equal(res.status, 200, 'redirect to valid HTML must scan normally');
    const json = await res.json();
    assert.equal(typeof json.score, 'number');
    assert.equal(json.url, 'https://example.com/', 'public payload url is the FINAL (post-redirect) URL');
    assert.deepEqual(hops.slice(0, 2), ['http://example.com/', 'https://example.com/'], 'redirect followed hop by hop');
    assert.equal(countScans(dbPath), 1, 'exactly one scans row');
  } finally {
    server.close();
  }
});

test('redirect: /old -> /new both HTML -> scans normally', async (t) => {
  const dbPath = tmpDb();
  const hops = [];
  const { server, base } = startApp(
    dbPath,
    async (href) => {
      hops.push(href);
      if (href === 'https://example.com/old') return redirectResponse('https://example.com/new');
      return htmlResponse();
    },
    t,
  );
  try {
    const res = await post(base, 'https://example.com/old');
    assert.equal(res.status, 200, 'same-site HTML redirect must scan normally');
    const json = await res.json();
    assert.equal(typeof json.score, 'number');
    assert.equal(json.url, 'https://example.com/new', 'recorded URL is the redirect target');
    assert.ok(hops.includes('https://example.com/old') && hops.includes('https://example.com/new'), 'both hops taken');
    assert.equal(countScans(dbPath), 1, 'one scans row');
  } finally {
    server.close();
  }
});

test('redirect: chain ending in an error page (302 -> final 404) -> 502 fetch_failed, no scan row (D1 after redirect resolution)', async (t) => {
  const dbPath = tmpDb();
  const hops = [];
  const { server, base } = startApp(
    dbPath,
    async (href) => {
      hops.push(href);
      if (href === 'https://example.com/old') return redirectResponse('https://example.com/new');
      return htmlResponse(404); // the FINAL response is an error page
    },
    t,
  );
  try {
    const res = await post(base, 'https://example.com/old');
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error.code, 'fetch_failed');
    assert.equal(json.error.message, 'Target returned HTTP 404', 'D1 applies to the post-redirect final status');
    assert.ok(hops.includes('https://example.com/old') && hops.includes('https://example.com/new'), 'redirect WAS followed');
    assert.equal(countScans(dbPath), 0, 'no scans row for a redirect landing on an error page');
    assert.equal(countScanEvents(dbPath), 0, 'gate rejection after redirect consumed zero quota');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Quota tests — maxScansPerDay: 3 (the real production cap). Gate rejections
// must consume ZERO quota; every other failure keeps its slot (unchanged).
// ---------------------------------------------------------------------------
test('quota: D1 rejection consumes zero quota — 404 then valid scan from the same IP -> 200', async (t) => {
  const dbPath = tmpDb();
  let n = 0;
  const { server, base } = startApp(
    dbPath,
    async () => {
      n += 1;
      if (n === 1) return new Response('not found', { status: 404 });
      return htmlResponse(); // the valid scan + discovery probes
    },
    t,
    { maxScansPerDay: 3 },
  );
  try {
    const r1 = await post(base, 'https://example.com/');
    assert.equal(r1.status, 502);
    const r2 = await post(base, 'https://example.com/');
    assert.equal(r2.status, 200, 'a valid scan immediately after a gate rejection must succeed');
    const json = await r2.json();
    assert.equal(typeof json.score, 'number');
    assert.equal(countScans(dbPath), 1, 'exactly the valid scan persisted');
    assert.equal(countScanEvents(dbPath), 1, 'ledger holds only the completed scan');
  } finally {
    server.close();
  }
});

test('quota: owner restore test — same site 4x (404, PDF, 403, valid HTML): the 4th scan returns 200 and persists', async (t) => {
  const dbPath = tmpDb();
  let n = 0;
  const { server, base } = startApp(
    dbPath,
    async () => {
      n += 1;
      if (n === 1) return new Response('not found', { status: 404 });
      if (n === 2) return new Response('%PDF-1.4 trailer<<>>', { status: 200, headers: { 'content-type': 'application/pdf' } });
      if (n === 3) return new Response('forbidden', { status: 403 });
      return htmlResponse();
    },
    t,
    { maxScansPerDay: 3 },
  );
  try {
    const r1 = await post(base, 'https://example.com/');
    assert.equal(r1.status, 502);
    assert.equal((await r1.json()).error.message, 'Target returned HTTP 404');

    const r2 = await post(base, 'https://example.com/');
    assert.equal(r2.status, 422);
    assert.equal((await r2.json()).error.message, 'Target is not an HTML page (Content-Type: application/pdf)');

    const r3 = await post(base, 'https://example.com/');
    assert.equal(r3.status, 502);
    assert.equal((await r3.json()).error.message, 'Target returned HTTP 403');

    const r4 = await post(base, 'https://example.com/');
    assert.equal(r4.status, 200, '4th scan SUCCEEDS — the 3 rejections consumed zero quota (slot restored, not just uncounted)');
    assert.equal(typeof (await r4.json()).score, 'number');
    assert.equal(countScans(dbPath), 1, 'persisted scans = the 1 completed scan only');
    assert.equal(countScanEvents(dbPath), 1, 'quota ledger = the 1 completed scan only');
  } finally {
    server.close();
  }
});

test('quota: genuine network failure does NOT restore the slot — after 3 failures the 4th valid scan -> 429', async (t) => {
  const dbPath = tmpDb();
  const netFail = () => { throw new TypeError('fetch failed'); }; // retryWww.test.js convention
  const { server, base } = startApp(dbPath, async () => netFail(), t, { maxScansPerDay: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await post(base, 'https://example.com/');
      assert.equal(res.status, 502, `network-failure scan ${i + 1} -> 502`);
      const json = await res.json();
      assert.equal(json.error.code, 'fetch_failed');
      assert.match(json.error.message, /^Network error fetching/, 'transport error, NOT the D1 gate shape');
    }
    assert.equal(countScans(dbPath), 0, 'no scans rows for transport failures');
    assert.equal(countScanEvents(dbPath), 3, 'transport failures KEEP their slots (3 ledger rows, unchanged behavior)');

    const r4 = await post(base, 'https://example.com/');
    assert.equal(r4.status, 429, 'non-gate failures still count: 4th scan is rate-limited');
    assert.equal((await r4.json()).error.code, 'rate_limited');
    assert.equal(countScanEvents(dbPath), 3, 'the 429 created no ledger row');
  } finally {
    server.close();
  }
});

test('quota: scan_events holds exactly the completed scans (day+IP count) after rejections+rollback', async (t) => {
  const dbPath = tmpDb();
  let n = 0;
  const { server, base } = startApp(
    dbPath,
    async () => {
      n += 1;
      if (n === 1) return new Response('not found', { status: 404 });
      if (n === 2) return new Response('\u0089PNG\r\n\u001a\nbinary', { status: 200, headers: { 'content-type': 'image/png' } });
      if (n === 3) return new Response('forbidden', { status: 403 });
      return htmlResponse();
    },
    t,
    { maxScansPerDay: 3 },
  );
  try {
    assert.equal((await post(base, 'https://example.com/')).status, 502); // D1 (404)
    assert.equal((await post(base, 'https://example.com/asset')).status, 422); // D2 (image/png)
    assert.equal((await post(base, 'https://example.com/')).status, 502); // D1 (403)
    assert.equal((await post(base, 'https://example.com/')).status, 200); // valid HTML

    // Direct ledger assertion (same opening convention as countScans): the
    // per-day-per-IP event count equals ONLY the completed scans.
    const rows = scanEventRows(dbPath);
    assert.equal(rows.length, 1, 'one ledger row after 3 rollbacks + 1 completion');
    assert.deepEqual(rows.map((r) => r.status), ['completed']);
    assert.ok(rows[0].scan_id, 'the surviving row carries the completed scan id');
    assert.equal(countScanEvents(dbPath), countScans(dbPath), 'event count == completed scan count');
  } finally {
    server.close();
  }
});