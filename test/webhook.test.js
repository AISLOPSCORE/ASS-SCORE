import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { validateWebhookUrl, createWebhookDeliverer } from '../src/webhook.js';
import { validateUrl } from '../src/fetch/ssrf.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-webhook-')), 'test.db');

const SLOP_HTML = `<p>In today's fast-paced world, it's no secret that cutting-edge solutions will
revolutionize the landscape. Furthermore, learn more. All rights reserved.</p>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
// Blows up if called — proves invalid webhookUrl fails BEFORE any scanning I/O.
const neverFetcher = {
  fetchHtml: async () => { throw new Error('fetcher must not be called for invalid webhookUrl'); },
};

// Route-level SSRF guard, DNS-skipping variant (see webhookFulfillment.test.js).
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath, fetcher, webhookDeliverer) {
  const app = createApp({ dbPath, fetcher, webhookDeliverer, validateTarget: offlineValidateTarget });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, body) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Stub deliverer that records invocations (optionally throwing). */
function stubDeliverer({ behavior = 'record' } = {}) {
  const calls = [];
  let resolveCalled;
  const called = new Promise((r) => { resolveCalled = r; });
  const deliver = async (payload, webhookUrl) => {
    calls.push({ payload, webhookUrl });
    resolveCalled();
    if (behavior === 'reject') throw new Error('stub delivery boom');
    return { ok: true, attempts: 1 };
  };
  deliver.calls = calls;
  deliver.called = called;
  return deliver;
}

function withTimeout(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

let api;        // fake fetcher + REAL default deliverer (end-to-end integration)
let stubApi;    // fake fetcher + stub deliverer (unit)
let stub;       // stubApi's deliverer
let strictApi;  // neverFetcher + stub deliverer (fail-fast validation)
let strictStub; // strictApi's deliverer

before(() => {
  api = startApp(tmpDb(), fakeFetcher(SLOP_HTML));
  stub = stubDeliverer();
  stubApi = startApp(tmpDb(), fakeFetcher(SLOP_HTML), stub);
  strictStub = stubDeliverer();
  strictApi = startApp(tmpDb(), neverFetcher, strictStub);
});

after(() => {
  api.server.close();
  stubApi.server.close();
  strictApi.server.close();
});

// ---------------------------------------------------------------------------
// validateWebhookUrl unit tests
// ---------------------------------------------------------------------------

test('validateWebhookUrl: missing/empty is allowed (means no delivery)', () => {
  for (const v of [undefined, null, '', '   ']) {
    assert.deepEqual(validateWebhookUrl(v), { ok: true, url: null }, `value ${JSON.stringify(v)}`);
  }
});

test('validateWebhookUrl: invalid values rejected', () => {
  const bad = [
    'ftp://example.com/hook',   // wrong scheme
    'file:///tmp/x',            // wrong scheme
    'httpx://example.com/hook', // not http(s)
    'http://',                  // no host
    'http:///hook',             // no host
    'https://',                 // no host
    'http://exa mple.com',      // illegal host characters
    'not a url',
    42,
    {},
    ['https://example.com'],
  ];
  for (const v of bad) {
    const r = validateWebhookUrl(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be rejected`);
    assert.ok(typeof r.message === 'string' && r.message.length > 0);
  }
});

test('validateWebhookUrl: http/https with a host accepted (callback URLs skip SSRF range checks)', () => {
  for (const v of ['http://127.0.0.1:9999/hook', 'https://example.com/hook', 'https://hooks.example.com']) {
    const r = validateWebhookUrl(v);
    assert.equal(r.ok, true, v);
    assert.equal(r.url, new URL(v).href, v);
  }
});

// ---------------------------------------------------------------------------
// API: validation fail-fast
// ---------------------------------------------------------------------------

test('POST /api/v1/scan: invalid webhookUrl -> 400 invalid_webhook_url WITHOUT scanning', async () => {
  const cases = [
    { webhookUrl: 'ftp://example.com/hook' },
    { webhookUrl: 'http://' },
    { webhookUrl: 'not a url' },
    { webhookUrl: 42 },
    { webhookUrl: { nope: 1 } },
  ];
  for (const c of cases) {
    const res = await post(strictApi.base, { url: 'https://example.com/', ...c });
    assert.equal(res.status, 400, JSON.stringify(c));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_webhook_url', JSON.stringify(c));
    assert.ok(json.error.message.length > 0);
  }
  // neverFetcher would 500 if the scan pipeline ran; a 400 + zero deliveries
  // proves the request failed before any scanning and no delivery was attempted.
  assert.equal(strictStub.calls.length, 0, 'no delivery for failed validation');
});

// ---------------------------------------------------------------------------
// API: delivery invocation (stubbed deliverer)
// ---------------------------------------------------------------------------

test('POST /api/v1/scan: valid webhookUrl -> 200 and deliverer invoked with the exact payload', async () => {
  const baseline = stub.calls.length;
  const res = await post(stubApi.base, { url: 'https://example.com/', webhookUrl: 'https://hooks.example.com/x' });
  assert.equal(res.status, 200);
  const json = await res.json();

  await withTimeout(stub.called, 2000, 'deliverer was not invoked');
  assert.equal(stub.calls.length - baseline, 1);
  const { payload, webhookUrl } = stub.calls[stub.calls.length - 1];
  assert.equal(webhookUrl, 'https://hooks.example.com/x');
  for (const key of ['id', 'url', 'slopScore', 'breakdown', 'createdAt']) {
    assert.ok(key in payload, `payload has ${key}`);
  }
  // The delivered payload is the exact response object returned to the caller.
  assert.deepEqual(payload, json);
  assert.equal(JSON.stringify(payload), JSON.stringify(json));
});

test('POST /api/v1/scan: a failing deliverer does not break the 200 response', async () => {
  const badStub = stubDeliverer({ behavior: 'reject' });
  const app = startApp(tmpDb(), fakeFetcher(SLOP_HTML), badStub);
  const res = await post(app.base, { url: 'https://example.com/', webhookUrl: 'https://hooks.example.com/x' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.id && json.slopScore >= 0);
  await withTimeout(badStub.called, 2000, 'deliverer was not invoked');
  assert.equal(badStub.calls.length, 1);
  app.server.close();
});

test('POST /api/v1/scan: no webhookUrl -> 200 and deliverer never invoked', async () => {
  const baseline = stub.calls.length;
  const res = await post(stubApi.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.id);
  // Give any (incorrect) scheduled delivery a chance to fire before asserting.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stub.calls.length, baseline, 'no webhookUrl -> no delivery');
});

// ---------------------------------------------------------------------------
// Integration: real local HTTP listener receives the delivery (real deliverer)
// ---------------------------------------------------------------------------

test('integration: a real 127.0.0.1 webhook endpoint receives the exact scan JSON', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        scanId: req.headers['x-ass-score-scan-id'],
        body: data,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const { port } = hook.address();

  const res = await post(api.base, { url: 'https://example.com/', webhookUrl: `http://127.0.0.1:${port}/hook?token=abc` });
  assert.equal(res.status, 200);
  const json = await res.json();

  // Delivery fires asynchronously after the response — poll briefly.
  const deadline = Date.now() + 3000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  hook.close();

  assert.equal(received.length, 1, 'the webhook endpoint should be POSTed exactly once');
  const msg = received[0];
  assert.equal(msg.method, 'POST');
  assert.equal(msg.url, '/hook?token=abc');
  assert.match(String(msg.contentType), /application\/json/);
  assert.equal(msg.scanId, json.id, 'X-Ass-Score-Scan-Id header');
  assert.deepEqual(JSON.parse(msg.body), json, 'webhook body equals the scan response JSON');
});

// ---------------------------------------------------------------------------
// Deliverer retry policy (unit, real deliverer + scripted fetch)
// ---------------------------------------------------------------------------

const scan = (id = 'scan-1') => ({
  id,
  url: 'https://example.com/',
  slopScore: 42,
  breakdown: { filler: { score: 0, findings: [] } },
  createdAt: '2026-09-08T00:00:00.000Z',
});

test('deliverer: POSTs the exact JSON body with the right headers', async () => {
  let captured;
  const fakeFetch = async (url, init) => { captured = { url, init }; return { status: 202 }; };
  const deliver = createWebhookDeliverer({ fetchImpl: fakeFetch, backoffMs: [1, 1] });

  const result = await deliver(scan('scan-1'), 'https://hooks.example.com/x');
  assert.deepEqual(result, { ok: true, attempts: 1 });
  assert.equal(captured.url, 'https://hooks.example.com/x');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  assert.equal(captured.init.headers['x-ass-score-scan-id'], 'scan-1');
  assert.equal(captured.init.body, JSON.stringify(scan('scan-1')));
});

test('deliverer: 500 then 200 -> retried and succeeds', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return calls === 1 ? { status: 500 } : { status: 200 };
  };
  const deliver = createWebhookDeliverer({ fetchImpl: fakeFetch, backoffMs: [1, 1] });

  const result = await deliver(scan(), 'https://hooks.example.com/x');
  assert.deepEqual(result, { ok: true, attempts: 2 });
  assert.equal(calls, 2, 'should have been retried once');
});

test('deliverer: 404 -> no retry (4xx is the client\'s fault)', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { status: 404 }; };
  const deliver = createWebhookDeliverer({ fetchImpl: fakeFetch, backoffMs: [1, 1] });

  const result = await deliver(scan(), 'https://hooks.example.com/x');
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 404);
  assert.equal(calls, 1, '4xx must not be retried');
});

test('deliverer: repeated network errors -> tries up to maxAttempts then gives up', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const deliver = createWebhookDeliverer({ fetchImpl: fakeFetch, backoffMs: [1, 1], maxAttempts: 3 });

  const result = await deliver(scan(), 'https://hooks.example.com/x');
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.match(result.error.message, /ECONNREFUSED/);
});

test('deliverer: per-attempt timeout aborts the request and retries', async () => {
  let calls = 0;
  const hangingFetch = async (_url, init) => {
    calls += 1;
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const deliver = createWebhookDeliverer({
    fetchImpl: hangingFetch,
    timeoutMs: 30,
    backoffMs: [1, 1],
    maxAttempts: 2,
  });

  const started = Date.now();
  const result = await deliver(scan(), 'https://hooks.example.com/x');
  assert.equal(result.ok, false);
  assert.equal(calls, 2, 'timeout should trigger a retry');
  assert.equal(result.error.message, 'aborted');
  assert.ok(Date.now() - started < 5000, 'timeout was applied per attempt, not a global cap');
});