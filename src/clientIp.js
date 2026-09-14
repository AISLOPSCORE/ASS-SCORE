/**
 * Shared client-IP derivation for rate-limit ledgers.
 *
 * Express's `req.ip` is the single source of truth: it honors `X-Forwarded-For`
 * when `trust proxy` is enabled (see createApp — the app trusts the first
 * proxy hop, i.e. the platform edge, so `req.ip` is the real client behind
 * Railway's LB) and falls back to the socket remote address otherwise, exactly
 * the "(X-Forwarded-For / socket)" derivation the webhook route has always
 * used. Both POST /api/v1/scan and POST /api/v1/webhook key their per-IP daily
 * caps through this helper so the two routes can never drift apart.
 *
 * `?? 'unknown'` is a belt-and-braces fallback for exotic environments where
 * Express cannot determine an address (normally req.ip is always a string).
 */
export function clientIp(req) {
  return req.ip ?? 'unknown';
}