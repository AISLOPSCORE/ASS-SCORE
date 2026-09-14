import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createCors, DEFAULT_ALLOWED_ORIGINS, parseOrigins } from '../src/cors.js';
import { validateUrl } from '../src/fetch/ssrf.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-cors-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(options = {}) {
  const app = createApp({
    dbPath: tmpDb(),
    fetcher: fakeFetcher(SLOP_HTML),
    validateTarget: offlineValidateTarget,
    ...options,
  });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

let api;
let customApi;

before(() => {
  api = startApp(); // default allowlist
  customApi = startApp({ allowedOrigins: ['https://only.example'] }); // override
});

after(() => {
  api.server.close();
  customApi.server.close();
});

test('cors: all default site origins get Access-Control-Allow-Origin echoed', async () => {
  for (const origin of DEFAULT_ALLOWED_ORIGINS) {
    const res = await fetch(`${api.base}/health`, { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin, `echo ${origin}`);
    assert.match(res.headers.get('vary') ?? '', /Origin/i, 'Vary: Origin set for cache correctness');
  }
});

test('cors: disallowed origin gets NO CORS headers (browser blocks, API still public)', async () => {
  for (const origin of ['https://evil.example', 'https://ass-score.com.evil.example', 'http://ass-score.com', 'null']) {
    const res = await fetch(`${api.base}/health`, { headers: { origin } });
    assert.equal(res.status, 200, 'server still answers non-browser clients');
    assert.equal(res.headers.get('access-control-allow-origin'), null, `no ACAO for ${origin}`);
  }
});

test('cors: no Origin header -> no CORS headers (curl/servers unaffected)', async () => {
  const res = await fetch(`${api.base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('cors: preflight OPTIONS from an allowed origin -> 204 with allow headers', async () => {
  const origin = DEFAULT_ALLOWED_ORIGINS[0];
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/, 'POST allowed');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/, 'GET allowed');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /Content-Type/i, 'Content-Type allowed');
  assert.ok(res.headers.get('access-control-max-age'), 'preflight cacheable');
  assert.equal(res.headers.get('access-control-allow-credentials'), null, 'no credentials mode');
});

test('cors: preflight OPTIONS from a disallowed origin -> no CORS headers, no crash', async () => {
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
});

test('cors: real scan POST from an allowed origin carries the CORS header (browser flow)', async () => {
  const origin = DEFAULT_ALLOWED_ORIGINS[1]; // https://ass-score.com
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  const json = await res.json();
  assert.ok(json.id, 'scan ran');
});

test('cors: allowedOrigins option overrides the defaults', async () => {
  const res = await fetch(`${customApi.base}/health`, { headers: { origin: 'https://only.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://only.example');
  const denied = await fetch(`${customApi.base}/health`, { headers: { origin: DEFAULT_ALLOWED_ORIGINS[0] } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null, 'default origin no longer allowed');
});

test('cors: parseOrigins honors CORS_ORIGINS and falls back to defaults', () => {
  assert.deepEqual(parseOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseOrigins(''), DEFAULT_ALLOWED_ORIGINS);
  assert.deepEqual(parseOrigins(undefined), DEFAULT_ALLOWED_ORIGINS);
  assert.deepEqual(parseOrigins('   ,   '), DEFAULT_ALLOWED_ORIGINS);
});