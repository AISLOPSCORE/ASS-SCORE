import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// ---------------------------------------------------------------------------
// Admin-stats EPOCAH CUTOVER (owner 2026-10-07): POST /admin/stats/reset sets
// stats_epoch (settings table) and EVERY /admin/stats counter filters to rows
// created at/after it. Rows are NEVER deleted — the epoch is a counting floor,
// not a wipe (paid report links point at scans rows). Absent epoch = no
// filtering, byte-identical to before.
// Conventions mirrored from adminStats.test.js: tmp DB per test, injectable
// clocks, real HTTP against a local listen(0). ADMIN_PASSWORD is deleted at
// module top so the "unset => 403" behavior is deterministic.
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD;

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-cutover-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const countRows = (dbPath, table) =>
  new Database(dbPath, { readonly: true }).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
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
// One pre-epoch row in every ledger the admin stats read (view, scan, webhook).
function seedPreEpochRows(dbp, createdAt = TICK) {
  const db = openDb(dbp);
  db.insertPageView({ ts: Date.parse(createdAt), ip: '203.0.113.9', ua: UA, path: '/pre-epoch' });
  db.insertScan({ id: `scan-${createdAt}`, url: 'https://acme.example/', score: 42, breakdown: {}, createdAt });
  seedWebhook(db, `we-${createdAt}`, createdAt);
  db.close();
}

function startApp(opts = {}) {
  const expressApp = createApp({ adminPassword: PASSWORD, ...opts });
  const server = expressApp.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}`, expressApp };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
test('cutover: POST /admin/stats/reset without / with wrong password is 403 JSON and writes NOTHING', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const cases = [
      fetch(`${app.base}/admin/stats/reset`, { method: 'POST' }),
      fetch(`${app.base}/admin/stats/reset`, { method: 'POST', headers: { 'x-admin-password': 'wrong' } }),
      fetch(`${app.base}/admin/stats/reset?pw=${encodeURIComponent('wrong')}`, { method: 'POST' }),
      fetch(`${app.base}/admin/stats/reset`, { method: 'POST', headers: { 'x-admin-password': '' } }),
    ];
    for (const p of cases) {
      const r = await p;
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
      assert.ok(!(r.headers.get('content-type') || '').includes('text/html'), '403 is JSON even for HTML accept');
    }
    const htmlAccept = await fetch(`${app.base}/admin/stats/reset`, {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    assert.equal(htmlAccept.status, 403);
    assert.ok(!(htmlAccept.headers.get('content-type') || '').includes('text/html'), 'HTML accept still gets the JSON 403');
    const db = openDb(dbp);
    assert.equal(db.getSetting('stats_epoch'), null, 'no epoch row written on a failed reset');
    db.close();
    assert.equal(countRows(dbp, 'settings'), 0, 'settings table empty after failed attempts');
    assert.equal(countRows(dbp, 'admin_audit'), 0, 'no audit rows after failed attempts');
  } finally {
    app.server.close();
  }
});

test('cutover: reset with a good password returns {ok, epoch}, writes the setting + a stats_reset audit row', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const r = await fetch(`${app.base}/admin/stats/reset`, {
      method: 'POST',
      headers: { 'x-admin-password': PASSWORD },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, epoch: TICK });
    const db = openDb(dbp);
    assert.equal(db.getSetting('stats_epoch'), TICK);
    const audit = db.raw.prepare("SELECT * FROM admin_audit WHERE verdict = 'stats_reset'").all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, 'admin');
    assert.equal(audit[0].url, '');
    assert.equal(audit[0].score, 0);
    assert.equal(audit[0].created_at, TICK);
    db.close();
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Epoch filtering
// ---------------------------------------------------------------------------
test('cutover: after reset, totals + today + last-30d rows read 0 with pre-epoch rows seeded (rows stay in the DB)', async () => {
  const dbp = tmpDb();
  const resetTime = '2026-09-23T13:00:00.000Z'; // one hour after the seeded rows
  const app = startApp({ dbPath: dbp, now: () => resetTime });
  try {
    seedPreEpochRows(dbp, TICK);
    const before = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal((await before.json()).scans.total, 1, 'pre-condition: rows counted before the cutover');
    const r = await fetch(`${app.base}/admin/stats/reset`, {
      method: 'POST',
      headers: { 'x-admin-password': PASSWORD },
    });
    assert.equal(r.status, 200);
    const g = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(g.status, 200);
    const json = await g.json();
    for (const k of ['views', 'scans', 'purchases']) {
      assert.equal(json[k].total, 0, `${k}.total is zero after cutover`);
      assert.equal(json[k].today, 0, `${k}.today is zero after cutover`);
      assert.ok(json[k].last30d.every((d) => d.count === 0), `${k}.last30d all zero after cutover`);
      assert.equal(json[k].last30d.length, 30, 'still 30 daily buckets');
    }
    assert.equal(json.views.recent.length, 0, 'no recent views after cutover');
    // NO data was deleted — the rows are still there, just not counted.
    assert.equal(countRows(dbp, 'page_views'), 1);
    assert.equal(countRows(dbp, 'scans'), 1);
    assert.equal(countRows(dbp, 'webhook_events'), 1);
  } finally {
    app.server.close();
  }
});

test('cutover: no-epoch DB behaves exactly as before (counts include everything)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    seedPreEpochRows(dbp, TICK);
    const r = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json = await r.json();
    assert.equal(json.views.total, 1, 'views.total includes the historical row');
    assert.equal(json.views.today, 1);
    assert.equal(json.views.last30d[29].count, 1, 'today bucket includes the row');
    assert.equal(json.views.last30d[0].date, '2026-08-25', 'window shape unchanged (29 days before today)');
    assert.equal(json.views.recent.length, 1, 'recent includes the historical view');
    assert.equal(json.scans.total, 1);
    assert.equal(json.scans.today, 1);
    assert.equal(json.purchases.total, 1);
    assert.equal(json.purchases.today, 1);
    assert.equal(app.expressApp.locals.db.getSetting('stats_epoch'), null, 'epoch still unset — no filtering ever applied');
  } finally {
    app.server.close();
  }
});

test('cutover: reset is idempotent — second reset moves the epoch later, old rows stay gone, newer rows count', async () => {
  const dbp = tmpDb();
  let t = TICK;
  const app = startApp({ dbPath: dbp, now: () => t });
  try {
    seedPreEpochRows(dbp, TICK); // 12:00 — before every epoch
    t = '2026-09-23T13:00:00.000Z';
    const first = await fetch(`${app.base}/admin/stats/reset`, {
      method: 'POST',
      headers: { 'x-admin-password': PASSWORD },
    });
    const epoch1 = (await first.json()).epoch;
    // Rows created between the two resets — must ALSO vanish on the second one.
    const mid = openDb(dbp);
    mid.insertPageView({ ts: Date.parse('2026-09-23T13:30:00.000Z'), ip: '203.0.113.9', ua: UA, path: '/mid' });
    mid.insertScan({ id: 'scan-mid', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: '2026-09-23T13:30:00.000Z' });
    seedWebhook(mid, 'we-mid', '2026-09-23T13:30:00.000Z');
    mid.close();
    t = '2026-09-23T14:00:00.000Z';
    const second = await fetch(`${app.base}/admin/stats/reset`, {
      method: 'POST',
      headers: { 'x-admin-password': PASSWORD },
    });
    const epoch2 = (await second.json()).epoch;
    assert.notEqual(epoch2, epoch1, 'a second reset moves the epoch later');
    assert.equal(app.expressApp.locals.db.getSetting('stats_epoch'), epoch2, 'settings row holds the newest epoch');
    // Both the pre-epoch AND the between-epochs rows are gone from every counter.
    const g = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json = await g.json();
    for (const k of ['views', 'scans', 'purchases']) {
      assert.equal(json[k].total, 0, `${k}.total excludes every pre-epoch2 row`);
      assert.equal(json[k].today, 0, `${k}.today excludes every pre-epoch2 row`);
      assert.ok(json[k].last30d.every((d) => d.count === 0), `${k}.last30d flat`);
    }
    assert.equal(json.views.recent.length, 0);
    // Rows after the second epoch DO count —
    const post = openDb(dbp);
    post.insertPageView({ ts: Date.parse('2026-09-23T14:30:00.000Z'), ip: '203.0.113.9', ua: UA, path: '/post' });
    post.insertScan({ id: 'scan-post', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: '2026-09-23T14:30:00.000Z' });
    seedWebhook(post, 'we-post', '2026-09-23T14:30:00.000Z');
    post.close();
    const g2 = await fetch(`${app.base}/admin/stats`, { headers: { 'x-admin-password': PASSWORD } });
    const json2 = await g2.json();
    assert.equal(json2.views.total, 1);
    assert.equal(json2.views.today, 1);
    assert.equal(json2.views.recent.length, 1);
    assert.equal(json2.views.recent[0].path, '/post');
    assert.equal(json2.scans.total, 1);
    assert.equal(json2.purchases.total, 1);
    // And NOTHING was ever deleted — every seeded row is still on disk.
    assert.equal(countRows(dbp, 'page_views'), 3);
    assert.equal(countRows(dbp, 'scans'), 3);
    assert.equal(countRows(dbp, 'webhook_events'), 3);
    // One audit row per reset — an audit trail that survives forever.
    const auditCount = app.expressApp.locals.db.raw
      .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE verdict = 'stats_reset'")
      .get().n;
    assert.equal(auditCount, 2, 'two stats-reset audit rows');
  } finally {
    app.server.close();
  }
});

test('cutover: reset with text/html accept renders the confirmation page; back-link carries ?pw=', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => TICK });
  try {
    const r = await fetch(`${app.base}/admin/stats/reset?pw=${encodeURIComponent(PASSWORD)}`, {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    assert.equal(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    for (const marker of [
      'Tracking reset',
      'All admin-stats counters now start at this moment',
      'Tracking since',
      '2026-09-23 12:00',
      'UTC',
      'Back to admin stats',
      '/admin/stats?pw=',
    ]) {
      assert.ok(html.includes(marker), `confirmation includes: ${marker}`);
    }
    assert.ok(html.includes(`/admin/stats?pw=${encodeURIComponent(PASSWORD)}`), 'back-link embeds the pw');
  } finally {
    app.server.close();
  }
});

test('cutover: dashboard header shows Tracking since + reset button after cutover; all-time state before', async () => {
  const dbp = tmpDb();
  let t = TICK;
  const app = startApp({ dbPath: dbp, now: () => t });
  try {
    const before = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent(PASSWORD)}`, { headers: { accept: 'text/html' } });
    const beforeHtml = await before.text();
    assert.ok(beforeHtml.includes('Tracking: all time — no cutover yet'), 'pre-cutover state is visible');
    assert.ok(!beforeHtml.includes('Tracking since'), 'no Tracking since line before the cutover');
    assert.ok(beforeHtml.includes('Restart stats tracking'), 'reset button always present');
    assert.ok(beforeHtml.includes('action="/admin/stats/reset?pw='), 'button POSTs to the reset endpoint with the pw');
    // Header auth (no ?pw=): the button renders without pw plus a note.
    const headerOnly = await fetch(`${app.base}/admin/stats`, {
      headers: { accept: 'text/html', 'x-admin-password': PASSWORD },
    });
    const headerHtml = await headerOnly.text();
    assert.ok(headerHtml.includes('action="/admin/stats/reset"'), 'no pw embedded for header-auth');
    assert.ok(headerHtml.includes('Opened with header auth'), 'note explains how to make the button work');
    // After the cutover the line flips to "Tracking since <epoch>".
    t = '2026-09-23T16:00:00.000Z';
    await fetch(`${app.base}/admin/stats/reset`, { method: 'POST', headers: { 'x-admin-password': PASSWORD } });
    const after = await fetch(`${app.base}/admin/stats?pw=${encodeURIComponent(PASSWORD)}`, { headers: { accept: 'text/html' } });
    const afterHtml = await after.text();
    assert.ok(afterHtml.includes('Tracking since 2026-09-23 16:00 UTC'), 'epoch line after the cutover');
    assert.ok(!afterHtml.includes('Tracking: all time'), 'all-time state gone after the cutover');
  } finally {
    app.server.close();
  }
});