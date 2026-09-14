import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import {
  validateEmail,
  buildReportEmail,
  createEmailSender,
  DEFAULT_SUBJECT,
  ASS_SCORE_SUBJECT,
} from '../src/email.js';
import { verdictFor } from '../src/card.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-mail-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
// Blows up if called — proves invalid email fails BEFORE any scanning I/O.
const neverFetcher = {
  fetchHtml: async () => { throw new Error('fetcher must not be called for invalid email'); },
};

/** Stub email sender that records (scan, to) invocations (optionally throwing). */
function stubSender({ behavior = 'record' } = {}) {
  const calls = [];
  let resolveCalled;
  const called = new Promise((r) => { resolveCalled = r; });
  const send = async (scan, to) => {
    calls.push({ scan, to });
    resolveCalled();
    if (behavior === 'reject') throw new Error('stub email boom');
    return { ok: true, attempts: 1 };
  };
  send.calls = calls;
  send.called = called;
  return send;
}

// Route-level SSRF guard, DNS-skipping variant (see webhookFulfillment.test.js).
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath, fetcher, emailSender) {
  const app = createApp({ dbPath, fetcher, emailSender, validateTarget: offlineValidateTarget });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, body) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const withTimeout = (promise, ms = 2000, label = 'timed out') =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);

// --------------------------------------------------------------------- units

test('validateEmail: missing/empty allowed (means no delivery)', () => {
  for (const v of [undefined, null, '', '   ']) {
    assert.deepEqual(validateEmail(v), { ok: true, email: null }, `value ${JSON.stringify(v)}`);
  }
});

test('validateEmail: valid addresses accepted (normalized/trimmed)', () => {
  for (const v of ['owner@example.com', '  a.b-c+tag@sub.example.io ', 'x@y.co']) {
    const r = validateEmail(v);
    assert.equal(r.ok, true, v);
    assert.equal(r.email, v.trim());
  }
});

test('validateEmail: malformed addresses rejected', () => {
  const bad = ['not-an-email', 'a@b', '@example.com', 'a@', 'a@@b.com', 'a b@c.com',
    'a@b c.com', 42, {}, ['owner@example.com'], `a@${'x'.repeat(300)}.com`];
  for (const v of bad) {
    const r = validateEmail(v);
    assert.equal(r.ok, false, `expected rejection: ${JSON.stringify(v)}`);
    assert.ok(typeof r.message === 'string' && r.message.length > 0);
  }
});

// ------------------------------------------------------------------- content

test('buildReportEmail: subject defaults to the conservative primary; both bodies carry score + verdict + disclaimer', () => {
  const scan = { id: 'scan-1', url: 'https://example.com/', slopScore: 42, createdAt: '2026-09-08T00:00:00.000Z' };
  const mail = buildReportEmail({ scan, to: 'owner@example.com', publicBaseUrl: 'https://ass-score.com/' });
  assert.equal(mail.to, 'owner@example.com');
  assert.equal(mail.subject, DEFAULT_SUBJECT, 'conservative default out of the box');
  assert.equal(mail.from, 'A.S.S. Score <no-reply@ass-score.com>', 'sender name is the product');

  const text = mail.text;
  assert.ok(text.includes('A.S.S. Score'), 'brand header in plain text');
  assert.ok(text.includes(scan.url), 'URL in plain text');
  assert.ok(text.includes('42 / 100'), 'score in plain text');
  assert.ok(text.includes(verdictFor(42)), 'verdict line in plain text');
  assert.ok(text.includes('https://ass-score.com/scan/scan-1'), 'public report link in plain text');
  assert.ok(text.includes(DEFAULT_DISCLAIMER()), 'mandated disclaimer in plain text');

  const html = mail.html;
  assert.ok(html.includes('A.S.S. Score'), 'brand header in html');
  assert.ok(html.includes('>42 <span'), 'score in html');
  assert.ok(html.includes('https://ass-score.com/scan/scan-1'), 'report link in html');
  assert.ok(html.includes(DEFAULT_DISCLAIMER()), 'mandated disclaimer in html');
  assert.ok(html.includes(scan.url), 'URL in html');
});

test('buildReportEmail: subject override respected, values HTML-escaped', () => {
  const scan = { id: 'scan-2', url: 'https://example.com/<script>x</script>', slopScore: 30 };
  const mail = buildReportEmail({
    scan,
    to: 'owner@example.com',
    publicBaseUrl: 'https://results.example.com',
    subject: ASS_SCORE_SUBJECT,
    from: 'Agency <agency@example.com>',
  });
  assert.equal(mail.subject, ASS_SCORE_SUBJECT, 'branded variant selectable via config');
  assert.equal(mail.from, 'Agency <agency@example.com>');
  assert.ok(!mail.html.includes('<script>x</script>'), 'no raw injection from URL');
  assert.ok(mail.html.includes('&lt;script&gt;x&lt;/script&gt;'), 'URL escaped in html');
  assert.ok(mail.text.includes('https://example.com/<script>x</script>'), 'plain text keeps raw URL');
});

function DEFAULT_DISCLAIMER() {
  return 'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';
}

// ------------------------------------------------------------ sender (units)

test('createEmailSender: without SMTP_HOST -> no-op, logs "email not configured", never rejects', async () => {
  const logs = [];
  const sender = createEmailSender({ env: {}, logger: { log: (m) => logs.push(m), error: () => {} } });
  const result = await sender({ id: 'scan-1', score: 5 }, 'owner@example.com');
  assert.deepEqual(result, { ok: false, configured: false });
  assert.ok(logs.some((l) => l.includes('email not configured')), 'logged the no-op');
});

test('createEmailSender: with SMTP_HOST + fake transport -> sends the buildReportEmail output, subject config respected', async () => {
  const sent = [];
  const fakeTransport = { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to] }; } };
  const sender = createEmailSender({
    env: { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'A.S.S. Score <no-reply@ass-score.com>' },
    subject: ASS_SCORE_SUBJECT,
    publicBaseUrl: 'https://ass-score.com',
    transport: fakeTransport,
  });
  const scan = { id: 'scan-3', url: 'https://example.com/', slopScore: 63 };
  const result = await sender(scan, 'owner@example.com');
  assert.deepEqual(result, { ok: true, configured: true, attempts: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].subject, ASS_SCORE_SUBJECT, 'subject option flows to the transport');
  assert.ok(sent[0].text.includes('63 / 100'));
  assert.ok(sent[0].html.includes(verdictFor(63)));
  assert.ok(sent[0].html.includes(DEFAULT_DISCLAIMER()));
});

test('createEmailSender: failing transport retries up to maxAttempts, never rejects, logs failures', async () => {
  let calls = 0;
  const fakeTransport = {
    sendMail: async () => { calls += 1; if (calls < 3) throw new Error('SMTP 550 relay denied'); return {}; },
  };
  const errors = [];
  const sender = createEmailSender({
    env: { SMTP_HOST: 'smtp.example.com' },
    transport: fakeTransport,
    backoffMs: [1, 1],
    logger: { log: () => {}, error: (m) => errors.push(m) },
  });
  const scan = { id: 'scan-4', url: 'https://example.com/', slopScore: 10 };
  const result = await sender(scan, 'owner@example.com');
  assert.deepEqual(result, { ok: true, configured: true, attempts: 3 });
  assert.equal(calls, 3, 'retried until success');
  assert.ok(errors.length === 2, 'both failures logged');
});

test('createEmailSender: persistent failure -> gives up with {ok:false}, no throw', async () => {
  let calls = 0;
  const failing = {
    sendMail: async () => { calls += 1; throw new Error('ECONNREFUSED'); },
  };
  const sender = createEmailSender({
    env: { SMTP_HOST: 'smtp.example.com' },
    transport: failing,
    maxAttempts: 2,
    backoffMs: [1],
    logger: { log: () => {}, error: () => {} },
  });
  const result = await sender({ id: 'scan-5', url: 'https://example.com/', slopScore: 70 }, 'owner@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.match(result.error.message, /ECONNREFUSED/);
});

// ----------------------------------------------------------- API integration

let api;         // fake fetcher + stub sender (success + no-email cases)
let stub;        // api's email sender
let strictApi;   // neverFetcher + stub sender (fail-fast validation)
let strictStub;
let noSmtpApi;   // fake fetcher + DEFAULT sender (no SMTP env -> no-op best-effort)

before(() => {
  stub = stubSender();
  api = startApp(tmpDb(), fakeFetcher(SLOP_HTML), stub);
  strictStub = stubSender();
  strictApi = startApp(tmpDb(), neverFetcher, strictStub);
  noSmtpApi = startApp(tmpDb(), fakeFetcher(SLOP_HTML), createEmailSender({ env: {} }));
});

after(() => {
  api.server.close();
  strictApi.server.close();
  noSmtpApi.server.close();
});

test('POST /api/v1/scan: invalid email -> 400 invalid_email WITHOUT scanning', async () => {
  const cases = [
    { email: 'not-an-email' },
    { email: 'a@b' },
    { email: 'owner@' },
    { email: 42 },
    { email: ['owner@example.com'] },
    { email: 'x y@z.com' },
  ];
  for (const c of cases) {
    const res = await post(strictApi.base, { url: 'https://example.com/', ...c });
    assert.equal(res.status, 400, JSON.stringify(c));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_email', JSON.stringify(c));
    assert.ok(json.error.message.length > 0);
  }
  // neverFetcher would 500 if the scan pipeline ran; a 400 proves fail-fast.
  assert.equal(strictStub.calls.length, 0, 'no delivery for failed validation');
});

test('POST /api/v1/scan: valid email -> 200 and the sender is invoked with the exact payload + address', async () => {
  const baseline = stub.calls.length;
  const res = await post(api.base, { url: 'https://example.com/', email: 'owner@example.com' });
  assert.equal(res.status, 200);
  const json = await res.json();

  await withTimeout(stub.called, 2000, 'sender was not invoked');
  assert.equal(stub.calls.length - baseline, 1);
  const { scan, to } = stub.calls[stub.calls.length - 1];
  assert.equal(to, 'owner@example.com');
  assert.deepEqual(scan, json, 'sender receives the exact response object');
  for (const key of ['id', 'url', 'slopScore', 'breakdown', 'createdAt']) assert.ok(key in scan);
});

test('POST /api/v1/scan: a failing sender does not break the 200 response (best-effort)', async () => {
  const bad = stubSender({ behavior: 'reject' });
  const app = startApp(tmpDb(), fakeFetcher(SLOP_HTML), bad);
  const res = await post(app.base, { url: 'https://example.com/', email: 'owner@example.com' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.id && json.slopScore >= 0.0 && json.slopScore <= 100);
  await withTimeout(bad.called, 2000, 'sender was not invoked');
  assert.equal(bad.calls.length, 1);
  app.server.close();
});

test('POST /api/v1/scan: no email field -> 200 and sender never invoked', async () => {
  const baseline = stub.calls.length;
  const res = await post(api.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.id);
  await new Promise((r) => setTimeout(r, 150)); // let any (incorrect) send fire
  assert.equal(stub.calls.length, baseline, 'no email -> no send');
});

test('no SMTP credentials: POST with email -> 200 with the no-op logged ("email not configured") — scan succeeds regardless', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let app;
  try {
    app = startApp(tmpDb(), fakeFetcher(SLOP_HTML), createEmailSender({ env: {} }));
    const res = await post(app.base, { url: 'https://example.com/', email: 'owner@example.com' });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.id);
    await new Promise((r) => setTimeout(r, 150)); // async no-op fires after the response
  } finally {
    console.log = orig;
    app.server.close();
  }
  assert.ok(logs.some((l) => l.includes('email not configured')), 'logged the no-op');
});