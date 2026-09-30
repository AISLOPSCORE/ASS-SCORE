/**
 * Daily retention job — purge old rows from the ledger tables.
 *
 * Owner-approved (2026-09-23): delete rows older than 30 days from `scans`,
 * `scan_events`, `webhook_events`, and `page_views`, running daily with no
 * manual intervention.
 *
 * PAID-SCAN EXEMPTION (owner-approved 2026-09-28, preserve-data/expire-access):
 * the `scans` purge skips any scan that has an order with status = 'fulfilled'
 * (orders.scan_id = scans.id). Fulfilled paid scans are kept forever — the
 * 30-day window still applies to their REPORT LINK (see src/ttl.js, an
 * independent knob), but the row itself is never deleted. Already-purged paid
 * scans (created BEFORE this change and deleted by an earlier retention run)
 * cannot be recovered; the exemption protects rows from the next retention
 * run forward. `scan_events` / `webhook_events` / `page_views` purges are
 * unchanged — the exemption applies to scans only.
 *
 * The first three tables store created_at as ISO-8601 strings
 * (e.g. `2026-09-23T12:00:00.000Z`), so the cutoff is compared
 * lexicographically against the ISO string — exact for same-format ISO
 * timestamps, no per-row date parsing. page_views stores ts as epoch
 * milliseconds (the homepage-beacon convention), so its cutoff is the
 * epoch-ms equivalent of the same instant. Parameterized queries only; the
 * cutoff is never interpolated into SQL.
 *
 * Deterministic and idempotent: a second run deletes nothing new, so the
 * daily schedule is safe (and a boot-time run never harms later runs).
 *
 * `db` may be the openDb() wrapper (it exposes `.raw`) or a raw
 * better-sqlite3 Database — both work.
 */

export function runRetention({ db, now = () => new Date().toISOString(), maxAgeMs = 30 * 24 * 60 * 60 * 1000 }) {
  const conn = db.raw ?? db; // openDb wrapper exposes .raw; a raw Database passes through
  const cutoffIso = new Date(Date.parse(now()) - maxAgeMs).toISOString();
  const cutoffMs = Date.parse(cutoffIso);

  // Strictly older than the cutoff (`<`, not `<=`): a row created exactly
  // maxAgeMs ago is not yet "older than 30 days".
  // PAID-SCAN EXEMPTION (owner-approved preserve-data/expire-access): rows with
  // a fulfilled order survive the purge — their report links expire per
  // src/ttl.js, but the scan row itself is retained so the purchase record
  // (and any future re-fulfillment) keeps its data.
  const deleteScans = conn.prepare(
    `DELETE FROM scans
     WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.scan_id = scans.id AND o.status = 'fulfilled')`
  );
  const deleteScanEvents = conn.prepare('DELETE FROM scan_events WHERE created_at < ?');
  const deleteWebhookEvents = conn.prepare('DELETE FROM webhook_events WHERE created_at < ?');
  const deletePageViews = conn.prepare('DELETE FROM page_views WHERE ts < ?');

  const scans = deleteScans.run(cutoffIso).changes;
  const scanEvents = deleteScanEvents.run(cutoffIso).changes;
  const webhookEvents = deleteWebhookEvents.run(cutoffIso).changes;
  const views = deletePageViews.run(cutoffMs).changes;

  // Single-line outcome for Railway logs, e.g.
  // '[retention] cutoff=2026-08-24T12:00:00.000Z scans=12 events=3 webhooks=0 views=41'
  console.log(`[retention] cutoff=${cutoffIso} scans=${scans} events=${scanEvents} webhooks=${webhookEvents} views=${views}`);

  return { deleted: { scans, scanEvents, webhookEvents, views }, cutoffIso };
}