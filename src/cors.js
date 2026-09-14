/**
 * CORS support for the public API — allowlisted browser origins only.
 *
 * Rationale for allowlist over `*`: the only browser consumers of this API are
 * the site's own origins (ass-score.com + the platform preview). No cookies or
 * credentials are involved (no Access-Control-Allow-Credentials is ever set),
 * but a tight list still means no third-party page can script the API from a
 * visitor's browser, keeping the per-IP rate-limit ledger attributable to real
 * site traffic. Non-browser clients (curl, servers, the payment webhook) are
 * unaffected: requests without an Origin header pass straight through.
 *
 * Preflight handling: OPTIONS from an allowed origin is answered with 204 and
 * the allow headers (Content-Type + Accept are all the site's fetch calls
 * send); OPTIONS from a disallowed origin gets no CORS headers, so the browser
 * blocks the request — the route handlers themselves are never reached for
 * cross-origin calls the browser already refused.
 */

export const DEFAULT_ALLOWED_ORIGINS = [
  'https://www.ass-score.com',
  'https://ass-score.com',
  'https://df5831baeeff55d6a65893943c619d81.ctonew.app',
];

/** Parse CORS_ORIGINS (comma-separated) into an array; empty -> defaults. */
export function parseOrigins(raw, fallback = DEFAULT_ALLOWED_ORIGINS) {
  if (typeof raw !== 'string') return [...fallback];
  const parsed = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * Express middleware factory.
 * @param {{ allowedOrigins?: string[] }} opts defaults to
 *   DEFAULT_ALLOWED_ORIGINS (or env CORS_ORIGINS, comma-separated).
 */
export function createCors(opts = {}) {
  const raw = opts.allowedOrigins ?? parseOrigins(process.env.CORS_ORIGINS);
  const allowed = new Set(raw.map((o) => o.replace(/\/+$/, '')));

  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');
    if (origin && allowed.has(origin.replace(/\/+$/, ''))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.set('Access-Control-Max-Age', '86400');
      // Preflight: the browser only wants the allow headers; answer 204 and
      // skip the route handlers entirely.
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
    }
    next();
  };
}