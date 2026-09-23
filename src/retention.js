/**
 * Daily retention job — purge old rows from the three ledger tables.
 *
 * Owner-approved (2026-09-23): delete rows older than 30 days from `scans`,
 * `scan_events`, and `webhook_events`, running daily with no manual
 * intervention.
 *
 * All three tables store created_at as ISO-8601 strings
 * (e.g. `2026-09-23T12:00:00.000Z`), so the cutoff is compared
 * lexicographically against the ISO string — exact for same-format ISO
 * timestamps, no per-row date parsing. Parameterized queries only; the cutoff
 * is never interpolated into SQL.
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

  // Strictly older than the cutoff (`<`, not `<=`): a row created exactly
  // maxAgeMs ago is not yet "older than 30 days".
  const deleteScans = conn.prepare('DELETE FROM scans WHERE created_at < ?');
  const deleteScanEvents = conn.prepare('DELETE FROM scan_events WHERE created_at < ?');
  const deleteWebhookEvents = conn.prepare('DELETE FROM webhook_events WHERE created_at < ?');

  const scans = deleteScans.run(cutoffIso).changes;
  const scanEvents = deleteScanEvents.run(cutoffIso).changes;
  const webhookEvents = deleteWebhookEvents.run(cutoffIso).changes;

  // Single-line outcome for Railway logs, e.g.
  // '[retention] cutoff=2026-08-24T12:00:00.000Z scans=12 events=3 webhooks=0'
  console.log(`[retention] cutoff=${cutoffIso} scans=${scans} events=${scanEvents} webhooks=${webhookEvents}`);

  return { deleted: { scans, scanEvents, webhookEvents }, cutoffIso };
}