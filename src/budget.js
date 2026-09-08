/**
 * Per-scan time budget. A scan has one budget covering target fetch + discovery
 * + additional fetches + similarity. When the deadline elapses, in-flight work
 * is aborted and whatever completed is used (partial mode).
 *
 * Deterministic: the budget only gates when work stops, it never feeds scores.
 */
export function createBudget(totalMs, { now = Date.now } = {}) {
  const started = now();
  const deadline = started + (totalMs > 0 ? totalMs : 0);
  return {
    totalMs,
    started,
    deadline,
    remainingMs: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
  };
}