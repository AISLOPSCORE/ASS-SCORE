import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-rate-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

// Fake fetcher: lets the scan pipeline run without touching the network.
const fakeFetcher = (html = SLOP_HTML) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

// DNS-skipping SSRF guard — same convention as webhookFulfillment.test.js.
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(opts = {}) {
  const app = createApp({ validateTarget: offlineValidateTarget, ...opts });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const postWebhook = (base, body) =>
  fetch(`${base}/api/v1/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const query = (dbPath, sql, ...params) => new Database(dbPath, { readonly: true }).prepare(sql).all(...params);
const count = (dbPath, table) => query(dbPath, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

// A valid Stripe order payload (accepted by the webhook route, triggers a scan
// through runScan directly — NOT through the scan route).
const stripeSession = (id) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id,
      customer_email: 'buyer@example.com',
      metadata: { target_url: 'https://acme.example', business_name: 'Acme Corp', client_email: 'client@example.com' },
    },
  },
});

// ---------------------------------------------------------------------------

test('rate limit: under cap accepted (200), over cap -> 429 with resetAt; only accepted scans ledgered', async () => {
  const dbp = tmpDb();
  const tick = '2026-09-08T10:00:00.000Z';
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), now: () => tick, maxScansPerDay: 2 });
  try {
    const r1 = await post(app.base, { url: 'https://example.com/' });
    assert.equal(r1.status, 200);
    assert.ok((await r1.json()).id, 'accepted scan returns the full payload');

    const r2 = await post(app.base, { url: 'https://example.com/' });
    assert.equal(r2.status, 200);

    const r3 = await post(app.base, { url: 'https://example.com/' });
    assert.equal(r3.status, 429);
    const json = await r3.json();
    assert.equal(json.error.code, 'rate_limited');
    assert.match(json.error.message, /2 scans per day/);
    assert.equal(json.error.resetAt, '2026-09-09T00:00:00.000Z', 'resetAt = next UTC midnight');

    // Accepted only: 2 scan rows, 2 ledger rows — the 429 created neither.
    assert.equal(count(dbp, 'scans'), 2, 'over-cap request created no scan row');
    assert.equal(count(dbp, 'scan_events'), 2, 'over-cap request created no ledger row');
    const ledgers = query(dbp, 'SELECT status, scan_id FROM scan_events ORDER BY created_at');
    assert.deepEqual(
      ledgers.map((l) => l.status),
      ['completed', 'completed'],
    );
    assert.ok(ledgers.every((l) => l.scan_id !== null), 'completed ledger rows carry their scan id');
  } finally {
    app.server.close();
  }
});

test('rate limit: validation failures (400) never consume quota', async () => {
  const dbp = tmpDb();
  const tick = '2026-09-08T10:00:00.000Z';
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), now: () => tick, maxScansPerDay: 2 });
  try {
    // Five different 400s — malformed URL, SSRF-blocked, bad webhookUrl,
    // bad branding, bad email — all BEFORE the cap is consulted.
    const bads = [
      [{ url: 'not a url' }, 'blocked'],
      [{ url: 'http://127.0.0.1/' }, 'blocked'],
      [{ url: 'https://example.com/', webhookUrl: 'ftp://nope' }, 'invalid_webhook_url'],
      [{ url: 'https://example.com/', branding: { logoUrl: 'not-a-url' } }, 'invalid_branding'],
      [{ url: 'https://example.com/', email: 'not-an-email' }, 'invalid_email'],
    ];
    for (const [body, code] of bads) {
      const res = await post(app.base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, code);
    }
    assert.equal(count(dbp, 'scans'), 0, 'no scan rows for any validation failure');
    assert.equal(count(dbp, 'scan_events'), 0, 'no ledger rows for any validation failure');

    // The full quota is still available: 2 accepted scans then a 429.
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 429);
    assert.equal(count(dbp, 'scans'), 2);
    assert.equal(count(dbp, 'scan_events'), 2);
  } finally {
    app.server.close();
  }
});

test('rate limit: maxScansPerDay 0 disables the cap entirely', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), maxScansPerDay: 0 });
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app.base, { url: 'https://example.com/' });
      assert.equal(res.status, 200, `scan ${i + 1} accepted with the cap disabled`);
    }
  } finally {
    app.server.close();
  }
});

test('rate limit: MAX_SCANS_PER_DAY=0 env disables the cap (default option path)', async () => {
  const prev = process.env.MAX_SCANS_PER_DAY;
  process.env.MAX_SCANS_PER_DAY = '0';
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher() }); // no explicit option -> env
  try {
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    }
  } finally {
    app.server.close();
    if (prev === undefined) delete process.env.MAX_SCANS_PER_DAY;
    else process.env.MAX_SCANS_PER_DAY = prev;
  }
});

test('rate limit: a new UTC day resets the per-IP bucket', async () => {
  const dbp = tmpDb();
  let tick = '2026-09-08T10:00:00.000Z';
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), now: () => tick, maxScansPerDay: 2 });
  try {
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 429);

    tick = '2026-09-09T08:00:00.000Z'; // next UTC day -> fresh bucket
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200, 'new day = new bucket');

    const days = query(dbp, 'SELECT DISTINCT day FROM scan_events ORDER BY day');
    assert.deepEqual(days.map((d) => d.day), ['2026-09-08', '2026-09-09'], 'ledger buckets by UTC day');
  } finally {
    app.server.close();
  }
});

test('rate limit: scan and webhook caps are independent (separate ledgers, no shared counts)', async () => {
  const dbp = tmpDb();
  const app = startApp({
    dbPath: dbp,
    fetcher: fakeFetcher(),
    maxScansPerDay: 2,
    maxWebhooksPerDay: 2,
  });
  try {
    // Two accepted scans (scan cap now 2/2).
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 429, 'scan cap exhausted');

    // Webhook cap is untouched: two accepted order webhooks (each triggers its
    // own scan via runScan directly, never touching the scan ledger).
    const w1 = await postWebhook(app.base, stripeSession('cs_rate_1'));
    assert.equal(w1.status, 202);
    const w2 = await postWebhook(app.base, stripeSession('cs_rate_2'));
    assert.equal(w2.status, 202);
    const w3 = await postWebhook(app.base, stripeSession('cs_rate_3'));
    assert.equal(w3.status, 429, 'webhook cap exhausted independently');

    assert.equal(count(dbp, 'scan_events'), 2, 'scan ledger counts only accepted /api/v1/scan requests');
    assert.equal(count(dbp, 'webhook_events'), 2, 'webhook ledger counts only accepted order webhooks');
  } finally {
    app.server.close();
  }
});

test('rate limit: buckets are per client IP (X-Forwarded-For honored via trust proxy)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), maxScansPerDay: 1 });
  try {
    const via = (ip) => post(app.base, { url: 'https://example.com/' }, { 'x-forwarded-for': ip });

    assert.equal((await via('9.9.9.9')).status, 200);
    assert.equal((await via('9.9.9.9')).status, 429, 'same IP over cap');
    assert.equal((await via('8.8.8.8')).status, 200, 'different IP has its own bucket');

    const ips = query(dbp, 'SELECT ip FROM scan_events ORDER BY ip');
    assert.deepEqual(ips.map((r) => r.ip), ['8.8.8.8', '9.9.9.9']);
  } finally {
    app.server.close();
  }
});

test('rate limit: failing webhook deliverer / email sender never double-count or leak quota', async () => {
  const dbp = tmpDb();
  const boom = async () => { throw new Error('stub boom'); };
  const app = startApp({
    dbPath: dbp,
    fetcher: fakeFetcher(),
    webhookDeliverer: boom,
    emailSender: boom,
    maxScansPerDay: 3,
  });
  try {
    const r = await post(app.base, { url: 'https://example.com/', webhookUrl: 'https://hooks.example.com/x', email: 'owner@example.com' });
    assert.equal(r.status, 200, 'best-effort delivery failures never break the scan response');
    await new Promise((res) => setTimeout(res, 150)); // let the async failures fire
    assert.equal(count(dbp, 'scan_events'), 1, 'exactly one ledger row despite two failing deliveries');
    assert.equal(query(dbp, 'SELECT status FROM scan_events')[0].status, 'completed');

    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 200);
    assert.equal((await post(app.base, { url: 'https://example.com/' })).status, 429);
    assert.equal(count(dbp, 'scan_events'), 3, 'three accepted scans, three ledger rows — no leakage');
  } finally {
    app.server.close();
  }
});