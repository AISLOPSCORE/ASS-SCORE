/**
 * Paid-report access window — how long a purchased report link stays live.
 *
 * Owner-approved (preserve-data/expire-access): fulfillment retains a paid
 * scan row FOREVER (src/retention.js — the scans purge exempts rows that have
 * an order with status = 'fulfilled'), but the token'd report link for that
 * scan expires REPORT_ACCESS_TTL_MS (30 days) after the scan was created.
 *
 * This is an INDEPENDENT decision from the retention default: src/retention.js
 * also uses a 30-day maxAge, but the two knobs are separate — raising or
 * lowering one never changes the other. REPORT_ACCESS_TTL_MS gates report
 * rendering (a valid token on an expired scan is a 410 report_expired); the
 * retention maxAgeMs default controls which ledger rows the daily purge
 * deletes.
 *
 * Expiry is FIXED to scan.created_at — not the token-mint time, not the
 * purchase time. The scan timestamp is immutable and unambiguous, so the gate
 * is deterministic for a given row: same scan, same clock -> same verdict,
 * forever.
 */

export const REPORT_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True when a scan's 30-day report-access window has passed.
 *
 * `Date.parse(nowIso) - Date.parse(scan.created_at) > REPORT_ACCESS_TTL_MS` —
 * strictly greater, so a scan exactly 30 days old is NOT yet expired (same
 * boundary convention as the retention cutoff, though the two are separate
 * decisions). An unparseable/legacy created_at fails OPEN (not expired) so
 * old rows never 410 spuriously.
 *
 * @param {{ created_at?: string, createdAt?: string }} scan
 * @param {string} nowIso ISO-8601 timestamp from the app's injectable clock
 * @returns {boolean}
 */
export function isReportExpired(scan, nowIso) {
  const createdAt = scan.created_at ?? scan.createdAt;
  const createdMs = Date.parse(String(createdAt ?? ''));
  if (Number.isNaN(createdMs)) return false; // legacy/unparseable rows fail open (not expired)
  return Date.parse(nowIso) - createdMs > REPORT_ACCESS_TTL_MS;
}