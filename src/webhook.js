/**
 * Webhook delivery for completed scans.
 *
 * Delivery is best-effort and fully async: the /api/v1/scan response is never
 * delayed or failed by webhook problems. The default deliverer POSTs the exact
 * scan-result JSON (the same object returned to the caller) with a 5 s timeout
 * per attempt, retries up to 3 attempts with backoff (1 s, 3 s, 9 s) for
 * network errors / non-2xx responses, and gives up immediately (no retry) on
 * 4xx — a client-side rejection retrying would never succeed.
 *
 * A webhook URL is a callback URL, NOT a scan target: it is validated for
 * scheme + host presence only (via `new URL`) and deliberately skips the SSRF
 * range checks used for scan targets. DNS failures in that case surface at
 * delivery time as network errors → retried → logged.
 */

const DEFAULT_TIMEOUT_MS = 5_000; // per-attempt timeout
const DEFAULT_MAX_ATTEMPTS = 3;   // total attempts (1 initial + 2 retries)
const DEFAULT_BACKOFF_MS = [1_000, 3_000, 9_000]; // delay before attempt 2, 3, ...

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate an optional webhookUrl from a scan request.
 *
 * @param {unknown} value - req.body.webhookUrl
 * @returns {{ ok: true, url: null | string } | { ok: false, message: string }}
 *   - { ok: true, url: null }  → missing/empty (allowed, no delivery)
 *   - { ok: true, url: string } → normalized http(s) URL to POST to
 *   - { ok: false, message }   → invalid → API must 400 `invalid_webhook_url`
 */
export function validateWebhookUrl(value) {
  if (value === undefined || value === null) return { ok: true, url: null };
  if (typeof value !== 'string') {
    return { ok: false, message: 'webhookUrl must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, url: null }; // empty = no delivery

  // The authority (host[:port][@...]) must be present in the RAW input.
  // `new URL('http:///hook')` silently normalizes to `http://hook/`, so a
  // parse alone cannot prove the caller supplied a host.
  if (!/^https?:\/\/[^\s/?#]+/i.test(trimmed)) {
    return { ok: false, message: 'webhookUrl must be of the form http(s)://host[:port]/path...' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: `webhookUrl "${value}" is not a valid URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'webhookUrl must use http:// or https://' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: 'webhookUrl must include a host' };
  }
  return { ok: true, url: parsed.href };
}

/**
 * Build the default webhook deliverer (function injectable into the router).
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]     per-attempt network timeout
 * @param {number} [opts.maxAttempts=3]      total attempts
 * @param {number[]} [opts.backoffMs]        delay before attempts 2, 3, ...
 * @param {Function} [opts.fetchImpl]        fetch implementation (tests inject stubs)
 * @param {object} [opts.logger]             logger with .error (default console)
 * @returns {(scan: object, webhookUrl: string) => Promise<{ok: boolean, attempts: number, status?: number, error?: Error}>}
 *
 * Never rejects: all failures are logged and returned as { ok: false } so the
 * scan response is never affected.
 */
export function createWebhookDeliverer({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  return async function deliverWebhook(scan, webhookUrl) {
    if (!scan || typeof scan.id !== 'string') {
      logger.error(`[webhook] delivery to ${webhookUrl} aborted: payload is not a scan result`);
      return { ok: false, attempts: 0, error: new Error('missing scan payload') };
    }
    const body = JSON.stringify(scan);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = backoffMs[attempt - 2] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const response = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ass-score-scan-id': scan.id,
          },
          body,
          signal: ctrl.signal,
        });

        if (response.status >= 200 && response.status < 300) {
          return { ok: true, attempts: attempt };
        }
        if (response.status >= 400 && response.status < 500) {
          // 4xx is the client's fault — retrying will not change the outcome.
          logger.error(
            `[webhook] delivery to ${webhookUrl} for scan ${scan.id} rejected with HTTP ${response.status}; giving up (4xx is not retried)`
          );
          return { ok: false, attempts: attempt, status: response.status };
        }
        lastError = new Error(`HTTP ${response.status}`);
        logger.error(
          `[webhook] delivery to ${webhookUrl} for scan ${scan.id} got HTTP ${response.status} (attempt ${attempt}/${maxAttempts})`
        );
      } catch (err) {
        lastError = err;
        const reason = ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
        logger.error(
          `[webhook] delivery to ${webhookUrl} for scan ${scan.id} failed: ${reason} (attempt ${attempt}/${maxAttempts})`
        );
      } finally {
        clearTimeout(timer);
      }
    }

    return { ok: false, attempts: maxAttempts, error: lastError };
  };
}