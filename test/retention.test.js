import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runRetention } from '../src/retention.js';
import { createApp } from '../src/app.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-ret-')), 'test.db');

// Injected clock — deterministic, no real sleeps (repo convention).
const NOW = '2026-09-23T12:00:00.000Z';
// 84 days before NOW -> well past the 30-day window -> must be deleted.
const OLD = '2026-07-01T00:00:00.000Z';
// 13 days before NOW -> inside the window -> must survive.
const FRESH = '2026-09-10T00:00:00.000Z';
// NOW minus exactly 30 days — the cutoff itself (survives: strictly older
// than 30 days is what gets purged).
const CUTOFF = '2026-08-24T12:00:00.000Z';

const COUNTS = {
  scans: (db) => db.raw.prepare('SELECT COUNT(*) AS n FROM scans').get().n,
  scanEvents: (db) => db.raw.prepare('SELECT COUNT(*) AS n FROM scan_events').get().n,
  webhookEvents: (db) => db.raw.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n,
};

const hasScan = (db, id) => db.getScan(id) !== null;
const hasScanEvent = (db, key) => db.raw.prepare('SELECT 1 FROM scan_events WHERE event_key = ?').get(key) !== undefined;
const hasWebhookEvent = (db, key) => db.raw.prepare('SELECT 1 FROM webhook_events WHERE event_key = ?').get(key) !== undefined;

/** One old + one fresh row in each of the three tables. */
function seedAllThree(db) {
  db.insertScan({ id: 'scan-old', url: 'https://old.example/', score: 72, breakdown: {}, createdAt: OLD });
  db.insertScan({ id: 'scan-fresh', url: 'https://fresh.example/', score: 11, breakdown: {}, createdAt: FRESH });
  db.insertScanEvent({ eventKey: 'se-old', ip: '203.0.113.1', day: '2026-07-01', createdAt: OLD });
  db.insertScanEvent({ eventKey: 'se-fresh', ip: '203.0.113.1', day: '2026-09-10', createdAt: FRESH });
  db.insertWebhookEvent({ eventKey: 'we-old', provider: 'stripe', eventId: 'evt_old', ip: '203.0.113.2', day: '2026-07-01', payload: { id: 'evt_old' }, createdAt: OLD });
  db.insertWebhookEvent({ eventKey: 'we-fresh', provider: 'stripe', eventId: 'evt_fresh', ip: '203.0.113.2', day: '2026-09-10', payload: { id: 'evt_fresh' }, createdAt: FRESH });
}

test('retention: old scan row deleted, fresh scan row kept', () => {
  const db = openDb(tmpDb());
  try {
    db.insertScan({ id: 'scan-old', url: 'https://old.example/', score: 72, breakdown: {}, createdAt: OLD });
    db.insertScan({ id: 'scan-fresh', url: 'https://fresh.example/', score: 11, breakdown: {}, createdAt: FRESH });

    const res = runRetention({ db, now: () => NOW });

    assert.equal(res.cutoffIso, CUTOFF, 'cutoff is now minus exactly 30 days');
    assert.deepEqual(res.deleted, { scans: 1, scanEvents: 0, webhookEvents: 0, views: 0 });
    assert.equal(COUNTS.scans(db), 1);
    assert.ok(!hasScan(db, 'scan-old'), 'old scan purged');
    assert.ok(hasScan(db, 'scan-fresh'), 'fresh scan survives');
  } finally {
    db.close();
  }
});

test('retention: old scan_events row deleted, fresh kept', () => {
  const db = openDb(tmpDb());
  try {
    db.insertScanEvent({ eventKey: 'se-old', ip: '203.0.113.1', day: '2026-07-01', createdAt: OLD });
    db.insertScanEvent({ eventKey: 'se-fresh', ip: '203.0.113.1', day: '2026-09-10', createdAt: FRESH });

    const res = runRetention({ db, now: () => NOW });

    assert.deepEqual(res.deleted, { scans: 0, scanEvents: 1, webhookEvents: 0, views: 0 });
    assert.equal(COUNTS.scanEvents(db), 1);
    assert.ok(!hasScanEvent(db, 'se-old'), 'old scan_events row purged');
    assert.ok(hasScanEvent(db, 'se-fresh'), 'fresh scan_events row survives');
  } finally {
    db.close();
  }
});

test('retention: old webhook_events row deleted, fresh kept', () => {
  const db = openDb(tmpDb());
  try {
    db.insertWebhookEvent({ eventKey: 'we-old', provider: 'stripe', eventId: 'evt_old', ip: '203.0.113.2', day: '2026-07-01', payload: { id: 'evt_old' }, createdAt: OLD });
    db.insertWebhookEvent({ eventKey: 'we-fresh', provider: 'stripe', eventId: 'evt_fresh', ip: '203.0.113.2', day: '2026-09-10', payload: { id: 'evt_fresh' }, createdAt: FRESH });

    const res = runRetention({ db, now: () => NOW });

    assert.deepEqual(res.deleted, { scans: 0, scanEvents: 0, webhookEvents: 1, views: 0 });
    assert.equal(COUNTS.webhookEvents(db), 1);
    assert.ok(!hasWebhookEvent(db, 'we-old'), 'old webhook_events row purged');
    assert.ok(hasWebhookEvent(db, 'we-fresh'), 'fresh webhook_events row survives');
  } finally {
    db.close();
  }
});

test('retention: only rows past the cutoff are touched — fresh rows in every table survive', () => {
  const db = openDb(tmpDb());
  try {
    seedAllThree(db);

    const res = runRetention({ db, now: () => NOW });

    assert.deepEqual(res.deleted, { scans: 1, scanEvents: 1, webhookEvents: 1, views: 0 }, 'exactly the 3 old rows deleted, nothing else');
    assert.equal(COUNTS.scans(db), 1);
    assert.equal(COUNTS.scanEvents(db), 1);
    assert.equal(COUNTS.webhookEvents(db), 1);
    assert.ok(hasScan(db, 'scan-fresh'));
    assert.ok(hasScanEvent(db, 'se-fresh'));
    assert.ok(hasWebhookEvent(db, 'we-fresh'));
  } finally {
    db.close();
  }
});

test('retention: boundary — row created exactly at the cutoff survives (strictly older is purged)', () => {
  const db = openDb(tmpDb());
  try {
    db.insertScan({ id: 'at-cutoff', url: 'https://edge.example/', score: 40, breakdown: {}, createdAt: CUTOFF });
    db.insertScan({ id: 'just-older', url: 'https://older.example/', score: 60, breakdown: {}, createdAt: '2026-08-24T11:59:59.999Z' });

    const res = runRetention({ db, now: () => NOW });

    assert.equal(res.deleted.scans, 1, 'only the strictly-older row is purged');
    assert.ok(hasScan(db, 'at-cutoff'), 'row at exactly the cutoff is NOT yet older than 30 days');
    assert.ok(!hasScan(db, 'just-older'));
  } finally {
    db.close();
  }
});

test('retention: a second run is harmless (idempotent)', () => {
  const db = openDb(tmpDb());
  try {
    seedAllThree(db);

    const first = runRetention({ db, now: () => NOW });
    const second = runRetention({ db, now: () => NOW });

    assert.deepEqual(first.deleted, { scans: 1, scanEvents: 1, webhookEvents: 1, views: 0 });
    assert.deepEqual(second.deleted, { scans: 0, scanEvents: 0, webhookEvents: 0, views: 0 }, 'second run deletes nothing');
    // Nothing new was touched: exactly the fresh rows remain after run 2.
    assert.equal(COUNTS.scans(db), 1);
    assert.equal(COUNTS.scanEvents(db), 1);
    assert.equal(COUNTS.webhookEvents(db), 1);
    assert.ok(hasScan(db, 'scan-fresh'));
    assert.ok(hasScanEvent(db, 'se-fresh'));
    assert.ok(hasWebhookEvent(db, 'we-fresh'));
  } finally {
    db.close();
  }
});

test('retention: a FULLY PAID scan (order status=fulfilled) is exempt from the 30-day purge — the row survives', () => {
  const db = openDb(tmpDb());
  try {
    db.insertScan({ id: 'scan-paid', url: 'https://paid.example/', score: 72, breakdown: {}, createdAt: OLD });
    db.insertOrder({ id: 'order-paid', scanId: 'scan-paid', email: 'buyer@example.com', createdAt: OLD });
    db.markOrderFulfilled('order-paid', { checkoutSessionId: 'cs_test_1', paidAt: OLD });

    const res = runRetention({ db, now: () => NOW });

    assert.deepEqual(res.deleted, { scans: 0, scanEvents: 0, webhookEvents: 0, views: 0 }, 'the fulfilled paid scan is NOT purged');
    assert.ok(hasScan(db, 'scan-paid'), 'fulfilled paid scan survives the 30-day purge');
    // Deterministic/idempotent: a second run still keeps it (no accidental
    // state flip in the exemption query).
    const second = runRetention({ db, now: () => NOW });
    assert.deepEqual(second.deleted, { scans: 0, scanEvents: 0, webhookEvents: 0, views: 0 });
    assert.ok(hasScan(db, 'scan-paid'));
  } finally {
    db.close();
  }
});

test('retention: pending-order and order-less scans still purge at 31 days — only status=fulfilled is exempt', () => {
  const db = openDb(tmpDb());
  try {
    // Pending-order scan (bought but never completed): still purged.
    db.insertScan({ id: 'scan-pending', url: 'https://pending.example/', score: 60, breakdown: {}, createdAt: OLD });
    db.insertOrder({ id: 'order-pending', scanId: 'scan-pending', email: 'buyer@example.com', createdAt: OLD });
    // Order-less scan (plain free scan): still purged.
    db.insertScan({ id: 'scan-orderless', url: 'https://orderless.example/', score: 50, breakdown: {}, createdAt: OLD });

    const res = runRetention({ db, now: () => NOW });

    assert.deepEqual(res.deleted, { scans: 2, scanEvents: 0, webhookEvents: 0, views: 0 }, 'both non-fulfilled scans purged');
    assert.ok(!hasScan(db, 'scan-pending'), 'pending-order scan still purged at 31d');
    assert.ok(!hasScan(db, 'scan-orderless'), 'order-less scan still purged at 31d');
  } finally {
    db.close();
  }
});

test('retention: app wiring — runRetentionOnBoot sweeps at app creation, default off leaves fixtures alone', () => {
  // Fixture db with an old + a fresh scan row.
  const dbPath = tmpDb();
  const db = openDb(dbPath);
  db.insertScan({ id: 'boot-old', url: 'https://boot-old.example/', score: 55, breakdown: {}, createdAt: OLD });
  db.insertScan({ id: 'boot-fresh', url: 'https://boot-fresh.example/', score: 10, breakdown: {}, createdAt: FRESH });
  db.close();

  // Default (tests' path): creating the app must NOT delete the old fixture row.
  const app1 = createApp({ dbPath, now: () => NOW });
  try {
    const db1 = openDb(dbPath);
    assert.ok(hasScan(db1, 'boot-old'), 'default createApp() does not run a destructive sweep');
    assert.ok(hasScan(db1, 'boot-fresh'));
    db1.close();
  } finally {
    app1.locals.db.close();
  }

  // Boot path (server.js): the sweep runs at app creation and deletes the old row.
  const app2 = createApp({ dbPath, now: () => NOW, runRetentionOnBoot: true });
  try {
    assert.ok(app2.locals.retentionTimer, 'interval handle exposed for teardown');
    assert.ok(!hasScan(app2.locals.db, 'boot-old'), 'boot sweep purged the old row');
    assert.ok(hasScan(app2.locals.db, 'boot-fresh'), 'boot sweep kept the fresh row');
  } finally {
    if (app2.locals.retentionTimer) clearInterval(app2.locals.retentionTimer);
    app2.locals.db.close();
  }
});