import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import {
  createEmailSender,
  createResendSender,
  RESEND_API_URL,
  RESEND_DEFAULT_FROM,
  DEFAULT_SUBJECT,
} from '../src/email.js';
import { createReportToken } from '../src/paywall.js';
import { verdictFor } from '../src/card.js';

const SCAN = { id: 'scan-r1', url: 'https://example.com/', score: 61, createdAt: '2026-09-14T00:00:00.000Z' };
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. All rights reserved.</p>
</body></html>`;

/** Fake fetch recording outbound Resend calls; statuses is a queue (last wins). */
function fakeFetch({ statuses = [200] } = {}) {
  const calls = [];
  const queued = [...statuses];
  const fn = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const status = queued.length > 1 ? queued.shift() : queued[0];
    return { status, ok: status >= 200 && status < 300 };
  };
  fn.calls = calls;
  return fn;
}

const quietLogger = () => {
  const logs = [];
  const logger = {
    log: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
  };
  return { logger, logs };
};

const resendEnv = (extra = {}) => ({ RESEND_API_KEY: 're_123', RESEND_FROM: 'A.S.S. Score <no-reply@verified.example>', ...extra });

const RESEND_OK = { ok: true, configured: true, attempts: 1 };

// ---------------------------------------------------------- factory selection

test('factory: RESEND_API_KEY set -> Resend transport; exact request shape (method/URL/Bearer/JSON)', async () => {
  const fetchFn = fakeFetch();
  const { logger } = quietLogger();
  const sender = createEmailSender({ env: resendEnv(), logger, fetchImpl: fetchFn });
  const result = await sender(SCAN, 'owner@example.com');

  assert.deepEqual(result, RESEND_OK);
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, RESEND_API_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer re_123');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'subject', 'to']);
  assert.equal(body.from, 'A.S.S. Score <no-reply@verified.example>');
  assert.equal(body.to, 'owner@example.com');
  assert.equal(body.subject, DEFAULT_SUBJECT, 'conservative default subject');
  assert.ok(body.html.includes('>61 <span'), 'score in html body');
  assert.ok(body.html.includes(verdictFor(61)), 'verdict in html body');
  assert.ok(body.html.includes(SCAN.url), 'scanned URL in html body');
});

test('factory: RESEND_API_KEY + SMTP_HOST both set -> Resend wins, SMTP transport untouched', async () => {
  const fetchFn = fakeFetch();
  let smtpCalls = 0;
  const sender = createEmailSender({
    env: { ...resendEnv(), SMTP_HOST: 'smtp.example.com' },
    transport: { sendMail: async () => { smtpCalls += 1; } },
    fetchImpl: fetchFn,
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.deepEqual(result, RESEND_OK);
  assert.equal(fetchFn.calls.length, 1, 'Resend used');
  assert.equal(smtpCalls, 0, 'SMTP transport never used');
});

test('Resend paid email: report link is the PUBLIC site origin /report/<id>?token=v1.<hex> — reportBaseUrl is ignored for emailed links', async () => {
  const fetchFn = fakeFetch();
  const sender = createEmailSender({
    env: resendEnv(),
    publicBaseUrl: 'https://www.ass-score.com',
    // The old internal host must NO LONGER appear in emailed links.
    reportBaseUrl: 'https://ass-score-production.up.railway.app',
    reportTokenSecret: 'test-secret',
    logger: quietLogger().logger,
    fetchImpl: fetchFn,
  });
  const token = createReportToken('test-secret', SCAN.id);
  const result = await sender(SCAN, 'buyer@example.com');
  assert.deepEqual(result, RESEND_OK);
  const html = JSON.parse(fetchFn.calls[0].init.body).html;
  const m = html.match(/<a href="([^"]+)" style="display:inline-block/);
  assert.ok(m, 'html CTA link present');
  const link = m[1];
  assert.equal(link, `https://www.ass-score.com/report/${SCAN.id}?token=${token}`, 'exact public-origin link');
  const u = new URL(link);
  assert.equal(u.pathname, `/report/${SCAN.id}`);
  assert.equal(u.searchParams.get('token'), token, 'token param equals the created token');
  assert.match(u.searchParams.get('token'), /^v1\.[a-f0-9]{64}$/, 'token is the versioned HMAC shape');
  assert.ok(!link.includes('railway'), 'no internal host in the emailed link');
  assert.ok(!link.includes('/api/v1/report'), 'no internal API path in the emailed link');
});

test('factory: no RESEND_API_KEY but SMTP_HOST -> SMTP transport (fake transporter), no Resend call', async () => {
  const fetchFn = fakeFetch();
  const sent = [];
  const sender = createEmailSender({
    env: { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_FROM: 'Old <o@example.com>' },
    transport: { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to] }; } },
    fetchImpl: fetchFn,
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.deepEqual(result, RESEND_OK);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'Old <o@example.com>', 'SMTP_FROM still honored on the SMTP path');
  assert.equal(fetchFn.calls.length, 0, 'no Resend call');
});

test('factory: no credentials at all -> no-op, logs "email not configured", {ok:false, configured:false}', async () => {
  const { logger, logs } = quietLogger();
  const sender = createEmailSender({ env: {}, logger });
  const result = await sender(SCAN, 'owner@example.com');
  assert.deepEqual(result, { ok: false, configured: false });
  assert.ok(logs.some((l) => l.includes('email not configured')), 'logged the no-op');
});

// -------------------------------------------------------- from-address rules

test('factory: Resend from — explicit from option beats env vars', async () => {
  const fetchFn = fakeFetch();
  const sender = createEmailSender({
    from: 'Explicit <x@explicit.example>',
    env: resendEnv({ RESEND_FROM: 'Env <e@env.example>' }),
    logger: quietLogger().logger,
    fetchImpl: fetchFn,
  });
  await sender(SCAN, 'owner@example.com');
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).from, 'Explicit <x@explicit.example>');
});

test('factory: Resend from — RESEND_FROM preferred over SMTP_FROM, no warning', async () => {
  const fetchFn = fakeFetch();
  const { logger, logs } = quietLogger();
  const sender = createEmailSender({
    env: { ...resendEnv(), SMTP_FROM: 'Old <o@example.com>' },
    logger,
    fetchImpl: fetchFn,
  });
  await sender(SCAN, 'owner@example.com');
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).from, 'A.S.S. Score <no-reply@verified.example>');
  assert.ok(!logs.some((l) => l.includes('no from-address configured')), 'no warning when a from is set');
});

test('factory: Resend from — SMTP_FROM is the fallback when RESEND_FROM is absent', async () => {
  const fetchFn = fakeFetch();
  const sender = createEmailSender({
    env: { RESEND_API_KEY: 're_123', SMTP_FROM: 'Old <o@example.com>' },
    logger: quietLogger().logger,
    fetchImpl: fetchFn,
  });
  await sender(SCAN, 'owner@example.com');
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).from, 'Old <o@example.com>');
});

test('factory: Resend from — nothing configured -> RESEND_DEFAULT_FROM + warning logged', async () => {
  const fetchFn = fakeFetch();
  const { logger, logs } = quietLogger();
  const sender = createEmailSender({ env: { RESEND_API_KEY: 're_123' }, logger, fetchImpl: fetchFn });
  await sender(SCAN, 'owner@example.com');
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).from, RESEND_DEFAULT_FROM);
  assert.ok(
    logs.some((l) => l.includes('no from-address configured') && l.includes(RESEND_DEFAULT_FROM)),
    'warning names the default'
  );
  assert.ok(logs.some((l) => l.includes('Verify a real sending domain with Resend')), 'warning tells the lead what to do');
});

test('factory: missing-from warning falls back to .log when logger has no .warn', async () => {
  const logs = [];
  const sender = createEmailSender({
    env: { RESEND_API_KEY: 're_123' },
    logger: { log: (m) => logs.push(String(m)), error() {} },
    fetchImpl: fakeFetch(),
  });
  await sender(SCAN, 'owner@example.com');
  assert.ok(logs.some((l) => l.includes('no from-address configured')), 'warning surfaced via .log');
});

// ------------------------------------------------------- delivery semantics

test('Resend: 4xx is a client error -> no retry, {ok:false, attempts:1}, exactly one request', async () => {
  const fetchFn = fakeFetch({ statuses: [422] });
  const { logger, logs } = quietLogger();
  const sender = createEmailSender({
    env: resendEnv(),
    logger,
    fetchImpl: fetchFn,
    backoffMs: [1], // a retry would be instant — the test would still see it call count
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.configured, true);
  assert.equal(result.attempts, 1, 'gave up on the 4xx, no retry');
  assert.equal(fetchFn.calls.length, 1, 'exactly one request');
  assert.match(result.error.message, /4xx is not retried/);
  assert.ok(logs.some((l) => l.includes('rejected by Resend') && l.includes('422')), 'rejection logged');
});

test('Resend: 5xx is transient — retried, success on attempt 2 -> {ok:true, attempts:2}', async () => {
  const fetchFn = fakeFetch({ statuses: [500, 200] });
  const sender = createEmailSender({
    env: resendEnv(),
    logger: quietLogger().logger,
    fetchImpl: fetchFn,
    backoffMs: [1],
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.deepEqual(result, { ok: true, configured: true, attempts: 2 });
  assert.equal(fetchFn.calls.length, 2);
});

test('Resend: persistent 5xx -> {ok:false, attempts:maxAttempts}, never rejects', async () => {
  const fetchFn = fakeFetch({ statuses: [503] });
  const { logger, logs } = quietLogger();
  const sender = createEmailSender({
    env: resendEnv(),
    logger,
    fetchImpl: fetchFn,
    maxAttempts: 3,
    backoffMs: [1, 1],
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.configured, true);
  assert.equal(result.attempts, 3);
  assert.equal(fetchFn.calls.length, 3);

  assert.match(result.error.message, /HTTP 503/);
  assert.ok(logs.some((l) => l.includes('failed: Resend returned HTTP 503')), 'each failure logged');
});

test('Resend: network failure (fetch rejects) retried then {ok:false}, never rejects', async () => {
  let calls = 0;
  const errors = [];
  const fetchFn = async () => { calls += 1; throw new Error('fetch failed: ECONNRESET'); };
  const sender = createEmailSender({
    env: resendEnv(),
    logger: { log() {}, error: (m) => errors.push(String(m)) },
    fetchImpl: fetchFn,
    maxAttempts: 2,
    backoffMs: [1],
  });
  const result = await sender(SCAN, 'owner@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.configured, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.match(result.error.message, /ECONNRESET/);
  assert.equal(errors.length, 2, 'both failures logged');
});

test('Resend: missing scan payload aborts before any request', async () => {
  const fetchFn = fakeFetch();
  const sender = createEmailSender({ env: resendEnv(), logger: quietLogger().logger, fetchImpl: fetchFn });
  const result = await sender(null, 'owner@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.configured, true);
  assert.equal(result.attempts, 0);
  assert.equal(result.error.message, 'missing scan payload');
  assert.equal(fetchFn.calls.length, 0);
});

test('createResendSender: direct use works, missing apiKey throws', async () => {
  const fetchFn = fakeFetch();
  const sender = createResendSender({ apiKey: 're_direct', fetchImpl: fetchFn });
  assert.deepEqual(await sender(SCAN, 'owner@example.com'), RESEND_OK);
  assert.match(fetchFn.calls[0].init.headers.Authorization, /Bearer re_direct/);
  assert.throws(() => createResendSender({ apiKey: '   ' }), /requires a non-empty apiKey/);
});

// ----------------------------------------------------------- API integration
// prove createApp's DEFAULT sender (no injectable) is Resend when
// RESEND_API_KEY is in the environment and global fetch is available.

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-resend-')), 'test.db');
const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
const offlineValidateTarget = async (raw) => validateUrl(raw);
const withTimeout = (promise, ms = 2000, label = 'timed out') =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);

const REAL_FETCH = globalThis.fetch;
const ORIG_RESEND_KEY = process.env.RESEND_API_KEY;
const ORIG_RESEND_FROM = process.env.RESEND_FROM;

let apiBase;
let apiServer;
let apiCalls;
let resendCalled;

before(() => {
  // The deployed process will have RESEND_API_KEY in env — simulate that so
  // createApp's default emailSender (which reads process.env) picks Resend.
  process.env.RESEND_API_KEY = 're_integration';
  process.env.RESEND_FROM = 'A.S.S. Score <no-reply@verified.example>';
  apiCalls = [];
  let resolveCalled;
  resendCalled = new Promise((r) => { resolveCalled = r; });
  globalThis.fetch = async (url, init) => {
    if (String(url) !== RESEND_API_URL) return REAL_FETCH(url, init); // let real HTTP through
    apiCalls.push({ url, init });
    resolveCalled();
    return { status: 200, ok: true };
  };
  const app = createApp({ dbPath: tmpDb(), fetcher: fakeFetcher(SLOP_HTML), validateTarget: offlineValidateTarget });
  apiServer = app.listen(0);
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

after(() => {
  if (apiServer) apiServer.close();
  globalThis.fetch = REAL_FETCH;
  if (ORIG_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIG_RESEND_KEY;
  if (ORIG_RESEND_FROM === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = ORIG_RESEND_FROM;
});

test('POST /api/v1/scan with email: 200, scan succeeds, report POSTed to Resend (default wiring)', async () => {
  const res = await fetch(`${apiBase}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/', email: 'owner@example.com' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.id && typeof json.score === 'number');

  await withTimeout(resendCalled, 2000, 'Resend sender was not invoked');
  assert.equal(apiCalls.length, 1);
  const { url, init } = apiCalls[0];
  assert.equal(url, RESEND_API_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer re_integration');
  const body = JSON.parse(init.body);
  assert.equal(body.to, 'owner@example.com');
  assert.equal(body.from, 'A.S.S. Score <no-reply@verified.example>');
  assert.ok(body.html.includes(json.score), 'report carries the real scanned score');
});