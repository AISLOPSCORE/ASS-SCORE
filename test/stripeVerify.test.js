import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import {
  createStripeClient,
  formEncode,
  StripeAuthError,
  StripeUnavailableError,
} from '../src/stripeClient.js';
import { ensureWebhookEndpoint } from '../src/registerWebhook.js';
/**
 * Full-Stripe checkout redesign (owner-approved 2026-09-25) — Task A backend:
 * per-order Checkout Sessions, same-session verify, polling status, and
 * webhook-endpoint registration. All Stripe calls go through an injected
 * FAKE client (no network); the real client's wire behavior (form encoding,
 * auth header, error normalization) is covered with a fake fetch.
 */
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assverify-')), 'test.db');
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;
const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: SLOP_HTML }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);
function stubSender() {
  const calls = [];
  const send = async (scan, to) => {
    calls.push({ scan, to });
    return { ok: true, attempts: 1 };
  };
  send.calls = calls;
  return send;
}
function fakeStripe({ sessions = new Map(), createImpl, getImpl } = {}) {
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
function startApp(opts = {}) {
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
async function makeScan(base) {
  const { status, json } = await postJson(base, '/api/v1/scan', { url: 'https://acme.example' });
  assert.equal(status, 200, 'scan should succeed');
  return json;
}
/** Register an order-intent (full-Stripe flow) for an existing scan. */
async function makeOrder(base, scanId, email = 'buyer@example.com') {
  const { status, json } = await postJson(base, '/api/v1/order-intent', { scanId, email });
  assert.equal(status, 200, 'order-intent should succeed');
  return json;
}
// ============================================================= stripe client
test('formEncode: nested arrays/objects serialize Stripe-style (x-www-form-urlencoded)', () => {
  const body = formEncode({
    mode: 'payment',
    line_items: [{ price: 'price_123', quantity: 1 }],
    metadata: { scan_id: 's/1', order_id: 'o/2' },
    customer_email: 'a@b.co',
    nullish: undefined,
  });
  assert.equal(body.includes('mode=payment'), true);
  assert.equal(body.includes('line_items%5B0%5D%5Bprice%5D=price_123'), true);
  assert.equal(body.includes('line_items%5B0%5D%5Bquantity%5D=1'), true);
  assert.equal(body.includes('metadata%5Bscan_id%5D=s%2F1'), true);
  assert.equal(body.includes('metadata%5Border_id%5D=o%2F2'), true);
  assert.equal(body.includes('customer_email=a%40b.co'), true);
  assert.equal(body.includes('nullish'), false, 'null/undefined are skipped');
});
test('stripe client: POSTs form-encoded with bearer auth; 401 -> stripe_unauthorized; fetch threw -> stripe_unavailable; 500 -> stripe_unavailable', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const status = url.includes('401') ? 401 : url.includes('500') ? 500 : 200;
    const body = status === 500 ? 'boom' : status === 401
      ? JSON.stringify({ error: { message: 'Invalid API Key' } })
      : JSON.stringify({ id: 'cs_wire_1' });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  const client = createStripeClient({ apiKey: 'sk_test_wire', fetchImpl, timeoutMs: 1000 });
  // createCheckoutSession: right path, form body, bearer auth.
  const session = await client.createCheckoutSession({ mode: 'payment', line_items: [{ price: 'p1', quantity: 1 }] });
  assert.equal(session.id, 'cs_wire_1');
  assert.equal(seen[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk_test_wire');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(String(seen[0].init.body).startsWith('mode=payment&line_items'));
  // 401 -> StripeAuthError (stripe_unauthorized).
  await assert.rejects(() => client.getCheckoutSession('401'), (err) => err instanceof StripeAuthError && err.code === 'stripe_unauthorized');
  // fetch threw (network) -> stripe_unavailable.
  const dead = createStripeClient({ apiKey: 'sk', fetchImpl: async () => { throw new TypeError('fetch failed'); }, timeoutMs: 1000 });
  await assert.rejects(() => dead.getCheckoutSession('cs_1'), (err) => err instanceof StripeUnavailableError && err.code === 'stripe_unavailable');
  // 500 -> stripe_unavailable.
  await assert.rejects(() => client.getCheckoutSession('500'), (err) => err instanceof StripeUnavailableError && err.code === 'stripe_unavailable');
});
// ======================================================= order-intent config
test('order-intent: missing STRIPE_SECRET_KEY -> 503 config_missing naming the env var', async () => {
  const env = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripe: undefined });
  try {
    const scan = await makeScan(app.base);
    const { status, json } = await postJson(app.base, '/api/v1/order-intent', { scanId: scan.id, email: 'a@b.co' });
    assert.equal(status, 503);
    assert.equal(json.error.code, 'config_missing');
    assert.ok(json.error.message.includes('STRIPE_SECRET_KEY'), 'message names the exact env var');
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM orders')[0].n, 0, 'no order row on config failure');
  } finally {
    if (env !== undefined) process.env.STRIPE_SECRET_KEY = env;
    app.server.close();
  }
});
test('order-intent: missing STRIPE_PRICE_ID -> 503 config_missing naming the env var', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripePriceId: '' });
  try {
    const scan = await makeScan(app.base);
    const { status, json } = await postJson(app.base, '/api/v1/order-intent', { scanId: scan.id, email: 'a@b.co' });
    assert.equal(status, 503);
    assert.equal(json.error.code, 'config_missing');
    assert.ok(json.error.message.includes('STRIPE_PRICE_ID'), 'message names the exact env var');
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM orders')[0].n, 0);
  } finally {
    app.server.close();
  }
});
test('order-intent: Stripe session-create failure -> 502 AND no order row (session created before insert)', async () => {
  const dbp = tmpDb();
  const stripe = fakeStripe({
    createImpl: async () => { throw new StripeAuthError('Stripe rejected the secret key'); },
  });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripe });
  try {
    const scan = await makeScan(app.base);
    const { status, json } = await postJson(app.base, '/api/v1/order-intent', { scanId: scan.id, email: 'a@b.co' });
    assert.equal(status, 502);
    assert.equal(json.error.code, 'stripe_unauthorized');
    assert.equal(query(dbp, 'SELECT COUNT(*) AS n FROM orders')[0].n, 0, 'NO order row when the session could not be created');
  } finally {
    app.server.close();
  }
});
test('order-intent: session is created BEFORE any order row exists (proven from inside createImpl)', async () => {
  const dbp = tmpDb();
  let ordersAtCreateTime = -1;
  const stripe = fakeStripe({
    createImpl: async (params) => {
      ordersAtCreateTime = query(dbp, 'SELECT COUNT(*) AS n FROM orders')[0].n;
      return { id: 'cs_test_pre', url: 'https://checkout.stripe.com/c/pay/cs_test_pre', client_reference_id: params.client_reference_id };
    },
  });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripe });
  try {
    const scan = await makeScan(app.base);
    const { status, json } = await postJson(app.base, '/api/v1/order-intent', { scanId: scan.id, email: 'a@b.co' });
    assert.equal(status, 200);
    assert.equal(ordersAtCreateTime, 0, 'Stripe call ran while the orders table was still empty');
    assert.equal(query(dbp, 'SELECT checkout_session_id FROM orders WHERE id = ?', json.orderId)[0].checkout_session_id, 'cs_test_pre');
  } finally {
    app.server.close();
  }
});
// ================================================================== verify
test('verify: paid session -> fulfilled, reportUrl present, email sent once', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'buyer@example.com');
    const { status, json } = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(status, 200);
    assert.equal(json.status, 'fulfilled');
    assert.equal(json.scanId, scan.id);
    assert.equal(json.reportUrl, `https://www.ass-score.com/api/v1/report/${scan.id}?token=${tokenFor('test-secret', scan.id)}`);
    const row = query(dbp, 'SELECT status, checkout_session_id, paid_at FROM orders WHERE id = ?', orderId)[0];
    assert.equal(row.status, 'fulfilled');
    assert.equal(row.checkout_session_id, 'cs_test_1');
    assert.ok(row.paid_at, 'paid_at stamped');
    assert.equal(sender.calls.length, 1, 'email sent once');
    assert.equal(sender.calls[0].to, 'buyer@example.com');
    assert.equal(sender.calls[0].scan.id, scan.id);
  } finally {
    app.server.close();
  }
});
test('verify: second call is idempotent — same status, NO second email', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'buyer@example.com');
    const first = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'fulfilled');
    // Refresh (the success page re-polls / re-verifies after a refresh).
    const second = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'fulfilled');
    assert.equal(second.json.reportUrl, first.json.reportUrl, 'same reportUrl');
    assert.equal(sender.calls.length, 1, 'NO second email');
  } finally {
    app.server.close();
  }
});
test('verify: verify races the webhook (webhook won) — 200 fulfilled, no second email', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_1', { payment_status: 'paid' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender, stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'buyer@example.com');
    // The webhook fulfills first (primary path), with its own session id.
    const wh = await postJson(app.base, '/api/v1/webhook', {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_wh_1', client_reference_id: orderId, customer_details: { email: 'buyer@example.com' } } },
    });
    assert.equal(wh.status, 200);
    assert.equal(wh.json.status, 'fulfilled');
    const before = sender.calls.length;
    // The success page's verify arrives late: it must re-open, not re-email.
    const { status, json } = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(status, 200);
    assert.equal(json.status, 'fulfilled');
    assert.equal(json.scanId, scan.id);
    assert.equal(sender.calls.length, before, 'NO second email from the late verify');
  } finally {
    app.server.close();
  }
});
test('verify: unpaid session -> 200 { status: pending }, order stays pending, no email', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'buyer@example.com');
    const { status, json } = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(status, 200);
    assert.deepEqual(json, { status: 'pending' }, 'not an error — the success page keeps polling');
    assert.equal(query(dbp, 'SELECT status FROM orders WHERE id = ?', orderId)[0].status, 'pending');
    assert.equal(sender.calls.length, 0);
  } finally {
    app.server.close();
  }
});
test('verify: session ref mismatch -> 400 invalid_session', async () => {
  const dbp = tmpDb();
  const stripe = fakeStripe({ sessions: new Map([['cs_test_other', { client_reference_id: 'some-other-order', payment_status: 'paid' }]]) });
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender(), stripe });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id);
    const { status, json } = await postJson(app.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_other' });
    assert.equal(status, 400);
    assert.equal(json.error.code, 'invalid_session');
    assert.equal(query(dbp, 'SELECT status FROM orders WHERE id = ?', orderId)[0].status, 'pending');
  } finally {
    app.server.close();
  }
});
test('verify: unknown order -> 404; missing sessionId -> 400 invalid_session_id; Stripe unavailable -> 502', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: stubSender() });
  try {
    const missing = await postJson(app.base, '/api/v1/orders/no-such-order/verify', { sessionId: 'cs_test_1' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'not_found');
    // Order with NO stored session id (e.g. a legacy row) + no body.sessionId
    // -> 400 invalid_session_id (nothing to verify against).
    const scan = await makeScan(app.base);
    const db = new Database(dbp);
    db.prepare("INSERT INTO orders (id, scan_id, email, status, checkout_session_id, paid_at, created_at) VALUES ('ord-no-session', ?, 'a@b.co', 'pending', NULL, NULL, ?)").run(scan.id, new Date().toISOString());
    db.close();
    const noSession = await postJson(app.base, '/api/v1/orders/ord-no-session/verify', {});
    assert.equal(noSession.status, 400);
    assert.equal(noSession.json.error.code, 'invalid_session_id');
  } finally {
    app.server.close();
  }
  const deadStripe = fakeStripe({ getImpl: async () => { throw new StripeUnavailableError('api.stripe.com timed out'); } });
  const app2 = startApp({ dbPath: tmpDb(), fetcher: fakeFetcher(), emailSender: stubSender(), stripe: deadStripe });
  try {
    const scan = await makeScan(app2.base);
    const { orderId } = await makeOrder(app2.base, scan.id);
    const { status, json } = await postJson(app2.base, `/api/v1/orders/${orderId}/verify`, { sessionId: 'cs_test_1' });
    assert.equal(status, 502);
    assert.equal(json.error.code, 'stripe_unavailable');
  } finally {
    app2.server.close();
  }
});
// =========================================================== status polling
test('GET order status: pending before fulfillment, fulfilled with reportUrl AFTER the webhook flips it', async () => {
  const dbp = tmpDb();
  const sender = stubSender();
  const app = startApp({ dbPath: dbp, fetcher: fakeFetcher(), emailSender: sender });
  try {
    const scan = await makeScan(app.base);
    const { orderId } = await makeOrder(app.base, scan.id, 'poll@example.com');
    // Pending: DB only — no Stripe call happened for this read.
    const pending = await fetch(`${app.base}/api/v1/orders/${orderId}`);
    assert.equal(pending.status, 200);
    const pendingJson = await pending.json();
    assert.equal(pendingJson.status, 'pending');
    assert.equal(pendingJson.scanId, scan.id);
    assert.equal('reportUrl' in pendingJson, false, 'no reportUrl while pending');
    // The webhook (primary path) fulfills it.
    const wh = await postJson(app.base, '/api/v1/webhook', {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_poll_1', client_reference_id: orderId, customer_details: { email: 'poll@example.com' } } },
    });
    assert.equal(wh.status, 200);
    assert.equal(wh.json.status, 'fulfilled');
    const done = await (await fetch(`${app.base}/api/v1/orders/${orderId}`)).json();
    assert.equal(done.status, 'fulfilled');
    assert.equal(done.scanId, scan.id);
    assert.equal(done.reportUrl, `https://www.ass-score.com/api/v1/report/${scan.id}?token=${tokenFor('test-secret', scan.id)}`);
    assert.equal(sender.calls.length, 1, 'the webhook sent the report email');
  } finally {
    app.server.close();
  }
});
test('GET order status: unknown order -> 404', async () => {
  const app = startApp({ dbPath: tmpDb(), fetcher: fakeFetcher(), emailSender: stubSender() });
  try {
    const res = await fetch(`${app.base}/api/v1/orders/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  } finally {
    app.server.close();
  }
});
// ========================================================= registerWebhook
test('registerWebhook: reuses an existing matching endpoint (idempotent — no duplicate)', async () => {
  const calls = [];
  const fake = {
    async listWebhookEndpoints(limit) {
      calls.push(['list', limit]);
      return { data: [
        { id: 'we_existing', url: 'https://api.example.com/api/v1/webhook' },
        { id: 'we_other', url: 'https://elsewhere.example/hook' },
      ] };
    },
    async createWebhookEndpoint(params) { calls.push(['create', params]); throw new Error('should not be called'); },
  };
  const result = await ensureWebhookEndpoint({ apiKey: 'sk_test_1', baseUrl: 'https://api.example.com/', stripe: fake });
  assert.equal(result.created, false);
  assert.equal(result.webhookUrl, 'https://api.example.com/api/v1/webhook');
  assert.equal(result.secret, null);
  assert.deepEqual(calls, [['list', 100]]);
});
test('registerWebhook: creates a NEW endpoint (event list correct) and surfaces the signing secret', async () => {
  const calls = [];
  const fake = {
    async listWebhookEndpoints() { calls.push(['list']); return { data: [] }; },
    async createWebhookEndpoint(params) {
      calls.push(['create', params]);
      return { id: 'we_new', url: params.url, secret: 'whsec_print_me' };
    },
  };
  const result = await ensureWebhookEndpoint({ apiKey: 'sk_test_1', baseUrl: 'https://api.example.com', stripe: fake });
  assert.equal(result.created, true);
  assert.equal(result.webhookUrl, 'https://api.example.com/api/v1/webhook');
  assert.equal(result.secret, 'whsec_print_me');
  const createParams = calls.find((c) => c[0] === 'create')[1];
  assert.deepEqual(createParams.enabled_events, ['checkout.session.completed']);
  assert.equal(createParams.url, 'https://api.example.com/api/v1/webhook');
});
test('registerWebhook: no key -> config error', async () => {
  const env = process.env.STRIPE_SECRET_KEY;
  const envTest = process.env.STRIPE_TEST_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_TEST_SECRET_KEY;
  try {
    await assert.rejects(() => ensureWebhookEndpoint({ apiKey: '' }), (err) => err.code === 'config_missing');
  } finally {
    if (env !== undefined) process.env.STRIPE_SECRET_KEY = env;
    if (envTest !== undefined) process.env.STRIPE_TEST_SECRET_KEY = envTest;
  }
});
// ============================================================== helpers
/** Re-compute the report token exactly as src/paywall.js does (v1.<hex> over `report:<scanId>`). */
function tokenFor(secret, scanId) {
  return `v1.${createHmac('sha256', secret).update(`report:${scanId}`).digest('hex')}`;
}