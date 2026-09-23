import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import Database from 'better-sqlite3';
import { Fetcher, FetchError } from '../src/fetch/client.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Fetcher `www.` retry (fixes scan 502s for hosts whose apex rejects our TLS).
// Injected fetchImpl owns all network behavior; DNS is mocked so the SSRF
// resolveAndCheck path stays instant and offline (same shared node:dns module
// that src/fetch/ssrf.js imports).
// ---------------------------------------------------------------------------
const mockDns = (t) =>
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);

const OK_HTML = '<!doctype html><html><head><title>Acme</title></head><body><p>Ordinary company page with real content.</p></body></html>';
const okResponse = (body = OK_HTML, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const netFail = () => { throw new TypeError('fetch failed'); };

// (a) network-level failure on a bare host -> retried with www, succeeds, scan URL reflects www
test('network-level failure on a bare host -> retried once with www. and succeeds; result URL reflects www', async (t) => {
  mockDns(t);
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => {
      calls.push(href);
      if (href === 'https://example.com/') netFail();
      if (href === 'https://www.example.com/') return okResponse();
      netFail();
    },
  });
  const res = await fetcher.fetchHtml('https://example.com');
  assert.deepEqual(calls, ['https://example.com/', 'https://www.example.com/'], 'exactly one www retry');
  assert.equal(res.status, 200);
  assert.equal(res.url, 'https://www.example.com/', 'returned URL is the www URL that succeeded');
  assert.ok(res.body.includes('Ordinary company page'), 'body of the www response returned');
});

// (b) network-level failure on both attempts -> original error returned
test('network-level failure on both attempts -> original error returned (no www leak)', async (t) => {
  mockDns(t);
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => { calls.push(href); netFail(); },
  });
  let caught;
  try { await fetcher.fetchHtml('https://example.com/'); } catch (err) { caught = err; }
  assert.ok(caught instanceof FetchError, 'rejects with FetchError');
  assert.equal(caught.message, 'Network error fetching https://example.com/: fetch failed', 'original apex error preserved');
  assert.deepEqual(calls, ['https://example.com/', 'https://www.example.com/'], 'one retry attempted, then original error');
});

// (c) host already www -> no retry
test('host already www -> never retried on network failure', async (t) => {
  mockDns(t);
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => { calls.push(href); netFail(); },
  });
  let caught;
  try { await fetcher.fetchHtml('https://www.example.com/'); } catch (err) { caught = err; }
  assert.ok(caught instanceof FetchError, 'rejects with FetchError');
  assert.equal(caught.message, 'Network error fetching https://www.example.com/: fetch failed');
  assert.deepEqual(calls, ['https://www.example.com/'], 'single attempt, no retry');
});

// (d) HTTP error response (e.g. 404) -> NOT retried, original response path unchanged
test('HTTP error response (404) -> NOT retried; response path unchanged', async (t) => {
  mockDns(t);
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => { calls.push(href); return new Response('not found', { status: 404 }); },
  });
  const res = await fetcher.fetchHtml('https://example.com/');
  assert.equal(res.status, 404);
  assert.equal(res.url, 'https://example.com/');
  assert.deepEqual(calls, ['https://example.com/'], 'no www retry for HTTP error statuses');
});

// (e) normal successful fetch -> no behavior change
test('normal successful fetch -> no www retry, single call, unchanged result', async (t) => {
  mockDns(t);
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => { calls.push(href); return okResponse(); },
  });
  const res = await fetcher.fetchHtml('https://example.com/');
  assert.equal(res.status, 200);
  assert.equal(res.url, 'https://example.com/');
  assert.deepEqual(calls, ['https://example.com/'], 'no extra hop on success');
});

// ---------------------------------------------------------------------------
// Integration: the RECORDED scan URL is the www URL that actually succeeded
// (runScan stores page.url — the fetcher's returned URL — in DB and payload).
// ---------------------------------------------------------------------------
test('POST /api/v1/scan records the www URL that succeeded after apex network failure', async (t) => {
  mockDns(t);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retrywww-')), 'test.db');
  const calls = [];
  const fetcher = new Fetcher({
    fetchImpl: async (href) => {
      calls.push(href);
      if (href === 'https://example.com/') netFail();
      if (href === 'https://www.example.com/') return okResponse();
      netFail(); // sitemap/discovery fetches fail and are skipped by design
    },
  });
  const app = createApp({
    dbPath,
    fetcher,
    validateTarget: async (raw) => validateUrl(raw), // same offline-guard convention as api.test.js
    reportTokenSecret: 'retrywww-test-secret',
    scanBudgetMs: 5000,
  });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(res.status, 200, 'apex TLS rejection no longer 502s');
    const json = await res.json();
    assert.equal(json.url, 'https://www.example.com/', 'public payload url is the www URL');
    const row = new Database(dbPath).prepare('SELECT url FROM scans WHERE id = ?').get(json.id);
    assert.ok(row, 'scan row persisted');
    assert.equal(row.url, 'https://www.example.com/', 'stored url is the www URL');
    assert.ok(calls.includes('https://example.com/') && calls.includes('https://www.example.com/'), 'retry happened end-to-end');
  } finally {
    server.close();
  }
});