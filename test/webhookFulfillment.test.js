import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { normalizeOrder, findUrl, pick } from '../src/orderNormalizer.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { buildReportEmail } from '../src/email.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asswebhook-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

// Fake fetcher: lets the scan pipeline run without touching the network.
const fakeFetcher = (html = SLOP_HTML) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

// The same validateUrl the Fetcher runs — literal private IPs / banned
// hostnames are rejected synchronously; hostname DNS (resolveAndCheck) is
// skipped so tests never touch the network, exactly like the rest of the suite.
const offlineValidateTarget = async (raw) => validateUrl(raw);

/** Stub email sender that records (scan, to) invocations (optionally rejecting). */
function stubSender({ behavior = 'record' } = {}) {
  const calls = [];
  const send = async (scan, to) => {
    calls.push({ scan, to });
    if (behavior === 'reject') throw new Error('stub email boom');
    return { ok: true, attempts: 1 };
  };
  send.calls = calls;
  return send;
}

function startApp(opts = {}) {
  const app = createApp({ validateTarget: offlineValidateTarget, ...opts });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, body) =>
  fetch(`${base}/api/v1/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const query = (dbPath, sql, ...params) => new Database(dbPath, { readonly: true }).prepare(sql).all(...params);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the sqlite file until the scan row exists (scan runs async post-202). */
async function waitForScan(dbPath, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const rows = query(dbPath, 'SELECT id, url, score, created_at, roast FROM scans ORDER BY created_at');
    if (rows.length > 0) return rows;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for scan row');
    await sleep(20);
  }
}

/** Poll until the webhook event row reaches a terminal status. */
async function waitForEvent(dbPath, eventKey, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const rows = query(dbPath, 'SELECT * FROM webhook_events WHERE event_key = ?', eventKey);
    if (rows.length > 0 && rows[0].status !== 'pending') return rows[0];
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for event ${eventKey}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------- fixtures

const FIVERR = {
  type: 'ORDER_CREATED',
  data: {
    order: {
      id: 'fvr-10001234',
      gig: { id: 42, title: 'Website audit' },
      buyer: { username: 'buyer1', email: 'buyer@example.com' },
      business_name: 'Acme Corp',
      requirements: 'Scan my site https://acme.example — thank you!',
    },
  },
};

const stripeSession = (overrides = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: overrides.id ?? 'cs_test_abc123',
      customer_email: overrides.customer_email ?? 'buyer@example.com',
      metadata: {
        target_url: overrides.target_url ?? 'https://acme.example',
        business_name: 'Acme Corp',
        client_email: 'client@example.com',
        ...(overrides.metadata ?? {}),
      },
    },
  },
});

const LEMON = {
  meta: {
    event_name: 'order_created',
    custom_data: { target_url: 'https://acme.example', business_name: 'Acme Corp', client_email: 'client@example.com' },
  },
  data: { type: 'orders', id: '42', attributes: { user_email: 'buyer@example.com', user_name: 'Buyer One' } },
};

// ------------------------------------------------------------ normalizer
test('normalizeOrder: Fiverr ORDER_CREATED -> unified shape', () => {
  const r = normalizeOrder(FIVERR);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'fiverr');
  assert.equal(r.eventId, 'fvr-10001234');
  assert.equal(r.targetUrl, 'https://acme.example');
  assert.equal(r.businessName, 'Acme Corp');
  assert.equal(r.clientEmail, 'buyer@example.com');
});

test('normalizeOrder: Stripe checkout.session.completed -> unified shape (metadata keys documented in README)', () => {
  const r = normalizeOrder(stripeSession());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'stripe');
  assert.equal(r.eventId, 'cs_test_abc123');
  assert.equal(r.targetUrl, 'https://acme.example');
  assert.equal(r.businessName, 'Acme Corp');
  assert.equal(r.clientEmail, 'client@example.com', 'metadata.client_email wins over customer_email');

  // Fallbacks: no metadata email -> customer_email; no target_url alias keys tolerated.
  const noMetaEmail = normalizeOrder(stripeSession({ metadata: { client_email: undefined, target_url: 'https://fallback.example' } }));
  assert.equal(noMetaEmail.ok, true);
  assert.equal(noMetaEmail.clientEmail, 'buyer@example.com');
  assert.equal(noMetaEmail.targetUrl, 'https://fallback.example');
});

test('normalizeOrder: LemonSqueezy order_created -> unified shape', () => {
  const r = normalizeOrder(LEMON);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'lemonsqueezy');
  assert.equal(r.eventId, '42');
  assert.equal(r.targetUrl, 'https://acme.example');
  assert.equal(r.businessName, 'Acme Corp');
  assert.equal(r.clientEmail, 'client@example.com');
});

test('normalizeOrder: unknown / malformed payloads -> { ok:false } with a reason, no crash', () => {
  for (const bad of [null, undefined, 42, 'hi', [], {}]) {
    const r = normalizeOrder(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(typeof r.message === 'string' && r.message.length > 0);
  }
  const unknown = normalizeOrder({ provider: 'wix', order: { id: 1 } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /unrecognized provider payload shape/);

  const fiverrMissingOrder = normalizeOrder({ type: 'ORDER_CREATED' });
  assert.equal(fiverrMissingOrder.ok, false);
  assert.match(fiverrMissingOrder.message, /fiverr/);

  // Recognized provider but no target URL inside -> named failure.
  const noUrl = normalizeOrder({ type: 'ORDER_CREATED', data: { order: { id: 'x', requirements: 'no link in here' } } });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.message, /no target website URL/i);

  const stripeMissingSession = normalizeOrder({ type: 'checkout.session.completed' });
  assert.equal(stripeMissingSession.ok, false);
  assert.match(stripeMissingSession.message, /stripe/i);
});

test('helpers: findUrl pulls http(s) URLs out of free text, pick walks dotted paths', () => {
  assert.equal(findUrl('Scan https://acme.example now, thanks!'), 'https://acme.example');
  assert.equal(findUrl('no url'), null);
  assert.equal(findUrl(undefined, '', 42), null);
  assert.equal(pick({ a: { b: 'x' } }, 'nope', 'a.b'), 'x');
  assert.equal(pick({ a: 1 }, 'a'), null, 'non-strings are skipped');
});

// --------------------------------------------------------------- API tests

let happy; // success-path app (stub fetcher, stub email sender)
let happyDb;
let sender;

before(() => {
  happyDb = tmpDb();
  sender = stubSender();
  happy = startApp({ dbPath: happyDb, fetcher: fakeFetcher(), emailSender: sender, publicBaseUrl: 'https://ass-score.com' });
});

after(() => {
  happy.server.close();
});

test('E2E: Fiverr order -> 202, scan row exists with targetUrl/businessName, email sender invoked with the report-link payload', async () => {
  const res = await post(happy.base, FIVERR);
  assert.equal(res.status, 202);
  const json = await res.json();
  assert.equal(json.accepted, true);
  assert.equal(json.status, 'queued');
  assert.equal(json.provider, 'fiverr');
  assert.equal(json.targetUrl, 'https://acme.example/');
  assert.equal(json.businessName, 'Acme Corp');
  assert.equal(json.emailDeliveredTo, 'buyer@example.com');

  const scans = await waitForScan(happyDb);
  const row = scans[0];
  assert.equal(row.url, 'https://acme.example/', 'scan row holds the extracted target URL');
  assert.ok(Number.isInteger(row.score) && row.score >= 0 && row.score <= 100);
  assert.ok(typeof row.roast === 'string' && row.roast.length > 0, 'scan carries its Slop Roast');

  const ev = await waitForEvent(happyDb, 'fiverr:fvr-10001234');
  assert.equal(ev.status, 'completed');
  assert.equal(ev.scan_id, row.id);
  assert.equal(ev.business_name, 'Acme Corp');

  assert.equal(sender.calls.length, 1, 'email sender invoked exactly once');
  const sent = sender.calls[0];
  assert.equal(sent.to, 'buyer@example.com', 'client email is the recipient');
  assert.equal(sent.scan.id, row.id);
  assert.equal(sent.scan.url, 'https://acme.example/');
  // The report-link email is built from the scan payload -> prove the link exists.
  const mail = buildReportEmail({ scan: sent.scan, to: sent.to, publicBaseUrl: 'https://ass-score.com' });
  assert.ok(mail.text.includes(`https://ass-score.com/scan/${row.id}`), 'email carries the report link');
  assert.ok(mail.text.includes(`${100 - row.score} / 100`), 'email carries the public (flipped) score');
});

test('idempotency: replay of the same provider event id -> 200 already_processed, no second scan', async () => {
  const res = await post(happy.base, FIVERR);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.status, 'already_processed');
  assert.equal(json.note, 'already processed');
  assert.equal(json.scanId, (await waitForScan(happyDb))[0].id);

  const scans = query(happyDb, 'SELECT COUNT(*) AS n FROM scans');
  assert.equal(scans[0].n, 1, 'no second scan row');
  const events = query(happyDb, 'SELECT COUNT(*) AS n FROM webhook_events');
  assert.equal(events[0].n, 1, 'no second event row');
  assert.equal(sender.calls.length, 1, 'no second email');
});

/** Poll until `predicate()` is truthy (used for async scan/email completion). */
async function waitFor(predicate, label, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(20);
  }
}

test('happy path works for Stripe and LemonSqueezy fixtures too', async () => {
  const resStripe = await post(happy.base, stripeSession({ id: 'cs_test_xyz789' }));
  assert.equal(resStripe.status, 202);
  const jsonStripe = await resStripe.json();
  assert.equal(jsonStripe.provider, 'stripe');
  assert.equal(jsonStripe.emailDeliveredTo, 'client@example.com');

  const resLemon = await post(happy.base, LEMON);
  assert.equal(resLemon.status, 202);
  const jsonLemon = await resLemon.json();
  assert.equal(jsonLemon.provider, 'lemonsqueezy');
  assert.equal(jsonLemon.emailDeliveredTo, 'client@example.com');

  await waitFor(() => query(happyDb, 'SELECT COUNT(*) AS n FROM scans')[0].n === 3, 'three scans');
  await waitFor(() => sender.calls.length === 3, 'three emails');
  assert.equal(sender.calls.filter((c) => c.to === 'client@example.com').length, 2, 'both Stripe and LS emails went to the client email');
});

test('missing client email: order still scans, scan 202, no email attempted', async () => {
  const sender2 = stubSender();
  const db2 = tmpDb();
  const app2 = startApp({ dbPath: db2, fetcher: fakeFetcher(), emailSender: sender2, maxWebhooksPerDay: 20 });
  try {
    const body = stripeSession({ id: 'cs_test_noemail', metadata: { client_email: undefined, customer_email: undefined } });
    delete body.data.object.customer_email; // rely on the metadata-only shape
    const res = await post(app2.base, body);
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.emailDeliveredTo, null);
    const rows = await waitForScan(db2);
    assert.equal(rows.length, 1, 'scan still created');
    await sleep(100);
    assert.equal(sender2.calls.length, 0, 'no email without an address');
  } finally {
    app2.server.close();
  }
});

test('SSRF guard applied: private-IP / banned-hostname targets -> 400 blocked, nothing enqueued', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher() }); // DEFAULT guard (validateUrl + resolveAndCheck)
  try {
    for (const target of ['http://10.0.0.5/', 'http://127.0.0.1:3000/', 'http://127.0.0.1/', 'http://localhost/']) {
      const res = await post(app.base, stripeSession({ id: `cs_blocked_${target.replace(/[^a-z0-9]/gi, '')}`, target_url: target }));
      assert.equal(res.status, 400, target);
      const json = await res.json();
      assert.equal(json.error.code, 'blocked', target);
    }
    await sleep(100);
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM scans')[0].n, 0, 'no scan rows for blocked targets');
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM webhook_events')[0].n, 0, 'no event rows for blocked targets');
  } finally {
    app.server.close();
  }
});

test('malformed payload -> 400 with a reason; malformed email -> 400 invalid_email', async () => {
  const badBodies = [
    {},
    { type: 'ORDER_CREATED' },
    { random: 'shape' },
    { type: 'checkout.session.completed' },
    [],
  ];
  for (const body of badBodies) {
    const res = await post(happy.base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_payload', JSON.stringify(body));
    assert.ok(typeof json.error.message === 'string' && json.error.message.length > 0, 'has a clear reason');
  }
  // A JSON-string body fails the strict JSON parser -> 400 invalid_json.
  const resBadJson = await post(happy.base, 'not json');
  assert.equal(resBadJson.status, 400);
  assert.equal((await resBadJson.json()).error.code, 'invalid_json');
  // Bad email in an otherwise valid order
  const badMail = stripeSession({ id: 'cs_bademail', metadata: { client_email: 'not-an-email' } });
  const resMail = await post(happy.base, badMail);
  assert.equal(resMail.status, 400);
  const jsonMail = await resMail.json();
  assert.equal(jsonMail.error.code, 'invalid_email');
});

test('per-IP daily rate cap: over MAX_WEBHOOKS_PER_DAY -> 429, no new scan; next UTC day resets', async () => {
  const dbp = tmpDb();
  let tick = '2026-09-08T10:00:00.000Z';
  const clock = () => tick;
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), now: clock, maxWebhooksPerDay: 2 });
  try {
    const res1 = await post(app.base, stripeSession({ id: 'cs_day_1' }));
    assert.equal(res1.status, 202);
    const res2 = await post(app.base, stripeSession({ id: 'cs_day_2' }));
    assert.equal(res2.status, 202);
    await waitForScan(dbp);

    const res3 = await post(app.base, stripeSession({ id: 'cs_day_3' }));
    assert.equal(res3.status, 429);
    const json3 = await res3.json();
    assert.equal(json3.error.code, 'rate_limited');
    assert.match(json3.error.message, /2 per day/);
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM scans')[0].n, 2, 'over-cap request created no scan');
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM webhook_events')[0].n, 2, 'over-cap request created no event row');

    // A new UTC day gives a fresh bucket.
    tick = '2026-09-09T08:00:00.000Z';
    const res4 = await post(app.base, stripeSession({ id: 'cs_day_4' }));
    assert.equal(res4.status, 202);
    await waitFor(() => query(dbp, 'SELECT COUNT(*) AS n FROM scans')[0].n === 3, 'third scan rows');
  } finally {
    app.server.close();
  }
});

test('email failure does not fail the webhook: 202 + scan completes anyway', async () => {
  const failingSender = stubSender({ behavior: 'reject' });
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: failingSender });
  try {
    const res = await post(app.base, FIVERR);
    assert.equal(res.status, 202);
    const scans = await waitForScan(dbp);
    assert.equal(scans.length, 1, 'scan row exists despite email failure');
    const ev = await waitForEvent(dbp, 'fiverr:fvr-10001234');
    assert.equal(ev.status, 'completed', 'event marked completed (email is best-effort)');
    assert.equal(failingSender.calls.length, 1, 'the failing sender was still invoked');
  } finally {
    app.server.close();
  }
});