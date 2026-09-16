import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite persistence for scans.
 * Table: scans(id TEXT PRIMARY KEY, url TEXT, score INTEGER, breakdown TEXT/JSON,
 * created_at TEXT, partial INTEGER, note TEXT, worst_page TEXT/JSON,
 * business_name TEXT).
 * The phase-2 columns (partial/note/worst_page), plus branding/roast/business_name,
 * are added with an ALTER TABLE migration on open, so databases created by the
 * v1 schema keep working. The DB file lives under data/ (gitignored); the
 * directory is created on open.
 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id         TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      score      INTEGER NOT NULL,
      breakdown  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Migration for phase-2 fields + branding + roast (additive; idempotent).
  const cols = db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
  if (!cols.includes('partial')) db.exec('ALTER TABLE scans ADD COLUMN partial INTEGER');
  if (!cols.includes('note')) db.exec('ALTER TABLE scans ADD COLUMN note TEXT');
  if (!cols.includes('worst_page')) db.exec('ALTER TABLE scans ADD COLUMN worst_page TEXT');
  if (!cols.includes('branding')) db.exec('ALTER TABLE scans ADD COLUMN branding TEXT');
  // Slop Roast: the personality line. Nullable — rows written before this
  // column existed load with roast null, and the read path derives the roast
  // deterministically from the stored id + breakdown (see routes/scans.js).
  if (!cols.includes('roast')) db.exec('ALTER TABLE scans ADD COLUMN roast TEXT');
  // Spec parity: optional businessName on POST /api/v1/scan. Nullable — rows
  // written before this column existed load with business_name null, and the
  // free/paid surfaces never render it (storage only, like the webhook ledger).
  if (!cols.includes('business_name')) db.exec('ALTER TABLE scans ADD COLUMN business_name TEXT');

  const insertStmt = db.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at, partial, note, worst_page, branding, roast, business_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const getStmt = db.prepare(
    'SELECT id, url, score, breakdown, created_at, partial, note, worst_page, branding, roast, business_name FROM scans WHERE id = ?'
  );

  // Webhook fulfillment ledger (order webhooks -> scans).
  // One row per accepted order webhook event:
  //   event_key    – idempotency key: "<provider>:<provider event id>"
  //                  (providers without an event id get a random key — kept so
  //                  per-IP daily rate counting stays one-query).
  //   provider     – 'fiverr' | 'stripe' | 'lemonsqueezy'
  //   event_id     – the provider's event/order id (null when absent)
  //   ip, day      – rate-limit bucket: per-IP per-UTC-day event count
  //   scan_id      – the scan row created for this order (filled on completion)
  //   status       – 'pending' | 'completed' | 'failed'
  //   business_name– extracted order brand (nullable)
  //   payload      – the raw webhook body, for debugging/reconciliation
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_key     TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      event_id      TEXT,
      ip            TEXT NOT NULL,
      day           TEXT NOT NULL,
      scan_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      business_name TEXT,
      payload       TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_day_ip ON webhook_events (day, ip);
  `);

  // Scan rate-limit ledger (accepted POST /api/v1/scan requests).
  // One row per ACCEPTED scan (URL passed the SSRF guard + shape validation,
  // scan was actually run). Kept in its own table — deliberately NOT the
  // webhook_events table — so the scan and webhook daily caps share no counts:
  //   event_key – randomUUID (fresh key per accepted request)
  //   ip, day   – rate-limit bucket: per-IP per-UTC-day accepted-scan count
  //   scan_id   – the scan row created for this request (filled on completion)
  //   status    – 'accepted' | 'completed' | 'failed'
  //   created_at– ledger timestamp (from the route's injectable clock)
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_events (
      event_key  TEXT PRIMARY KEY,
      ip         TEXT NOT NULL,
      day        TEXT NOT NULL,
      scan_id    TEXT,
      status     TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_events_day_ip ON scan_events (day, ip);
  `);

  const insertScanEventStmt = db.prepare(
    'INSERT OR IGNORE INTO scan_events (event_key, ip, day, scan_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const markScanEventStmt = db.prepare('UPDATE scan_events SET status = ?, scan_id = ? WHERE event_key = ?');
  const countScanEventsStmt = db.prepare('SELECT COUNT(*) AS n FROM scan_events WHERE day = ? AND ip = ?');

  const insertWebhookEventStmt = db.prepare(
    'INSERT OR IGNORE INTO webhook_events (event_key, provider, event_id, ip, day, scan_id, status, business_name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const getWebhookEventStmt = db.prepare('SELECT * FROM webhook_events WHERE event_key = ?');
  const markWebhookEventStmt = db.prepare('UPDATE webhook_events SET status = ?, scan_id = ? WHERE event_key = ?');
  const countWebhookEventsStmt = db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE day = ? AND ip = ?');

  return {
    /**
     * @param {{ id: string, url: string, score: number, breakdown: object,
     *           createdAt: string, partial?: boolean, note?: string,
     *           worstPage?: object, branding?: object, roast?: string,
     *           businessName?: string }} scan
     */
    insertScan(scan) {
      insertStmt.run(
        scan.id,
        scan.url,
        scan.score,
        JSON.stringify(scan.breakdown),
        scan.createdAt,
        scan.partial === undefined ? null : scan.partial ? 1 : 0,
        scan.note ?? null,
        scan.worstPage === undefined ? null : JSON.stringify(scan.worstPage),
        scan.branding === undefined || scan.branding === null ? null : JSON.stringify(scan.branding),
        scan.roast ?? null,
        scan.businessName ?? null,
      );
    },
    /** @returns {null | { id, url, score, breakdown, created_at, partial, note, worstPage, branding, roast, businessName }} */
    getScan(id) {
      const row = getStmt.get(id);
      if (!row) return null;
      return {
        ...row,
        breakdown: JSON.parse(row.breakdown),
        partial: row.partial === null ? undefined : Boolean(row.partial),
        worstPage: row.worst_page ? JSON.parse(row.worst_page) : undefined,
        branding: row.branding ? JSON.parse(row.branding) : undefined,
        roast: row.roast ?? undefined,
        businessName: row.business_name ?? undefined,
      };
    },

    // --- Webhook fulfillment ledger -------------------------------------------
    /**
     * Record an accepted order webhook event (idempotency + rate-limit ledger).
     * @returns {boolean} true if a new row was inserted; false when the
     *   event_key already exists (caller then treats it as already processed).
     */
    insertWebhookEvent({ eventKey, provider, eventId, ip, day, business_name: businessName, payload, createdAt, status = 'pending' }) {
      const info = insertWebhookEventStmt.run(
        eventKey,
        provider,
        eventId ?? null,
        ip,
        day,
        null, // scan_id — filled when the scan completes
        status,
        businessName ?? null,
        JSON.stringify(payload),
        createdAt,
      );
      return info.changes > 0;
    },
    /** @returns {null | { event_key, provider, event_id, ip, day, scan_id, status, business_name, payload, created_at }} */
    getWebhookEvent(eventKey) {
      const row = getWebhookEventStmt.get(eventKey);
      if (!row) return null;
      return { ...row, payload: JSON.parse(row.payload) };
    },
    markWebhookEvent(eventKey, { status, scanId }) {
      markWebhookEventStmt.run(status, scanId ?? null, eventKey);
    },
    /** Accepted webhook-event count for a (UTC day, IP) bucket — the per-IP daily cap. */
    countWebhookEvents(day, ip) {
      return countWebhookEventsStmt.get(day, ip)?.n ?? 0;
    },

    // --- Scan rate-limit ledger (independent of the webhook ledger) ----------
    /**
     * Record an accepted POST /api/v1/scan request (rate-limit ledger).
     * Called AFTER the SSRF guard + shape validations and BEFORE runScan, with
     * no await between the count check and this insert (single-process
     * synchronous = race-free, same as the webhook ledger).
     * @returns {boolean} true when a new row was inserted (always true here:
     *   the event key is a fresh randomUUID per accepted request).
     */
    insertScanEvent({ eventKey, ip, day, scanId = null, status = 'accepted', createdAt }) {
      const info = insertScanEventStmt.run(eventKey, ip, day, scanId, status, createdAt);
      return info.changes > 0;
    },
    /** Accepted-scan count for a (UTC day, IP) bucket — the per-IP daily cap. */
    countScanEvents(day, ip) {
      return countScanEventsStmt.get(day, ip)?.n ?? 0;
    },
    /** Update the ledger row once the scan completes ('completed' w/ scan id) or fails ('failed'). */
    markScanEvent(eventKey, { status, scanId = null }) {
      markScanEventStmt.run(status, scanId, eventKey);
    },
    close() {
      db.close();
    },
  };
}