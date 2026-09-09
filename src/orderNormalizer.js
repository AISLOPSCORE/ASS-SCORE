/**
 * Order-webhook normalizers — Fiverr / Stripe / LemonSqueezy → ONE internal
 * shape: { provider, eventId, targetUrl, businessName?, clientEmail? }.
 *
 * Design rules (from the build brief):
 *   - explicit: each provider is detected by its own marker field(s) and
 *     extracted with a documented set of candidate paths; the provider is
 *     named in the result so callers/logs always know which shape matched.
 *   - tolerant: candidate paths are tried in order, URLs are pulled out of
 *     free-text requirement fields (Fiverr buyers paste them), missing
 *     optional fields (businessName/clientEmail) are null — never a crash.
 *   - unknown provider shape → { ok: false, message } so the route can 400
 *     with a clear reason; recognized-but-unusable shape (no target URL)
 *     also yields { ok: false } with the provider named.
 *
 * Helpers are exported for unit tests.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const URL_RE = /https?:\/\/[^\s"'<>]+/i;

/** First http(s) URL found in any of the candidate values (path-tolerant). */
export function findUrl(...candidates) {
  for (const c of candidates) {
    const s = str(c);
    if (!s) continue;
    const m = s.match(URL_RE);
    if (m) return m[0].replace(/[),.;]+$/, ''); // strip trailing punctuation
  }
  return null;
}

/** First non-empty string among dotted paths into obj (e.g. 'gig.title'). */
export function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
    const s = str(v);
    if (s) return s;
  }
  return null;
}

const ok = (provider, eventId, targetUrl, businessName, clientEmail) =>
  ({ ok: true, provider, eventId, targetUrl, businessName, clientEmail });

const fail = (provider, reason) =>
  ({ ok: false, provider, message: `Could not normalize the ${provider} payload: ${reason}` });

function finalize(provider, { eventId, targetUrl, businessName, clientEmail }) {
  if (!targetUrl) return fail(provider, 'no target website URL found (expected an http(s) URL in the order/requirements/custom fields)');
  return ok(provider, eventId, targetUrl, businessName, clientEmail);
}

// ------------------------------------------------------------------ Fiverr
/**
 * Fiverr order webhook. Marker: a top-level `type`/`event_type` starting with
 * "ORDER" (e.g. ORDER_CREATED, ORDER_ACCEPTED) with a `data.order` object.
 *
 * Extraction (tolerant):
 *   eventId      – data.order.id | order_id | uuid
 *   targetUrl    – first http(s) URL in order.requirements / requirement /
 *                  message / url / link (buyers paste the site to scan)
 *   businessName – order.business_name | brand_name | company_name | title |
 *                  gig.title
 *   clientEmail  – order.buyer.email | buyer_email | email
 *                  (Fiverr rarely includes buyer email in webhooks; when the
 *                  client email is missing it is simply not emailed — the
 *                  order still scans.)
 */
export function normalizeFiverr(raw) {
  const type = str(raw?.type || raw?.event_type || raw?.eventName);
  if (!/^order/i.test(type)) return null;
  if (!isObj(raw.data) || !isObj(raw.data.order)) {
    return fail('fiverr', 'expected an object at data.order');
  }
  const order = raw.data.order;
  const eventId = str(pick(order, 'id', 'order_id', 'uuid') ?? '');
  return finalize('fiverr', {
    eventId: eventId || null,
    targetUrl: findUrl(order.requirements, order.requirement, order.message, order.url, order.link, order.website),
    businessName: pick(order, 'business_name', 'brand_name', 'company_name', 'brand', 'title', 'gig.title'),
    clientEmail: pick(order, 'buyer.email', 'buyer_email', 'email'),
  });
}

// ------------------------------------------------------------------ Stripe
/**
 * Stripe Checkout webhook. Marker: `type === "checkout.session.completed"`
 * (the only production-relevant session event for one-shot report orders) with
 * `data.object` (the checkout session).
 *
 * Assumed metadata keys (documented in README § Fulfillment webhook):
 *   metadata.target_url     – the website to scan (required)
 *   metadata.business_name  – the client's brand (optional; businessName also
 *                             accepted)
 *   metadata.client_email   – who gets the report link (optional; falls back
 *                             to the session's customer_email, then
 *                             customer_details.email)
 *
 * Also tolerated at top level of the metadata object:
 *   targetUrl, url, website · businessName, brand_name, company_name ·
 *   clientEmail, email
 */
export function normalizeStripe(raw) {
  if (str(raw?.type) !== 'checkout.session.completed') return null;
  if (!isObj(raw.data) || !isObj(raw.data.object)) {
    return fail('stripe', 'expected an object at data.object (checkout session)');
  }
  const session = raw.data.object;
  const meta = isObj(session.metadata) ? session.metadata : {};
  const eventId = str(session.id ?? '');
  return finalize('stripe', {
    eventId: eventId || null,
    targetUrl: findUrl(meta.target_url, meta.targetUrl, meta.url, meta.website),
    businessName: pick(meta, 'business_name', 'businessName', 'brand_name', 'company_name', 'brand'),
    clientEmail: pick(meta, 'client_email', 'clientEmail', 'email') || pick(session, 'customer_email', 'customer_details.email'),
  });
}

// ----------------------------------------------------------- LemonSqueezy
/**
 * LemonSqueezy order webhook. Marker: `meta.event_name` like "order_created"
 * / "payment_*" OR `data.type === "orders"` with an `attributes` object.
 *
 * Extraction (tolerant — common field names, all documented in README):
 *   eventId      – data.id (LemonSqueezy order id), else meta.webhook_id
 *   targetUrl    – meta.custom_data.target_url (custom checkout fields are the
 *                  place the merchant captures the URL), then
 *                  attributes.target_url / url / website
 *   businessName – meta.custom_data.business_name / businessName / brand_name
 *                  / company_name, else attributes.business_name / brand_name
 *   clientEmail  – meta.custom_data.client_email (the merchant-set delivery
 *                  address — same precedence as Stripe's metadata.client_email),
 *                  else attributes.user_email (the buyer's account email),
 *                  attributes.payer_email, meta.customer_email
 */
export function normalizeLemonSqueezy(raw) {
  const meta = isObj(raw?.meta) ? raw.meta : {};
  const data = isObj(raw?.data) ? raw.data : {};
  const eventName = str(meta.event_name || raw?.event_name);
  const attrs = isObj(data.attributes) ? data.attributes : {};
  const isLsShape =
    str(data.type) === 'orders' ||
    /order_created|order_paid|payment_|order_refunded|subscription_created/i.test(eventName) ||
    (attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0 && /order|payment/i.test(str(meta.event_name || '')));
  if (!isLsShape) return null;

  const custom = isObj(meta.custom_data) ? meta.custom_data : {};
  const eventId = str(data.id ?? meta.webhook_id ?? '');
  return finalize('lemonsqueezy', {
    eventId: eventId || null,
    targetUrl: findUrl(custom.target_url, custom.targetUrl, custom.url, custom.website, attrs.target_url, attrs.url, attrs.website),
    businessName: pick(custom, 'business_name', 'businessName', 'brand_name', 'company_name', 'brand') ||
      pick(attrs, 'business_name', 'brand_name'),
    clientEmail: pick(custom, 'client_email', 'clientEmail', 'email') ||
      pick(attrs, 'user_email', 'payer_email') ||
      pick(meta, 'customer_email'),
  });
}

/**
 * Normalize any webhook body into the unified order shape.
 * @param {unknown} raw - parsed JSON request body
 * @returns {{ ok: true, provider: string, eventId: string|null, targetUrl: string,
 *            businessName: string|null, clientEmail: string|null }
 *         | { ok: false, message: string }}
 */
export function normalizeOrder(raw) {
  if (!isObj(raw)) {
    return { ok: false, message: 'payload must be a JSON object (a Fiverr order, Stripe checkout.session.completed, or LemonSqueezy order webhook)' };
  }
  for (const normalize of [normalizeFiverr, normalizeStripe, normalizeLemonSqueezy]) {
    const result = normalize(raw);
    if (result !== null) return result;
  }
  return {
    ok: false,
    message: 'unrecognized provider payload shape — expected a Fiverr order event (type "ORDER_*" with data.order), a Stripe checkout.session.completed event, or a LemonSqueezy order webhook (meta.event_name / data.type "orders")',
  };
}