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
  // Admin-generated scans (the /admin/share-card tool, owner 2026-10-01): the
  // row is marked internal so every PUBLIC read surface and the admin-stats
  // counts exclude it — admin tool runs must never pollute public metrics.
  // NOT NULL DEFAULT 0 backfills existing rows to 0 (= public), so pre-migration
  // rows behave byte-identically to today with no data fix-up.
  if (!cols.includes('internal')) db.exec('ALTER TABLE scans ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  // Crawl-depth disclosure (owner 10-05): how many pages were actually
  // evaluated (crawl_fetched) vs how many the site exposed via sitemap/links
  // before the 5-page cap (crawl_discovered = 1 + totalDiscovered). Nullable —
  // rows written before this feature render NO scope line anywhere. The ALTER
  // is guarded + additive exactly like every other phase column: existing
  // production rows and the WAL stay intact, no table rebuild.
  if (!cols.includes('crawl_fetched')) db.exec('ALTER TABLE scans ADD COLUMN crawl_fetched INTEGER');
  if (!cols.includes('crawl_discovered')) db.exec('ALTER TABLE scans ADD COLUMN crawl_discovered INTEGER');

  const insertStmt = db.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at, partial, note, worst_page, branding, roast, business_name, internal, crawl_fetched, crawl_discovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const getStmt = db.prepare(
    'SELECT id, url, score, breakdown, created_at, partial, note, worst_page, branding, roast, business_name, internal, crawl_fetched, crawl_discovered FROM scans WHERE id = ?'
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
  // Homepage view tracking (admin stats) — one row per accepted beacon hit
  // (bots / empty-UA / per-IP 30s dedup are filtered by the route BEFORE the
  // insert). ts is epoch milliseconds (the site beacon's timestamp); day
  // bucketing happens in the admin route via SQLite's
  // datetime(ts/1000, 'unixepoch') — the same UTC convention the scan and
  // webhook ledgers use (created_at ISO strings, day = first 10 chars).
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_views (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts   INTEGER NOT NULL,
      ip   TEXT NOT NULL,
      ua   TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_views_ts ON page_views (ts);
  `);

  // Paid-report orders — the 'collect email before checkout' fulfillment flow
  // (built 2026-09-25). One row per POST /api/v1/order-intent: the site hands
  // the buyer's email + scan id BEFORE redirecting to the Stripe payment link,
  // Stripe echoes the order id back as checkout session client_reference_id,
  // and the webhook correlates the completed session back to this row.
  //   id                  – orderId (uuid, generated at order-intent time)
  //   scan_id             – the scan the buyer is purchasing the report for
  //   email               – normalized (lowercased/trimmed) report recipient
  //   status              – 'pending' | 'fulfilled'
  //   checkout_session_id – Stripe session id that completed this order
  //   paid_at             – ISO timestamp of the checkout.session.completed
  //                         event that fulfilled the order
  //   created_at          – ISO timestamp of the order-intent request
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      scan_id             TEXT NOT NULL,
      email               TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      checkout_session_id TEXT,
      paid_at             TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_email_status ON orders (email, status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
  `);

  // Bare-link purchases — checkout.session.completed events that matched NO
  // pending order (someone bought via the static payment link, like the owner
  // did 2026-09-24, so there is no scan id to tie them to). Support fulfills
  // these manually via POST /admin/deliver once the customer names their site.
  //   session_id  – Stripe checkout session id (PRIMARY KEY: a Stripe retry
  //                 replays the same event, and INSERT OR IGNORE keeps one row)
  //   email       – customer email from the session (nullable)
  //   received_at – ISO timestamp of the first event received
  db.exec(`
    CREATE TABLE IF NOT EXISTS unmatched_orders (
      session_id  TEXT PRIMARY KEY,
      email       TEXT,
      received_at TEXT NOT NULL
    );
  `);

  // Admin share-card tool audit trail (owner 2026-10-01): one row per
  // /admin/share-card scan — who (always 'admin' — the tool has no per-user
  // identity), when, what URL, resulting score + verdict. Retention NEVER
  // purges this table (the scan row itself still purges at 30 days like every
  // other scan; the audit row survives so the trail outlives the data). The
  // same table also records /admin/stats/reset actions (verdict =
  // 'stats_reset', empty url, score 0) — a cutover audit trail that also
  // survives forever.
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id         TEXT PRIMARY KEY,
      scan_id    TEXT,
      actor      TEXT NOT NULL,
      ip         TEXT,
      url        TEXT NOT NULL,
      score      INTEGER NOT NULL,
      verdict    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Admin-stats EPOCAH CUTOVER (owner 2026-10-07): tiny key-value store. The
  // only key today is `stats_epoch` — the ISO moment the owner restarted
  // customer-acquisition tracking from zero. When set, EVERY admin-stats
  // counter filters to rows at/after it; when absent (fresh/dev DBs, or prod
  // before the cutover runs) the counters behave exactly as before. Rows are
  // NEVER deleted — the epoch is a counting floor, not a wipe.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertScanEventStmt = db.prepare(
    'INSERT OR IGNORE INTO scan_events (event_key, ip, day, scan_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const markScanEventStmt = db.prepare('UPDATE scan_events SET status = ?, scan_id = ? WHERE event_key = ?');
  // D1/D2 gate rejection rollback: removes the accepted-scan ledger row so the
  // per-IP daily count is exactly as if the request never ran (gate rejections
  // consume ZERO quota — owner-approved D1/D2 quota rollback).
  const voidScanEventStmt = db.prepare('DELETE FROM scan_events WHERE event_key = ?');
  const countScanEventsStmt = db.prepare('SELECT COUNT(*) AS n FROM scan_events WHERE day = ? AND ip = ?');
  // Page-view + admin-stats queries (homepage view tracking). Every aggregate
  // gains an OPTIONAL epoch floor (the admin-stats cutover): `sinceTs`/`sinceIso`
  // params — null/absent = no filter (fresh/dev DBs, pre-cutover), exactly the
  // old behavior. The paired statements exist because better-sqlite3 prepared
  // statements are static — the method picks the filtered one when a floor is
  // given and never builds SQL strings.
  const insertPageViewStmt = db.prepare('INSERT INTO page_views (ts, ip, ua, path) VALUES (?, ?, ?, ?)');
  const countPageViewsStmt = db.prepare('SELECT COUNT(*) AS n FROM page_views');
  const countPageViewsSinceStmt = db.prepare('SELECT COUNT(*) AS n FROM page_views WHERE ts >= ?');
  const pageViewDayCountsStmt = db.prepare(
    "SELECT substr(datetime(ts / 1000, 'unixepoch'), 1, 10) AS day, COUNT(*) AS n FROM page_views WHERE ts >= ? GROUP BY day"
  );
  const recentPageViewsStmt = db.prepare('SELECT ts, ip, ua, path FROM page_views ORDER BY ts DESC LIMIT 50');
  const recentPageViewsSinceStmt = db.prepare(
    'SELECT ts, ip, ua, path FROM page_views WHERE ts >= ? ORDER BY ts DESC LIMIT 50'
  );
  // Scan-count queries for admin stats EXCLUDE internal rows (admin-generated
  // scans must never move the public-facing counters — owner 2026-10-01).
  const countScansTotalStmt = db.prepare('SELECT COUNT(*) AS n FROM scans WHERE COALESCE(internal,0) = 0');
  const countScansTotalSinceStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM scans WHERE COALESCE(internal,0) = 0 AND created_at >= ?'
  );
  const countScansTodayStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM scans WHERE COALESCE(internal,0) = 0 AND substr(created_at, 1, 10) = ?'
  );
  const countScansTodaySinceStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM scans WHERE COALESCE(internal,0) = 0 AND substr(created_at, 1, 10) = ? AND created_at >= ?'
  );
  const scanDayCountsStmt = db.prepare(
    'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM scans WHERE COALESCE(internal,0) = 0 AND created_at >= ? GROUP BY day'
  );

  const insertWebhookEventStmt = db.prepare(
    'INSERT OR IGNORE INTO webhook_events (event_key, provider, event_id, ip, day, scan_id, status, business_name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const getWebhookEventStmt = db.prepare('SELECT * FROM webhook_events WHERE event_key = ?');
  const markWebhookEventStmt = db.prepare('UPDATE webhook_events SET status = ?, scan_id = ? WHERE event_key = ?');
  const countWebhookEventsStmt = db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE day = ? AND ip = ?');
  // Admin-stats aggregates (one webhook_events row = one purchased full report).
  // Same UTC-day convention as scans: created_at is ISO, day = first 10 chars.
  const countWebhooksTotalStmt = db.prepare('SELECT COUNT(*) AS n FROM webhook_events');
  const countWebhooksTotalSinceStmt = db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE created_at >= ?');
  const countWebhooksTodayStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM webhook_events WHERE substr(created_at, 1, 10) = ?'
  );
  const countWebhooksTodaySinceStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM webhook_events WHERE substr(created_at, 1, 10) = ? AND created_at >= ?'
  );
  const webhookDayCountsStmt = db.prepare(
    'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM webhook_events WHERE created_at >= ? GROUP BY day'
  );
  // Settings key-value store — the stats_epoch cutover marker (see migration
  // above). getSetting returns null for a missing key; setSetting upserts.
  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSettingStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  // Order-fulfillment statements (orders + unmatched_orders ledgers).
  const insertOrderStmt = db.prepare(
    'INSERT OR IGNORE INTO orders (id, scan_id, email, status, checkout_session_id, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const getOrderStmt = db.prepare('SELECT * FROM orders WHERE id = ?');
  const findPendingOrderByEmailStmt = db.prepare(
    "SELECT * FROM orders WHERE email = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 1"
  );
  const fulfillOrderStmt = db.prepare(
    "UPDATE orders SET status = 'fulfilled', checkout_session_id = ?, paid_at = ? WHERE id = ? AND status = 'pending'"
  );
  const insertUnmatchedOrderStmt = db.prepare(
    'INSERT OR IGNORE INTO unmatched_orders (session_id, email, received_at) VALUES (?, ?, ?)'
  );
  const insertAdminAuditStmt = db.prepare(
    'INSERT INTO admin_audit (id, scan_id, actor, ip, url, score, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  return {
    // Raw better-sqlite3 Database — used by the retention job (src/retention.js)
    // and by tests that need direct queries. Additive; the wrapper methods are
    // still the supported surface.
    raw: db,
    /**
     * @param {{ id: string, url: string, score: number, breakdown: object,
     *           createdAt: string, partial?: boolean, note?: string,
     *           worstPage?: object, branding?: object, roast?: string,
     *           businessName?: string, internal?: boolean,
     *           crawlFetched?: number, crawlDiscovered?: number }} scan
     *   `internal` marks an admin-generated row (the /admin/share-card tool):
     *   1 = excluded from every public read surface and the admin-stats counts.
     *   Default 0 (public) keeps the public scan path byte-identical.
     *   `crawlFetched`/`crawlDiscovered` are the crawl-depth disclosure counts
     *   (nullable ints — omitted/undefined for old-style rows).
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
        scan.internal === true ? 1 : 0,
        // Crawl-depth disclosure (nullable — old rows render without a line).
        scan.crawlFetched === undefined || scan.crawlFetched === null ? null : Number(scan.crawlFetched),
        scan.crawlDiscovered === undefined || scan.crawlDiscovered === null ? null : Number(scan.crawlDiscovered),
      );
    },
    /** @returns {null | { id, url, score, breakdown, created_at, partial, note, worstPage, branding, roast, businessName, internal, crawlFetched, crawlDiscovered }} */
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
        // Rows written before the migration backfill to 0 (public).
        internal: Boolean(row.internal),
        // Crawl-depth disclosure: null (old rows) -> undefined, so every read
        // surface skips the scope line/field for scans without the data.
        crawlFetched: row.crawl_fetched ?? undefined,
        crawlDiscovered: row.crawl_discovered ?? undefined,
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
    /** Total webhook-event rows (all time) — one row per purchased full report, regardless of status; with `sinceIso` only rows created at/after it. */
    countWebhooksTotal(sinceIso = null) {
      return sinceIso === null ? countWebhooksTotalStmt.get().n : countWebhooksTotalSinceStmt.get(sinceIso).n;
    },
    /** Webhook-event rows on the given UTC day (YYYY-MM-DD); `sinceIso` adds a created_at >= floor. */
    countWebhooksToday(day, sinceIso = null) {
      const row = sinceIso === null ? countWebhooksTodayStmt.get(day) : countWebhooksTodaySinceStmt.get(day, sinceIso);
      return row?.n ?? 0;
    },
    /** Per-UTC-day webhook-event counts with created_at >= sinceIso: [{ date, count }]. */
    webhookDayCounts(sinceIso) {
      return webhookDayCountsStmt.all(sinceIso).map((r) => ({ date: r.day, count: r.n }));
    },

    // --- Paid-order ledger (collect-email-before-checkout fulfillment) -------
    /**
     * Record an order-intent (a pending $12 report order waiting for its
     * Stripe checkout to complete). `checkoutSessionId` is the per-order
     * Checkout Session created BEFORE the insert (full-Stripe flow) — kept
     * null for rows written by the legacy payment-link flow. @returns
     * {boolean} true when inserted.
     */
    insertOrder({ id, scanId, email, createdAt, status = 'pending', checkoutSessionId = null }) {
      const info = insertOrderStmt.run(id, scanId, email, status, checkoutSessionId, null, createdAt);
      return info.changes > 0;
    },
    /** @returns {null | { id, scan_id, email, status, checkout_session_id, paid_at, created_at }} */
    getOrder(id) {
      return getOrderStmt.get(id) ?? null;
    },
    /**
     * Newest PENDING order for an email created at/after `sinceIso` (the 24h
     * webhook-correlation fallback when a session carries no client_reference_id).
     * @returns {null | { id, scan_id, email, status, checkout_session_id, paid_at, created_at }}
     */
    findPendingOrderByEmail(email, sinceIso) {
      return findPendingOrderByEmailStmt.get(email, sinceIso) ?? null;
    },
    /**
     * Fulfill a pending order. Race-safe: the UPDATE is scoped to
     * `status = 'pending'`, so only the FIRST matching webhook event flips
     * it — Stripe retries / duplicate deliveries see changes === 0 and are
     * treated as already-fulfilled (idempotent, exactly like webhook_events).
     * @returns {boolean} true when this call flipped the row to 'fulfilled'.
     */
    markOrderFulfilled(id, { checkoutSessionId = null, paidAt = null } = {}) {
      return fulfillOrderStmt.run(checkoutSessionId, paidAt, id).changes > 0;
    },
    /**
     * Record a checkout.session.completed that matched NO pending order
     * (bare payment-link purchase). INSERT OR IGNORE keyed on session id:
     * Stripe retries replay the same id and never create a second row.
     * @returns {boolean} true when a new row was inserted.
     */
    insertUnmatchedOrder({ sessionId, email = null, receivedAt }) {
      return insertUnmatchedOrderStmt.run(sessionId, email, receivedAt).changes > 0;
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
    /**
     * Remove an accepted-scan ledger row — D1/D2 GATE REJECTIONS ONLY (HTTP
     * error status response / non-HTML Content-Type). The request was ledgered
     * before running (count check + insert stay adjacent for race-freedom),
     * but a gate rejection must consume ZERO daily quota, so the row is
     * deleted and the per-IP count is exactly as if the request never
     * happened. Every OTHER failure path keeps its row (marked 'failed').
     * @returns {boolean} true when a row was deleted.
     */
    voidScanEvent(eventKey) {
      return voidScanEventStmt.run(eventKey).changes > 0;
    },
    // --- Homepage view tracking (admin stats) --------------------------------
    /**
     * Record one accepted beacon hit. The route filters bots / empty UAs /
     * per-IP 30s dedup BEFORE calling this, so every insert is a real view.
     * @param {{ ts: number, ip: string, ua: string, path: string }} view
     */
    insertPageView({ ts, ip, ua, path }) {
      insertPageViewStmt.run(ts, ip, ua, path);
    },
    /** Total page-view rows (all time); with `sinceTs` (epoch ms) only rows at/after it. */
    countPageViews(sinceTs = null) {
      return sinceTs === null ? countPageViewsStmt.get().n : countPageViewsSinceStmt.get(sinceTs).n;
    },
    /** Page-view rows with ts >= sinceTs (the 30-day window / 'today'). */
    countPageViewsSince(sinceTs) {
      return countPageViewsSinceStmt.get(sinceTs)?.n ?? 0;
    },
    /** Per-UTC-day page-view counts with ts >= sinceTs: [{ date, count }]. */
    pageViewDayCounts(sinceTs) {
      return pageViewDayCountsStmt.all(sinceTs).map((r) => ({ date: r.day, count: r.n }));
    },
    /** Latest 50 page views, newest first; with `sinceTs` only rows at/after it. */
    recentPageViews(sinceTs = null) {
      const rows = sinceTs === null ? recentPageViewsStmt.all() : recentPageViewsSinceStmt.all(sinceTs);
      return rows.map((r) => ({ ts: r.ts, ip: r.ip, ua: r.ua, path: r.path }));
    },
    /** Total scan rows (all time); with `sinceIso` only rows created at/after it. */
    countScansTotal(sinceIso = null) {
      return sinceIso === null ? countScansTotalStmt.get().n : countScansTotalSinceStmt.get(sinceIso).n;
    },
    /** Scan rows on the given UTC day (YYYY-MM-DD); `sinceIso` adds a created_at >= floor. */
    countScansToday(day, sinceIso = null) {
      const row = sinceIso === null ? countScansTodayStmt.get(day) : countScansTodaySinceStmt.get(day, sinceIso);
      return row?.n ?? 0;
    },
    /** Per-UTC-day scan counts with created_at >= sinceIso: [{ date, count }]. */
    scanDayCounts(sinceIso) {
      return scanDayCountsStmt.all(sinceIso).map((r) => ({ date: r.day, count: r.n }));
    },
    // --- Admin share-card tool audit trail (owner 2026-10-01) -----------------
    /**
     * Append one admin-tool scan to the audit trail. Plain INSERT — the route
     * generates the id (randomUUID) and is responsible for the (best-effort)
     * try/catch, because an audit failure must never break the tool response.
     * Retention never purges this table.
     * @param {{ id: string, scanId: string, actor: string, ip: string|null,
     *           url: string, score: number, verdict: string, createdAt: string }} row
     */
    insertAdminAudit(row) {
      insertAdminAuditStmt.run(
        row.id,
        row.scanId ?? null,
        row.actor,
        row.ip ?? null,
        row.url,
        row.score,
        row.verdict,
        row.createdAt,
      );
    },

    // --- Settings key-value store (admin-stats epoch cutover) ----------------
    /**
     * Read a settings value; null when the key is absent (a fresh/dev DB, or
     * prod before the cutover runs — both mean "no epoch filter").
     * @returns {string | null}
     */
    getSetting(key) {
      return getSettingStmt.get(key)?.value ?? null;
    },
    /**
     * Upsert a settings value (INSERT OR REPLACE — one row per key).
     * @param {string} key
     * @param {string} value
     */
    setSetting(key, value) {
      setSettingStmt.run(key, String(value));
    },
    close() {
      db.close();
    },
  };
}