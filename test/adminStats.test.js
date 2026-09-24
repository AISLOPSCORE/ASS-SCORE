import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { runRetention } from '../src/retention.js';
import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Admin stats + homepage view tracking (backlog db64a1c9).
// Conventions mirrored from rateLimitScan.test.js / retention.test.js:
// tmp DB per test, injectable clocks, real HTTP against a local listen(0).
// ADMIN_PASSWORD is deleted from the environment at module top so the
// "unset => 403" behavior is deterministic regardless of the runner's env
// (node --test runs this file in its own child process).
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD;

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-admin-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const countViews = (dbPath) => new Database(dbPath, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM page_views').get().n;
const viewRows = (dbPath) => new Database(dbPath, { readonly: true }).prepare('SELECT ts, ip, ua, path FROM page_views ORDER BY id').all();
// Seed the paid-order ledger the same way retention.test.js does — one row per
// purchased full report. `day` mirrors the webhook route's rate-limit bucket
// (created_at's UTC day); status defaults to 'pending' like a fresh order.
const seedWebhook = (db, eventKey, createdAt, status = 'pending') =>
  db.insertWebhookEvent({
    eventKey,
    provider: 'stripe',
    eventId: `evt_${eventKey}`,
    ip: '203.0.113.9',
    day: createdAt.slice(0, 10),
    payload: { id: `evt_${eventKey}` },
    createdAt,
    status,
  });

function startApp(opts = {}) {
  // `app.listen(0)` with NO host binds synchronously (address() is available
  // immediately) — the same convention rateLimitScan.test.js uses. With an
  // explicit host the bind is async and address() is null until 'listening.
  const app = createApp({ adminPassword: PASSWORD, ...opts });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}
const track = (base, body, headers = {}) =>
  fetch(`${base}/api/v1/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
test('track: records a real browser view (path trimmed + capped at 200) with 204', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const longPath = `/${'x'.repeat(500)}`;
    const r = await track(app.base, { path: `  ${longPath}  ` }, { 'user-agent': UA });
    assert.equal(r.status, 204);
    assert.equal((await r.text()), '');
    const rows = viewRows(dbp);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, Date.parse(TICK), 'ts is epoch ms from the injected clock');
    assert.match(rows[0].ip, /127\.0\.0\.1$/, 'req.ip (IPv4 or IPv4-mapped) via the shared clientIp derivation');
    assert.equal(rows[0].ua, UA, 'user-agent stored');
    assert.equal(rows[0].path, `/${'x'.repeat(199)}`, 'path trimmed and capped at 200 chars (leading / + 199)');
  } finally {
    app.server.close();
  }
});
test('track: non-object body / missing path is a silent non-error, no row', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // JSON primitives hit body-parser's strict mode (only arrays/objects
    // accepted) -> 400 invalid_json from the shared error handler (not a 500;
    // the site beacon only ever sends {path}, so this never happens live).
    assert.equal((await track(app.base, '"just a string"', { 'user-agent': UA })).status, 400);
    assert.equal((await track(app.base, { nope: 1 }, { 'user-agent': UA })).status, 204);
    assert.equal((await track(app.base, { path: '   ' }, { 'user-agent': UA })).status, 204);
    assert.equal(countViews(dbp), 0);
  } finally {
    app.server.close();
  }
});
test('track: known bot UAs are filtered (case-insensitive substring), 204, no row', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)',
      'Slurp/2.0 (+http://www.yahoo.com/help/slurp)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.23.20.0',
      'curl/8.5.0',
      'Wget/1.21.4',
      'python-requests/2.31.0',
      'Go-http-client/1.1',
      'HeadlessChrome/120.0.6099.109',
      'PhantomJS/2.1.1',
      'Mozilla/5.0 Googlebot-MOBILE/2.1 (googlebot mid-case test)',
    ];
    for (const ua of bots) {
      const r = await track(app.base, { path: '/' }, { 'user-agent': ua });
      assert.equal(r.status, 204);
    }
    assert.equal(countViews(dbp), 0, 'no bot UA may ever be ledgered');
  } finally {
    app.server.close();
  }
});
test('track: missing / empty / whitespace UA is filtered, 204, no row', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // NOTE: undici's fetch injects `user-agent: node` when no UA is sent, so
    // the "missing UA" case is simulated with an empty header — undici drops
    // it entirely, which is exactly what a UA-less request looks like to
    // Express (req.get('user-agent') === undefined).
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': '' })).status, 204); // missing UA
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': '' })).status, 204); // empty UA
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': '   ' })).status, 204); // whitespace UA
    assert.equal(countViews(dbp), 0);
  } finally {
    app.server.close();
  }
});
test('track: same IP within 30s is deduped; a later view (31s) is recorded', async () => {
  const dbp = tmpDb();
  let tick = TICK;
  const app = startApp({ dbPath: dbp, now: () => tick });
  try {
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': UA })).status, 204);
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': UA })).status, 204, '2nd hit within window still 204');
    assert.equal(countViews(dbp), 1, 'dedup within 30s keeps one row');
    tick = new Date(Date.parse(TICK) + 31_000).toISOString();
    assert.equal((await track(app.base, { path: '/' }, { 'user-agent': UA })).status, 204);
    assert.equal(countViews(dbp), 2, 'a hit after the window is a new view');
    const rows = viewRows(dbp);
    assert.equal(rows[0].ts, Date.parse(TICK));
    assert.equal(rows[1].ts, Date.parse(tick));
  } finally {
    app.server.close();
  }
});
test('track: different IPs are NOT deduped against each other', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    await track(app.base, { path: '/' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.9' });
    assert.equal(countViews(dbp), 2, 'two distinct client IPs in the same instant both count');
    const ips = viewRows(dbp).map((r) => r.ip);
    assert.ok(ips.includes('203.0.113.9'));
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------
test('admin: 403 when ADMIN_PASSWORD is unset (route disabled until owner sets it)', async () => {
  // Env was deleted at module top; createApp must NOT inject the password.
  const app = createApp({ dbPath: tmpDb(), now: () => TICK });
  const server = app.listen(0); // no-host form: address() is available synchronously
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/admin/stats`);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
  } finally {
    server.close();
  }
});
test('admin: 403 without / with wrong password (header and query), 200 with correct one', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const noPw = await fetch(`${app.base}/admin/stats`);
    assert.equal(noPw.status, 403);
    assert.deepEqual(await noPw.json(), { error: { code: 'forbidden' } });
    const wrongHeader = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': 'wrong' } });
    assert.equal(wrongHeader.status, 403);
    const wrongQuery = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent('wrong')}`);
    assert.equal(wrongQuery.status, 403);
    const emptyHeader = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': '' } });
    assert.equal(emptyHeader.status, 403);
    const goodHeader = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(goodHeader.status, 200);
    const goodQuery = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent(PASSWORD)}`);
    assert.equal(goodQuery.status, 200);
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Admin payload shape
// ---------------------------------------------------------------------------
test('admin: stats JSON has views (total/today/last30d x30/recent) and scans summary', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    // One real view + one bot (filtered) + one scan fixture row.
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    await track(app.base, { path: '/' }, { 'user-agent': 'Googlebot/2.1' });
    const seedDb = openDb(dbp);
    seedDb.insertScan({ id: 'scan-1', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: TICK });
    seedDb.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.deepEqual(Object.keys(json).sort(), ['purchases', 'scans', 'views']);
    assert.equal(json.views.total, 1, 'bot view never counted');
    assert.equal(json.views.today, 1);
    assert.equal(json.views.last30d.length, 30, 'exactly 30 daily buckets');
    // Oldest-first, ending with today.
    assert.equal(json.views.last30d[0].date, '2026-08-25', 'window starts 29 days before today');
    assert.equal(json.views.last30d[29].date, '2026-09-23', 'window ends today');
    assert.equal(json.views.last30d[29].count, 1, 'today bucket includes the recorded view');
    assert.equal(json.views.recent.length, 1);
    assert.equal(json.views.recent[0].ts, Date.parse(TICK));
    assert.match(json.views.recent[0].ip, /127\.0\.0\.1$/);
    assert.equal(json.views.recent[0].path, '/');
    assert.equal(json.scans.total, 1);
    assert.equal(json.scans.today, 1);
    assert.equal(json.scans.last30d.length, 30);
    assert.equal(json.scans.last30d[29].count, 1, 'scan summary mirrors the view table');
    // every bucket is a {date, count} pair
    for (const bucket of json.views.last30d) assert.equal(typeof bucket.date, 'string');
    for (const bucket of json.scans.last30d) assert.equal(typeof bucket.count, 'number');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Admin HTML dashboard (content negotiation — Accept: text/html)
// ---------------------------------------------------------------------------
test('admin: Accept: text/html renders the styled dashboard (content-type, markers, real data)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/pricing?utm=x' }, { 'user-agent': UA });
    await track(app.base, { path: '/blog' }, { 'user-agent': UA, 'x-forwarded-for': '203.0.113.7' });
    const seedDb = openDb(dbp);
    seedDb.insertScan({ id: 'scan-1', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: TICK });
    seedDb.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').includes('text/html'), 'content-type is text/html');
    assert.equal(r.headers.get('cache-control'), 'no-store', 'admin page is never cached');
    const html = await r.text();
    for (const marker of [
      'A.S.S. SCORE',
      '— ADMIN',
      'internal',
      'SCANS TOTAL',
      'SCANS TODAY',
      'VIEWS TOTAL',
      'VIEWS TODAY',
      'Last 30 days',
      'Recent views',
      'Internal tool — ass-score.com',
      'Generated',
      'noindex',
    ]) {
      assert.ok(html.includes(marker), `html includes marker: ${marker}`);
    }
    // Real data rendered: today's chart cell (1 scan + 1 view), bar tooltips,
    // and the recent-views table rows.
    assert.ok(html.includes('2026-09-23 — scans 1, views 2'), 'day cell shows the real counts');
    assert.ok(html.includes('2026-09-23 · 1 scans'), 'scan bar tooltip rendered');
    assert.ok(html.includes('2026-09-23 · 2 views'), 'view bar tooltip rendered');
    assert.ok(html.includes('/pricing?utm=x'), 'recent path rendered');
    assert.ok(html.includes('203.0.113.7'), 'second view IP rendered');
    assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'epoch ms rendered as readable local time');
    // every 5th date tick is sparse, not one per day (30 days, 6 ticks)
    assert.equal((html.match(/class="tick"/g) || []).length, 6, '30 days -> 6 sparse ticks (every 5th)');
    // 30 bars per series + 1px hairlines: exactly 30 scan bars and 30 view bars
    assert.equal((html.match(/class="bar bar-scans"/g) || []).length, 30, 'one bar per day per series');
    assert.equal((html.match(/class="bar bar-views"/g) || []).length, 30);
  } finally {
    app.server.close();
  }
});
test('admin: stats JSON gains purchases {total, today, last30d} from the webhook ledger, aligned with scans/views', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    const seedDb = openDb(dbp);
    seedDb.insertScan({ id: 'scan-1', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: TICK });
    // One row per accepted order webhook — status is irrelevant (every row is a
    // purchased full report), and pre-window rows count in total but not in the series.
    seedWebhook(seedDb, 'we-today', '2026-09-23T09:00:00.000Z', 'failed');
    seedWebhook(seedDb, 'we-yesterday', '2026-09-22T11:00:00.000Z');
    seedWebhook(seedDb, 'we-window', '2026-09-10T09:30:00.000Z');
    seedWebhook(seedDb, 'we-old', '2026-08-15T09:00:00.000Z'); // 39 days before today — outside the window
    seedDb.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.deepEqual(Object.keys(json).sort(), ['purchases', 'scans', 'views']);
    assert.equal(json.purchases.total, 4, 'every ledger row counts (any status, any age)');
    assert.equal(json.purchases.today, 1, 'today = created_at UTC-day bucket');
    assert.equal(json.purchases.last30d.length, 30, 'exactly 30 daily buckets');
    assert.equal(json.purchases.last30d[0].date, '2026-08-25', 'window starts 29 days before today');
    assert.equal(json.purchases.last30d[29].date, '2026-09-23', 'window ends today');
    assert.equal(json.purchases.last30d[29].count, 1, 'today bucket includes the failed-status order too');
    assert.equal(json.purchases.last30d[28].count, 1, '2026-09-22 bucket');
    assert.equal(json.purchases.last30d[16].count, 1, '2026-09-10 bucket (inside the window)');
    assert.equal(json.purchases.last30d[0].count, 0, 'pre-window row excluded from the series');
    // Aligned by index with the existing series (oldest-first, same dates).
    for (let i = 0; i < 30; i++) {
      assert.equal(json.purchases.last30d[i].date, json.scans.last30d[i].date, `purchase date ${i} == scan date`);
      assert.equal(json.purchases.last30d[i].date, json.views.last30d[i].date, `purchase date ${i} == view date`);
    }
    // Existing fields untouched.
    assert.equal(json.scans.total, 1);
    assert.equal(json.views.total, 1);
  } finally {
    app.server.close();
  }
});
test('admin: HTML dashboard shows FULL REPORTS PURCHASED / REPORTS TODAY KPIs and the third chart series', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    const seedDb = openDb(dbp);
    seedDb.insertScan({ id: 'scan-1', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: TICK });
    seedWebhook(seedDb, 'we-1', '2026-09-23T08:00:00.000Z');
    seedWebhook(seedDb, 'we-2', '2026-09-23T09:30:00.000Z');
    seedWebhook(seedDb, 'we-3', '2026-09-18T14:00:00.000Z');
    seedDb.close();
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('FULL REPORTS PURCHASED'), 'total KPI label present');
    assert.ok(html.includes('REPORTS TODAY'), 'today KPI label present');
    assert.match(
      html,
      /FULL REPORTS PURCHASED<\/span>\s*<span class="kpi-value" style="color:#f87171">3<\/span>/,
      'total card renders the ledger count in red'
    );
    assert.match(
      html,
      /REPORTS TODAY<\/span>\s*<span class="kpi-value" style="color:#f87171">2<\/span>/,
      'today card renders today count in red'
    );
    assert.ok(html.includes('sw-reports'), 'legend gains the reports swatch');
    assert.ok(html.includes('</span>Reports'), 'legend labels Scans / Views / Reports');
    // Day-cell tooltip now includes the reports count; per-bar tooltips render.
    assert.ok(html.includes('2026-09-23 — scans 1, views 1, reports 2'), 'day cell shows all three counts');
    assert.ok(html.includes('2026-09-23 · 2 reports'), 'today report bar tooltip rendered');
    assert.ok(html.includes('2026-09-18 · 1 reports'), 'older report bar tooltip rendered');
    // Every day gets a reports bar (hairline when zero), like the other series.
    assert.equal((html.match(/class="bar bar-reports"/g) || []).length, 30, 'one reports bar per day');
  } finally {
    app.server.close();
  }
});
test('admin: HTML requests still hit the JSON 403 gate (missing/wrong pw never produce HTML)', async () => {
  const app = startApp({ dbPath: tmpDb(), now: () => TICK });
  try {
    const noPw = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html' } });
    assert.equal(noPw.status, 403);
    assert.deepEqual(await noPw.json(), { error: { code: 'forbidden' } });
    assert.ok(!(noPw.headers.get('content-type') || '').includes('text/html'), '403 is JSON even for HTML accept');
    const wrongPw = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': 'wrong' } });
    assert.equal(wrongPw.status, 403);
    assert.deepEqual(await wrongPw.json(), { error: { code: 'forbidden' } });
    // header AND query auth still both work for the HTML variant
    const goodQuery = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent(PASSWORD)}`, { headers: { accept: 'text/html' } });
    assert.equal(goodQuery.status, 200);
    assert.ok((await goodQuery.text()).includes('A.S.S. SCORE'));
  } finally {
    app.server.close();
  }
});
test('admin: HTML page shows the empty state when no views recorded yet', async () => {
  const app = startApp({ dbPath: tmpDb(), now: () => TICK });
  try {
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /no views recorded yet/i, 'empty-state message present');
    assert.ok(!html.includes('<table>'), 'no table markup when there are no views');
    assert.ok(!html.includes('class="chart"'), 'no chart markup when there are no views');
    // the same app still serves exact JSON to non-HTML consumers
    const j = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(j.status, 200);
    assert.deepEqual(Object.keys(await j.json()).sort(), ['purchases', 'scans', 'views']);
  } finally {
    app.server.close();
  }
});
test('admin: JSON consumers are untouched (Accept: application/json and */* both get JSON)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    await track(app.base, { path: '/' }, { 'user-agent': UA });
    const explicitJson = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'application/json', 'x-admin-password': PASSWORD } });
    assert.equal(explicitJson.status, 200);
    assert.ok((explicitJson.headers.get('content-type') || '').includes('application/json'));
    assert.deepEqual(Object.keys(await explicitJson.json()).sort(), ['purchases', 'scans', 'views'], 'JSON shape unchanged');
    const wildcard = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent(PASSWORD)}`, { headers: { accept: '*/*' } });
    assert.equal(wildcard.status, 200);
    const wildcardText = await wildcard.text();
    const json = JSON.parse(wildcardText);
    assert.equal(json.views.total, 1, '*/* (curl/fetch default) must NOT get HTML');
    assert.ok(!wildcardText.includes('<!doctype html'), '*/* consumer gets JSON, not the dashboard');
  } finally {
    app.server.close();
  }
});
test('admin: HTML escapes every dynamic value (path/UA/IP) — never raw interpolation', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const evilPath = '/"><script>alert(1)</script>';
    const evilUa = 'Evil"><img src=x onerror=alert(2)>'.padEnd(120, 'x');
    await track(app.base, { path: evilPath }, { 'user-agent': evilUa, 'x-forwarded-for': '203.0.113.66' });
    const r = await fetch(`${app.base}/admin/stats`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    const html = await r.text();
    assert.ok(!html.includes('<script>'), 'raw <script> tag never present');
    assert.ok(!html.includes('<img src=x'), 'raw <img> tag from UA never present');
    assert.ok(html.includes('&lt;script&gt;'), 'path <script> is escaped');
    assert.ok(html.includes('&quot;&gt;&lt;img'), 'UA quotes/angle brackets are escaped');
    assert.ok(html.includes('title="Evil&quot;&gt;&lt;img'), 'full UA kept unescaped-free in title attr');
    assert.ok(html.includes('…'), 'long UA is truncated to ~48 chars with an ellipsis');
    assert.ok(html.includes('203.0.113.66'), 'IP still rendered (plain value)');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
test('retention: page_views older than 30 days are purged, fresh kept (runRetention)', () => {
  const db = openDb(tmpDb());
  try {
    const oldTs = Date.parse('2026-07-01T00:00:00.000Z'); // 84 days before TICK
    const freshTs = Date.parse('2026-09-10T00:00:00.000Z'); // 13 days before TICK
    db.insertPageView({ ts: oldTs, ip: '203.0.113.1', ua: UA, path: '/old' });
    db.insertPageView({ ts: freshTs, ip: '203.0.113.1', ua: UA, path: '/fresh' });
    const res = runRetention({ db, now: () => TICK });
    assert.equal(res.deleted.views, 1, 'exactly the old page_view purged');
    const left = db.raw.prepare('SELECT path FROM page_views').all().map((r) => r.path);
    assert.deepEqual(left, ['/fresh']);
  } finally {
    db.close();
  }
});