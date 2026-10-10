import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken, DISCLAIMER } from '../src/paywall.js';

/**
 * Spec-parity surfaces (README "API" contract): the /api/health alias, the
 * /report/:scanId free-HTML alias, and the optional businessName + clientEmail
 * fields on POST /api/v1/scan. The paywall leak-gate is asserted on every free
 * surface: only score/verdict/roast/category NUMBERS/1–2 teasers + disclaimer
 * may leave — never the full findings/insights (paid content).
 */

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-parity-')), 'test.db');

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
// api.test.js / webhookFulfillment.test.js).
const offlineValidateTarget = async (raw) => validateUrl(raw);

const TOKEN_SECRET = 'parity-test-secret';

// Record every emailSender invocation (scan payload, recipient, opts).
const sender = { calls: [] };
const emailSender = async (scan, to, opts) => {
  sender.calls.push({ scan, to, opts });
  return { ok: true };
};

function startApp(dbPath) {
  const app = createApp({
    dbPath,
    fetcher: fakeFetcher(SLOP_HTML),
    validateTarget: offlineValidateTarget,
    reportTokenSecret: TOKEN_SECRET,
    emailSender,
    maxScansPerDay: 0, // test app: cap disabled so this suite never 429s
  });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const query = (dbPath, sql, ...params) =>
  new Database(dbPath, { readonly: true }).prepare(sql).all(...params);

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath);
});

after(() => {
  api.server.close();
});

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Poll until the email sender has been invoked at least `min` times. */
async function waitForEmail(min, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (sender.calls.length >= min) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${min} email call(s)`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Paid-only markers that must NEVER appear on a free surface. These strings
// are rendered ONLY by the token'd full-report renderer (renderHtmlReport) —
// as Title Case <h2> headings ('<div class="cat-sources" hidden>', …) and the
// 'Show the receipts:' evidence label.
const PAID_MARKERS = [
  '<div class="cat-sources" hidden>',
  'Your Breakdown',
  "What's Working",
  'What To Fix First',
  'Final Verdict',
  'Show the receipts:',
];

// ------------------------------------------------------------------ health

test('GET /api/health: spec alias returns the same 200 JSON as /health', async () => {
  const alias = await fetch(`${api.base}/api/health`);
  assert.equal(alias.status, 200);
  const json = await alias.json();
  assert.deepEqual(json, { ok: true, service: 'ass-score' });

  const root = await fetch(`${api.base}/health`);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), JSON.stringify(json), 'alias body is byte-identical to /health');
});

test('GET /api/health: unknown path under /api is not masked by the alias', async () => {
  const res = await fetch(`${api.base}/api/does-not-exist`);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, 'not_found');
});

// --------------------------------------------------- businessName + clientEmail

test('POST /api/v1/scan: optional businessName is stored on the scan row', async () => {
  const res = await post(api.base, { url: 'https://example.com/', businessName: 'Acme Corp' });
  assert.equal(res.status, 200);
  const json = await res.json();
  // Storage-only field: the free response JSON shape is untouched.
  assert.ok(!('businessName' in json), 'businessName is not echoed in the free payload');
  const rows = query(dbPath, 'SELECT business_name FROM scans WHERE id = ?', json.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].business_name, 'Acme Corp');
});

test('POST /api/v1/scan: businessName is trimmed before storage', async () => {
  const res = await post(api.base, { url: 'https://example.com/', businessName: '  Acme Corp  ' });
  assert.equal(res.status, 200);
  const json = await res.json();
  const rows = query(dbPath, 'SELECT business_name FROM scans WHERE id = ?', json.id);
  assert.equal(rows[0].business_name, 'Acme Corp');
});

test('POST /api/v1/scan: missing / empty businessName stores null (no scan row change)', async () => {
  const empty = await post(api.base, { url: 'https://example.com/', businessName: '   ' });
  assert.equal(empty.status, 200);
  const emptyId = (await empty.json()).id;
  assert.equal(query(dbPath, 'SELECT business_name FROM scans WHERE id = ?', emptyId)[0].business_name, null);

  const absent = await post(api.base, { url: 'https://example.com/' });
  assert.equal(absent.status, 200);
  const absentId = (await absent.json()).id;
  assert.equal(query(dbPath, 'SELECT business_name FROM scans WHERE id = ?', absentId)[0].business_name, null);
});

test('POST /api/v1/scan: non-string businessName is a 400 BEFORE scanning', async () => {
  const before = query(dbPath, 'SELECT COUNT(*) AS n FROM scans')[0].n;
  const res = await post(api.base, { url: 'https://example.com/', businessName: 42 });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'invalid_business_name');
  const after = query(dbPath, 'SELECT COUNT(*) AS n FROM scans')[0].n;
  assert.equal(after, before, 'no scan row is created for an invalid businessName');
});

test('POST /api/v1/scan: clientEmail alias delivers the report link to that address', async () => {
  const baseline = sender.calls.length;
  const res = await post(api.base, { url: 'https://example.com/', clientEmail: 'client@example.com' });
  assert.equal(res.status, 200);
  await waitForEmail(baseline + 1);

  const sent = sender.calls[sender.calls.length - 1];
  assert.equal(sent.to, 'client@example.com', 'clientEmail is the report-link recipient');
  assert.deepEqual(sent.opts, { free: true }, 'free-tier email path, unchanged');
  assert.ok(sent.scan && typeof sent.scan.id === 'string');
  // The sender sees the EXACT gated free payload — no full findings.
  for (const rule of Object.values(sent.scan.breakdown ?? {})) {
    assert.ok(!('findings' in rule), 'no findings leak into the email payload');
    assert.ok(!('insights' in rule), 'no insights leak into the email payload');
  }
});

test('POST /api/v1/scan: email wins over clientEmail when both are supplied', async () => {
  const baseline = sender.calls.length;
  const res = await post(api.base, { url: 'https://example.com/', email: 'primary@example.com', clientEmail: 'alias@example.com' });
  assert.equal(res.status, 200);
  await waitForEmail(baseline + 1);
  const sent = sender.calls[sender.calls.length - 1];
  assert.equal(sent.to, 'primary@example.com', 'documented email field takes precedence');
});

test('POST /api/v1/scan: invalid clientEmail is a 400 invalid_email (same as email)', async () => {
  const baseline = sender.calls.length;
  const res = await post(api.base, { url: 'https://example.com/', clientEmail: 'not-an-address' });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'invalid_email');
  assert.equal(sender.calls.length, baseline, 'no email is attempted for an invalid address');
});

// ------------------------------------------------------- /report/:scanId alias

async function createScan(overrides = {}) {
  const res = await post(api.base, { url: 'https://example.com/', ...overrides });
  assert.equal(res.status, 200);
  return res.json();
}

test('GET /report/:scanId: same free HTML page as /api/v1/scans/:id (Accept: text/html)', async () => {
  const created = await createScan();

  const alias = await fetch(`${api.base}/report/${created.id}`);
  assert.equal(alias.status, 200);
  assert.match(alias.headers.get('content-type'), /text\/html/, 'alias serves HTML');
  const aliasHtml = await alias.text();

  const canonical = await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } });
  assert.equal(canonical.status, 200);
  assert.equal(await canonical.text(), aliasHtml, 'the alias page is byte-identical to the canonical free page');
});

test('GET /report/:scanId: free-page content contract (score/verdict/roast/numbers/teasers/$12/disclaimer)', async () => {
  const created = await createScan();
  const html = await (await fetch(`${api.base}/report/${created.id}`)).text();

  assert.match(html, /A\.S\.S\. Score — free result/);
  assert.ok(html.includes(`${created.score} / 100`), 'public score rendered');
  assert.ok(html.includes(created.verdict), 'verdict band rendered');
  assert.ok(html.includes(created.roast), 'roast line rendered');
  assert.ok(html.includes('Free sample 1'), 'teaser findings rendered');
  assert.ok(html.includes('https://buy.stripe.com/cNi00j7zs1P49ju5B9abK00'), '$12 checkout CTA rendered');
  assert.ok(html.includes('Download your share card'), 'share-card link rendered');
  assert.ok(html.includes(DISCLAIMER), 'mandated disclaimer rendered verbatim');
});

test('GET /report/:scanId: paywall gate holds — never leaks paid content', async () => {
  const created = await createScan();

  // Free, and with a VALID report token (which must be ignored on this alias):
  // both must be the byte-identical free page, never the full report.
  const token = createReportToken(TOKEN_SECRET, created.id);
  const free = await (await fetch(`${api.base}/report/${created.id}`)).text();
  const withToken = await (await fetch(`${api.base}/report/${created.id}?token=${encodeURIComponent(token)}`)).text();
  assert.equal(withToken, free, 'a valid token does not unlock the paid report through the alias');
  for (const marker of PAID_MARKERS) {
    assert.ok(!free.includes(marker), `paid marker "${marker}" never appears on the free alias page`);
  }
});

test('GET /report/:scanId: unknown id -> 404 JSON error shape (same as /api/v1/scans/:id)', async () => {
  const res = await fetch(`${api.base}/report/nope-not-a-scan`);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, 'not_found');
  assert.ok(json.error.message.includes('nope-not-a-scan'));
});

test('GET /api/v1/report/:id (token route) still serves the FULL report with a token — paywall intact', async () => {
  const created = await createScan();
  const token = createReportToken(TOKEN_SECRET, created.id);

  const paid = await (await fetch(`${api.base}/api/v1/report/${created.id}?token=${encodeURIComponent(token)}`)).text();
  assert.ok(paid.includes('<div class="cat-sources" hidden>'), 'paid report renders its findings section');

  const denied = await fetch(`${api.base}/api/v1/report/${created.id}`);
  assert.equal(denied.status, 403, 'token-less access to the paid route stays forbidden');
});