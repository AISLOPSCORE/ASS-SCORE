/**
 * Minimal zero-dependency Stripe REST client (fetch wrapper).
 *
 * Built for the full-Stripe checkout redesign (owner-approved 2026-09-25):
 * the backend creates a per-order Checkout Session (POST /checkout/sessions),
 * reads sessions back directly for payment verification
 * (GET /checkout/sessions/:id), and registers/reuses the webhook endpoint
 * (webhook_endpoints) so Stripe can push checkout.session.completed events.
 *
 * Only the methods the product needs exist; nothing else is wrapped. The
 * client NEVER throws for a Stripe business response — the caller gets the
 * parsed JSON body back and decides. Two error classes are normalized:
 *   - StripeAuthError   (code 'stripe_unauthorized') — 401/403 from Stripe:
 *     bad/expired secret key, wrong mode (test vs live key), API access
 *     restricted on the account. A CONFIG problem, not a transient failure.
 *   - StripeUnavailableError (code 'stripe_unavailable') — network failure
 *     (fetch threw, DNS, TLS, timeout) and 5xx from Stripe's API: retryable,
 *     Stripe-side / transport problems.
 * Any other non-2xx (e.g. 400/404 from a bad request — unknown session id,
 * invalid params) is returned to the caller as an object shaped like
 * Stripe's error body so routes can respond with `{ error: { code,
 * message } }` using Stripe's own error message.
 *
 * The key is read from opts.apiKey ?? process.env.STRIPE_SECRET_KEY (the same
 * env var the deploy sets after the owner's Stripe account switch; a
 * STRIPE_TEST_SECRET_KEY value is passed as apiKey for local/test-mode runs).
 * Constructing the client with no key is fine (routes guard config presence
 * and answer 503 config_missing BEFORE any call is attempted); a call made
 * with no key would be rejected by Stripe as 401 → stripe_unauthorized.
 *
 * Injectable fetchImpl keeps the client unit-testable without a network; the
 * route tests inject a whole fake client instead (see test/stripeVerify.test.js).
 */

export const STRIPE_BASE = 'https://api.stripe.com/v1';
export const STRIPE_TIMEOUT_MS = 10_000;

/** Normalized auth/config error — 401/403 from Stripe. */
export class StripeAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeAuthError';
    this.code = 'stripe_unauthorized';
  }
}

/** Normalized transport/availability error — network failure or 5xx. */
export class StripeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeUnavailableError';
    this.code = 'stripe_unavailable';
  }
}

/**
 * Map any failure of an API call onto the two normalized classes.
 * @param {unknown} err anything that was thrown while talking to Stripe
 * @param {number|undefined} status HTTP status when one was received
 * @returns {Error} StripeAuthError | StripeUnavailableError
 */
export function normalizeStripeError(err, status) {
  if (err instanceof StripeAuthError || err instanceof StripeUnavailableError) return err;
  if (status === 401 || status === 403) {
    return new StripeAuthError(
      'Stripe rejected the secret key (401/403) — check STRIPE_SECRET_KEY is set to a key from the same account/mode that owns the price and webhook endpoint.'
    );
  }
  return new StripeUnavailableError(
    err instanceof Error ? err.message : `Stripe API request failed (HTTP ${status ?? 'no response'})`
  );
}

/**
 * Form-encode a params object for application/x-www-form-urlencoded POSTs.
 * Arrays (line_items etc.) serialize as repeated `key[i][field]=value`
 * (Stripe's wire format for nested list params), primitives as
 * `key=value`. null/undefined values are skipped.
 */
export function formEncode(params) {
  const parts = [];
  const walk = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${key}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(params ?? {})) walk(key, value);
  return parts.join('&');
}

/**
 * Create the Stripe client.
 * @param {object} opts
 * @param {string} [opts.apiKey]             secret key; defaults to process.env.STRIPE_SECRET_KEY
 * @param {string} [opts.baseUrl]            API base; defaults to STRIPE_BASE (tests override)
 * @param {typeof fetch} [opts.fetchImpl]    fetch implementation (tests inject a fake)
 * @param {number} [opts.timeoutMs]          AbortSignal timeout per request
 */
export function createStripeClient({
  apiKey = process.env.STRIPE_SECRET_KEY,
  baseUrl = STRIPE_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = STRIPE_TIMEOUT_MS,
} = {}) {
  const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;

  /** Perform one request, returning the parsed JSON or Stripe-shaped error. */
  async function request(method, path, params) {
    const url = `${baseUrl}${path}`;
    const headers = { Authorization: `Bearer ${key ?? ''}` };
    let body;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formEncode(params ?? {});
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw normalizeStripeError(err, undefined);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null; // non-JSON body — status still decides the outcome below
    }
    if (!res.ok) {
      // 401/403 → auth/config problem; 5xx → unavailable; other 4xx (400/404
      // bad request, unknown session) is Stripe's own error object — the
      // caller inspects `json.error` (Stripe's standard shape).
      if (res.status === 401 || res.status === 403) throw new StripeAuthError(json?.error?.message ?? `Stripe HTTP ${res.status}`);
      if (res.status >= 500) throw new StripeUnavailableError(json?.error?.message ?? `Stripe HTTP ${res.status}`);
      const err = new Error(json?.error?.message ?? `Stripe HTTP ${res.status}`);
      err.status = res.status;
      err.type = json?.error?.type ?? null;
      err.code = json?.error?.code ?? 'stripe_request_error';
      err.stripeBody = json;
      throw err;
    }
    return json;
  }

  return {
    /**
     * POST /checkout/sessions — create a per-order Checkout Session.
     * @param {object} params mode, line_items, client_reference_id,
     *   customer_email, metadata, success_url, cancel_url ...
     * @returns {Promise<object>} Stripe Checkout Session (id, url, ...)
     */
    createCheckoutSession(params) {
      return request('POST', '/checkout/sessions', params);
    },
    /**
     * GET /checkout/sessions/:id — read a session back (payment_status,
     * client_reference_id, ...). The verify route relies on this being the
     * SERVER-side truth: the redirect query param is never trusted.
     */
    getCheckoutSession(id) {
      return request('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
    },
    /** POST /webhook_endpoints — register a new webhook endpoint. */
    createWebhookEndpoint(params) {
      return request('POST', '/webhook_endpoints', params);
    },
    /** GET /webhook_endpoints?limit=100 — list existing endpoints. */
    listWebhookEndpoints(limit = 100) {
      return request('GET', `/webhook_endpoints?limit=${limit}`);
    },
  };
}