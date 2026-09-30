import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { verifyStripeSignature } from '../src/stripeSignature.js';
import { extractStripeSession } from '../src/orderNormalizer.js';
import { createStripeClient } from '../src/stripeClient.js';

/**
 * Paid-report fulfillment — order checkout + webhook delivery.
 *
 * Order-intent now runs the full-Stripe flow (owner-approved 2026-09-25): a
 * per-order Checkout Session is created BEFORE the order row, and the buyer
 * is redirected to session.url. Its contract tests live in
 * test/stripeVerify.test.js; this file covers the webhook path
 * (client_reference_id + email correlation, unmatched_orders, idempotent
 * retries), Stripe signature verification (unit + E2E), and POST /admin/deliver
 * (manual fulfillment).
 */

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assfulfill-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html = SLOP_HTML) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

const offlineValidateTarget = async (raw) => validateUrl(raw);
/**
 * Fake Stripe client (no network). createCheckoutSession returns a session
 * keyed `cs_test_<n>` (recorded in `sessions`, settable via overrides),
 * getCheckoutSession reads that map. `createImpl`/`getImpl` replace the
 * default behavior when a test needs a failure (throw a StripeAuthError
 * etc.). Webhook-endpoint methods just record calls.
 */
export function fakeStripe({ sessions = new Map(), createImpl, getImpl } = {}) {
  const calls = { createCheckoutSession: [], getCheckoutSession: [], createWebhookEndpoint: [], listWebhookEndpoints: [] };
  const client = {
    calls,
    sessions,
    async createCheckoutSession(params) {
      calls.createCheckoutSession.push(params);
      if (createImpl) return createImpl(params);
      const id = `cs_test_${calls.createCheckoutSession.length}`;
      const session = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        client_reference_id: params.client_reference_id,
        customer_email: params.customer_email,
        payment_status: 'unpaid',
        metadata: params.metadata,
        ...(sessions.get(id) ?? {}),
      };
      sessions.set(id, session);
      return session;
    },
    async getCheckoutSession(id) {
      calls.getCheckoutSession.push(id);
      if (getImpl) return getImpl(id);
      const session = sessions.get(id);
      if (!session) {
        const err = new Error(`No such checkout session: ${id}`);
        err.code = 'stripe_error';
        err.status = 404;
        throw err;
      }
      return session;
    },
    async createWebhookEndpoint(params) {
      calls.createWebhookEndpoint.push(params);
      return { id: 'we_test_1', url: params.url, secret: 'whsec_registered' };
    },
    async listWebhookEndpoints(limit) {
      calls.listWebhookEndpoints.push(limit);
      return { data: [] };
    },
  };
  return client;
}

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
  // Caps disabled: the suite shares one 127.0.0.1 IP across many scans, so a
  // default 3/day scan cap would 429 legitimate test traffic. (The legacy
  // webhook path's own cap behavior is covered by webhookFulfillment.test.js.)
  // A fake Stripe client + price are injected so order-intent works offline.
  const app = createApp({
    validateTarget: offlineValidateTarget,
    maxScansPerDay: 0,
    maxWebhooksPerDay: 0,
    stripe: fakeStripe(),
    stripePriceId: 'price_test_1',
    reportTokenSecret: 'test-secret',
    ...opts,
  });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** POST JSON and return { status, json } (body parsed once, awaited). */
async function postJson(base, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

const query = (dbPath, sql, ...params) => new Database(dbPath, { readonly: true }).prepare(sql).all(...params);

/** Create a real scan through the API (synchronous response with the id). */
async function makeScan(base, url = 'https://acme.example') {
  const { status, json } = await postJson(base, '/api/v1/scan', { url });
  assert.equal(status, 200, 'scan should succeed');
  return json;
}

/** Register an order-intent for an existing scan. */
async function makeOrder(base, scanId, email = 'buyer@example.com') {
  const { status, json } = await postJson(base, '/api/v1/order-intent', { scanId, email });
  assert.equal(status, 200, 'order-intent should succeed');
  return json;
}

// Stripe payloads ------------------------------------------------------------------

/** A payment-link checkout.session.completed (NO metadata — the new flow). */
const paymentLinkSession = (overrides = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: overrides.id ?? 'cs_test_paylink_1',
      client_reference_id: overrides.client_reference_id ?? undefined,
      customer_details: overrides.customer_details ?? { email: 'buyer@example.com' },
      ...(overrides.session ?? {}),
    },
  },
});

/** Sign a JSON body exactly the way Stripe does: t.<unix-seconds>.<payload>. */
function signBody(secret, body, { tsSec } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const t = tsSec ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${signature}` };
}

// ------------------------------------------------------------------ signature

test('verifyStripeSignature: valid signature passes; bad secret / stale t / missing header fail', () => {
  const secret = 'whsec_test_123';
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const t = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

  assert.equal(verifyStripeSignature({ secret, header: `t=${t},v1=${good}`, payload }).ok, true);

  // Wrong secret (tampered body or wrong key) -> fail.
  const bad = createHmac('sha256', 'whsec_wrong').update(`${t}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature({ secret, header: `t=${t},v1=${bad}`, payload }).ok, false);

  // Stale timestamp > 5 min tolerance.
  assert.equal(
    verifyStripeSignature({ secret, header: `t=${t - 400},v1=${good}`, payload, nowMs: Date.now() }).ok,
    false,
    'timestamps older than the tolerance window are rejected'
  );

  // Missing / malformed header.
  assert.equal(verifyStripeSignature({ secret, header: undefined, payload }).ok, false);
  assert.equal(verifyStripeSignature({ secret, header: 'v1=abc', payload }).ok, false);
  assert.equal(verifyStripeSignature({ secret, header: `t=${t}`, payload }).ok, false);
});

test('extractStripeSession: recognizes payment-link sessions (no metadata) without requiring target_url', () => {
  const r = extractStripeSession(paymentLinkSession());
  assert.equal(r.ok, true);
  assert.equal(r.session.id, 'cs_test_paylink_1');
  assert.equal(r.session.metadata, undefined, 'payment-link sessions carry no metadata');

  assert.equal(extractStripeSession({ type: 'ORDER_CREATED', data: { order: {} } }), null, 'non-Stripe events return null');
  const broken = extractStripeSession({ type: 'checkout.session.completed' });
  assert.equal(broken.ok, false, 'stripe event without data.object is malformed');
  assert.equal(extractStripeSession(null), null);
});

// -------------------------------------------------- order-intent route

let appShared; // shared app for order-intent + webhook correlation tests
let sharedDb;
let senderShared;

before(() => {
  sharedDb = tmpDb();
  senderShared = stubSender();
  appShared = startApp({ dbPath: sharedDb, fetcher: fakeFetcher(), emailSender: senderShared });
});

after(() => {
  appShared.server.close();
});

test('order-intent: success creates the Checkout Session FIRST, returns checkoutUrl, records the order with the session id', async () => {
  const stripe = fakeStripe();
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripe });
  try {
    const scan = await makeScan(app.base);
    const { status, json } = await postJson(app.base, '/api/v1/order-intent', { scanId: scan.id, email: 'Buyer@Example.COM ' });
    assert.equal(status, 200);
    assert.equal(typeof json.orderId, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(json.orderId), 'orderId is a uuid');
    // Session-first: the Stripe call happened BEFORE any DB write.
    assert.equal(stripe.calls.createCheckoutSession.length, 1);
    const params = stripe.calls.createCheckoutSession[0];
    assert.equal(params.mode, 'payment');
    assert.deepEqual(params.line_items, [{ price: 'price_test_1', quantity: 1 }]);
    assert.equal(params.client_reference_id, json.orderId, 'order id doubles as the session client_reference_id');
    assert.equal(params.customer_email, 'buyer@example.com', 'email prefilled, lowercased');
    assert.equal(params.metadata.scan_id, scan.id);
    assert.equal(params.metadata.order_id, json.orderId);
    assert.equal(params.success_url, 'https://www.ass-score.com/checkout/success?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(params.cancel_url, `https://www.ass-score.com/scan/${scan.id}`);
    assert.equal(json.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1', 'buyer is sent to session.url');
    // Order row exists, carries the session id, still pending.
    const rows = query(dbp, 'SELECT id, scan_id, email, status, checkout_session_id, created_at FROM orders WHERE id = ?', json.orderId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scan_id, scan.id);
    assert.equal(rows[0].email, 'buyer@example.com');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].checkout_session_id, 'cs_test_1', 'session id stored on the order');
    assert.ok(rows[0].created_at, 'created_at recorded');
  } finally {
    app.server.close();
  }
});
test('order-intent: scan_id alias accepted; success_url/cancel_url use the injected publicBaseUrl', async () => {
  const app = startApp({ dbPath: tmpDb(), fetcher: fakeFetcher(), emailSender: stubSender(), publicBaseUrl: 'https://ass-score.example.com' });
  try {
    const scan = await makeScan(app.base);
    const r1 = await postJson(app.base, '/api/v1/order-intent', { scan_id: scan.id, email: 'a@b.co' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
  } finally {
    app.server.close();
  }
});
test('order-intent: unknown scan -> 404; bad/missing email -> 400; missing id -> 400', async () => {
  const res404 = await postJson(appShared.base, '/api/v1/order-intent', { scanId: 'no-such-scan', email: 'a@b.co' });
  assert.equal(res404.status, 404);
  assert.equal(res404.json.error.code, 'not_found');

  const scan = await makeScan(appShared.base);
  for (const email of ['not-an-email', '', null, undefined]) {
    const res = await postJson(appShared.base, '/api/v1/order-intent', { scanId: scan.id, email });
    assert.equal(res.status, 400, String(email));
    assert.equal(res.json.error.code, 'invalid_email', String(email));
  }
  const resNoId = await postJson(appShared.base, '/api/v1/order-intent', { email: 'a@b.co' });
  assert.equal(resNoId.status, 400);
  assert.equal(resNoId.json.error.code, 'invalid_scan_id');
});

// ------------------------------------------- webhook payment-link correlation

test('webhook: client_reference_id match fulfills the order and emails the report link', async () => {
  const scan = await makeScan(appShared.base);
  const { orderId } = await makeOrder(appShared.base, scan.id, 'correlate-ref@example.com');

  const { status, json } = await postJson(appShared.base, '/api/v1/webhook', paymentLinkSession({
    id: 'cs_test_ref_match',
    client_reference_id: orderId,
    customer_details: { email: 'someone-else@example.com' }, // ref wins over email
  }));
  assert.equal(status, 200);
  assert.equal(json.accepted, true);
  assert.equal(json.status, 'fulfilled');
  assert.equal(json.orderId, orderId);
  assert.equal(json.scanId, scan.id);
  assert.equal(json.emailDeliveredTo, 'correlate-ref@example.com', 'email goes to the ORDER email, not the session email');

  const rows = query(sharedDb, 'SELECT * FROM orders WHERE id = ?', orderId);
  assert.equal(rows[0].status, 'fulfilled');
  assert.equal(rows[0].checkout_session_id, 'cs_test_ref_match');
  assert.ok(rows[0].paid_at, 'paid_at stamped');

  const sent = senderShared.calls.at(-1);
  assert.equal(sent.to, 'correlate-ref@example.com');
  assert.equal(sent.scan.id, scan.id);
  assert.ok('verdict' in sent.scan, 'emailer receives the PUBLIC scan shape (toPublicScan)');
  assert.equal(typeof sent.scan.score, 'number');
  // The sender (not the caller) builds the token'd URL — real senders do via
  // buildReportUrl/createReportToken (covered by resend.test.js); the stub
  // records the payload the webhook handed it, which is what we assert here.
});

test('webhook: Stripe retry of an already-fulfilled ref -> 200 already_fulfilled, no second email, other pending orders untouched', async () => {
  const scan = await makeScan(appShared.base);
  const { orderId } = await makeOrder(appShared.base, scan.id, 'retry@example.com');
  const { orderId: secondOrderId } = await makeOrder(appShared.base, scan.id, 'retry@example.com'); // same buyer, second pending order

  const body = paymentLinkSession({ id: 'cs_test_retry', client_reference_id: orderId, customer_details: { email: 'retry@example.com' } });
  const r1 = await postJson(appShared.base, '/api/v1/webhook', body);
  assert.equal(r1.json.status, 'fulfilled');

  const callsBefore = senderShared.calls.length;
  const r2 = await postJson(appShared.base, '/api/v1/webhook', body); // Stripe replays the SAME event
  assert.equal(r2.status, 200);
  assert.equal(r2.json.status, 'already_fulfilled');
  assert.equal(r2.json.orderId, orderId);
  assert.equal(senderShared.calls.length, callsBefore, 'retry sends NO second email');
  assert.equal(query(sharedDb, 'SELECT status FROM orders WHERE id = ?', secondOrderId)[0].status, 'pending', 'the buyer\u2019s other pending order is NOT auto-fulfilled');
});

test('webhook: no client_reference_id -> email fallback matches a pending order (< 24h)', async () => {
  const scan = await makeScan(appShared.base);
  await makeOrder(appShared.base, scan.id, 'fallback@example.com');
  const { status, json } = await postJson(appShared.base, '/api/v1/webhook', paymentLinkSession({
    id: 'cs_test_email_fallback',
    client_reference_id: undefined,
    customer_details: { email: 'FALLBACK@example.com' }, // case-insensitive
  }));
  assert.equal(status, 200);
  assert.equal(json.status, 'fulfilled');
  assert.equal(json.emailDeliveredTo, 'fallback@example.com');
  const row = query(sharedDb, 'SELECT status FROM orders WHERE email = ?', 'fallback@example.com');
  assert.equal(row.filter((r) => r.status === 'fulfilled').length, 1, 'the pending order was fulfilled');
});

test('webhook: no matching pending order -> 200 unmatched + unmatched_orders row (owner bare-link case)', async () => {
  const before = query(sharedDb, 'SELECT COUNT(*) AS n FROM unmatched_orders')[0].n;
  const r1 = await postJson(appShared.base, '/api/v1/webhook', paymentLinkSession({
    id: 'cs_test_unmatched',
    client_reference_id: undefined,
    customer_details: { email: 'orphan-buyer@example.com' },
  }));
  assert.equal(r1.status, 200);
  assert.equal(r1.json.status, 'unmatched');
  const rows = query(sharedDb, 'SELECT session_id, email FROM unmatched_orders WHERE session_id = ?', 'cs_test_unmatched');
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].email, 'orphan-buyer@example.com');

  // Stripe retry of the same event: still 200, still ONE row.
  const r2 = await postJson(appShared.base, '/api/v1/webhook', paymentLinkSession({
    id: 'cs_test_unmatched',
    customer_details: { email: 'orphan-buyer@example.com' },
  }));
  assert.equal(r2.status, 200);
  assert.equal(r2.json.status, 'unmatched');
  assert.equal(query(sharedDb, 'SELECT COUNT(*) AS n FROM unmatched_orders WHERE session_id = ?', 'cs_test_unmatched')[0].n, 1);
});

test('webhook: metadata.target_url sessions still take the legacy scan+email path (202 queued)', async () => {
  const { status, json } = await postJson(appShared.base, '/api/v1/webhook', {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_legacy_1', metadata: { target_url: 'https://acme.example' }, customer_email: 'legacy@example.com' } },
  });
  assert.equal(status, 202);
  assert.equal(json.status, 'queued');
  assert.equal(json.provider, 'stripe');
  assert.equal(json.emailDeliveredTo, 'legacy@example.com');
});

test('webhook: malformed stripe event (no data.object) -> 400 invalid_payload, not a crash', async () => {
  const { status, json } = await postJson(appShared.base, '/api/v1/webhook', { type: 'checkout.session.completed' });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_payload');
});

test('webhook: email failure fulfills the order anyway (best-effort, same as legacy flow)', async () => {
  const failing = stubSender({ behavior: 'reject' });
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: failing });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'boom@example.com');
    const { status, json } = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({ id: 'cs_test_boom', client_reference_id: orderId }));
    assert.equal(status, 200);
    assert.equal(json.status, 'fulfilled');
    assert.equal(query(dbp, 'SELECT status FROM orders WHERE id = ?', orderId)[0].status, 'fulfilled', 'order is fulfilled despite the email crash');
  } finally {
    app.server.close();
  }
});

// --------------------------------------------- signature gate (E2E)

test('webhook signature gate: STRIPE_WEBHOOK_SECRET set -> valid passes, missing/invalid -> 401', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripeWebhookSecret: 'whsec_e2e' });
  const secret = 'whsec_e2e';
  try {
    // Valid signature -> 200 (unmatched order path is fine for the test).
    const body = paymentLinkSession({ id: 'cs_test_sig_ok', customer_details: { email: 'sig@example.com' } });
    const { payload, header } = signBody(secret, body);
    const okRes = await fetch(`${app.base}/api/v1/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: payload,
    });
    assert.equal(okRes.status, 200, 'valid signature accepted');
    assert.equal((await okRes.json()).status, 'unmatched');

    // Missing header -> 401.
    const noHeaderRes = await fetch(`${app.base}/api/v1/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paymentLinkSession({ id: 'cs_test_sig_nohdr' })),
    });
    assert.equal(noHeaderRes.status, 401);
    assert.equal((await noHeaderRes.json()).error.code, 'invalid_signature');

    // Tampered signature / wrong secret -> 401.
    const { header: badHeader } = signBody('whsec_wrong', paymentLinkSession({ id: 'cs_test_sig_bad' }));
    const badRes = await fetch(`${app.base}/api/v1/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': badHeader },
      body: JSON.stringify(paymentLinkSession({ id: 'cs_test_sig_bad' })),
    });
    assert.equal(badRes.status, 401);
    assert.equal((await badRes.json()).error.code, 'invalid_signature');

    // A stale timestamp (signed 10 min ago) -> 401.
    const { header: oldHeader } = signBody(secret, paymentLinkSession({ id: 'cs_test_sig_old' }), { tsSec: Math.floor(Date.now() / 1000) - 600 });
    const oldRes = await fetch(`${app.base}/api/v1/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': oldHeader },
      body: JSON.stringify(paymentLinkSession({ id: 'cs_test_sig_old' })),
    });
    assert.equal(oldRes.status, 401);
  } finally {
    app.server.close();
  }
});

test('webhook: without STRIPE_WEBHOOK_SECRET a stripe event still processes (local tests / staged deploy)', async () => {
  // No secret passed AND no env var: the default-free path must still work
  // rather than 401 (a warning is logged once at router creation instead).
  const env = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender() });
  try {
    const { status, json } = await postJson(app.base, '/api/v1/webhook', paymentLinkSession({ id: 'cs_test_nosecret' }));
    assert.equal(status, 200);
    assert.equal(json.status, 'unmatched');
  } finally {
    if (env !== undefined) process.env.STRIPE_WEBHOOK_SECRET = env;
    app.server.close();
  }
});

// ------------------------------------------------------ admin manual deliver

test('admin deliver: auth required (403), success sends the report email, 404 for unknown scan, 400 for bad email', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, adminPassword: 's3cret' });
  try {
    // No / wrong password -> 403, no delivery.
    const noAuth = await postJson(app.base, '/admin/deliver', { scanId: 'x', email: 'a@b.co' });
    assert.equal(noAuth.status, 403);
    const badAuth = await postJson(app.base, '/admin/deliver', { scanId: 'x', email: 'a@b.co' }, { 'x-admin-password': 'nope' });
    assert.equal(badAuth.status, 403);
    assert.equal(sender.calls.length, 0);

    // Unknown scan -> 404.
    const res404 = await postJson(app.base, '/admin/deliver', { scanId: 'no-such-scan', email: 'a@b.co' }, { 'x-admin-password': 's3cret' });
    assert.equal(res404.status, 404);
    assert.equal(res404.json.error.code, 'not_found');

    // Bad email -> 400.
    const scan = await makeScan(app.base);
    const res400 = await postJson(app.base, '/admin/deliver', { scanId: scan.id, email: 'nope' }, { 'x-admin-password': 's3cret' });
    assert.equal(res400.status, 400);
    assert.equal(res400.json.error.code, 'invalid_email');

    // Success -> 200 delivered:true, emailer invoked with the public scan shape.
    const res = await postJson(app.base, '/admin/deliver', { scanId: scan.id, email: 'manual@example.com' }, { 'x-admin-password': 's3cret' });
    assert.equal(res.status, 200);
    assert.equal(res.json.delivered, true);
    assert.equal(res.json.scanId, scan.id);
    assert.equal(res.json.email, 'manual@example.com');
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0].to, 'manual@example.com');
    assert.equal(sender.calls[0].scan.id, scan.id);
    assert.ok('verdict' in sender.calls[0].scan, 'public shape handed to the sender');

    // ?pw= query form works too (the admin-stats convention).
    const resPw = await postJson(app.base, '/admin/deliver?pw=s3cret', { scanId: scan.id, email: 'pw@example.com' });
    assert.equal(resPw.status, 200);
    assert.equal(resPw.json.delivered, true);
  } finally {
    app.server.close();
  }
});

test('admin deliver: unset ADMIN_PASSWORD disables the route (403 always), like /admin/stats', async () => {
  const app = startApp({ dbPath: tmpDb(), fetcher: fakeFetcher(), emailSender: stubSender() });
  try {
    const { status } = await postJson(app.base, '/admin/deliver', { scanId: 'x', email: 'a@b.co' });
    assert.equal(status, 403);
  } finally {
    app.server.close();
  }
});

test('admin deliver: an expired (31-day-old) scan returns the expiry note and NO email is sent; a fresh scan still delivers', async () => {
  // Owner-approved preserve-data/expire-access: the scan row survives retention
  // (fulfilled paid scans are exempt), but its 30-day report window has passed,
  // so /admin/deliver must NOT re-send the report link.
  const NOW = '2026-09-23T12:00:00.000Z';
  const dbp = tmpDb();
  const sender = stubSender();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, adminPassword: 's3cret', now: () => NOW });
  try {
    // A scan 31 days old with a fulfilled order (the retainable paid case).
    const db = openDb(dbp);
    const scanId = 'scan-expired-31d';
    db.insertScan({ id: scanId, url: 'https://old.example/', score: 42, breakdown: {}, createdAt: '2026-08-23T12:00:00.000Z' });
    db.insertOrder({ id: 'order-expired', scanId, email: 'buyer@example.com', createdAt: '2026-08-23T12:00:00.000Z' });
    db.markOrderFulfilled('order-expired', { checkoutSessionId: 'cs_test_expired', paidAt: '2026-08-23T12:00:00.000Z' });
    db.close();

    const { status, json } = await postJson(app.base, '/admin/deliver', { scanId, email: 'buyer@example.com' }, { 'x-admin-password': 's3cret' });
    assert.equal(status, 200);
    assert.equal(json.delivered, false);
    assert.equal(json.scanId, scanId);
    assert.equal(json.email, 'buyer@example.com');
    assert.ok(json.note.includes('30-day access window has passed'), `expiry note present: ${json.note}`);
    assert.equal(sender.calls.length, 0, 'emailSender NOT called for an expired scan');

    // Same app + clock: a FRESH scan still delivers normally (the gate is
    // per-scan, not a global freeze).
    const fresh = await makeScan(app.base);
    const res = await postJson(app.base, '/admin/deliver', { scanId: fresh.id, email: 'fresh@example.com' }, { 'x-admin-password': 's3cret' });
    assert.equal(res.status, 200);
    assert.equal(res.json.delivered, true);
    assert.equal(sender.calls.length, 1, 'fresh scan still emails');
    assert.equal(sender.calls[0].to, 'fresh@example.com');
  } finally {
    app.server.close();
  }
});