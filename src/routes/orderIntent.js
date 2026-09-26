import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateEmail } from '../email.js';
import { createStripeClient } from '../stripeClient.js';
/**
 * POST /api/v1/order-intent — the full-Stripe checkout flow
 * (owner-approved 2026-09-25; replaces the static-payment-link flow).
 *
 * The site calls this with { scanId, email } when the buyer clicks
 * "Unlock the full report — $12". The backend generates the order id FIRST
 * (randomUUID, used as both the `orders` row id and the Checkout Session's
 * client_reference_id), creates a per-order Stripe Checkout Session for the
 * $12 price, and only THEN records the pending order row (with the session
 * id). The buyer is redirected to `checkoutUrl` (session.url); when payment
 * completes, Stripe redirects to the site's success page with
 * `?session_id={CHECKOUT_SESSION_ID}` (Stripe's substitution) — the backend
 * never trusts the redirect, it verifies payment_status directly against
 * Stripe on POST /api/v1/orders/:orderId/verify (src/routes/orders.js), the
 * webhook remains the primary fulfillment mechanism, and the operator sweep
 * is the delay-only backup.
 *
 * Session creation happens BEFORE the order insert on purpose: if the Stripe
 * call fails there is no order row to clean up, and if the insert fails the
 * orphan session simply expires on its own (Stripe Checkout sessions expire
 * after 24h with no payment; we never create a second one for the order).
 *
 * Contract:
 *   200 { orderId, checkoutUrl } — session created + order recorded; send the
 *       buyer to checkoutUrl
 *   404 not_found — scanId does not exist
 *   400 invalid_scan_id / invalid_email — bad input
 *   503 config_missing — STRIPE_SECRET_KEY or STRIPE_PRICE_ID not set (the
 *       message names the exact env var)
 *   502 stripe_unauthorized / stripe_unavailable / stripe_error — the Stripe
 *       API refused or was unreachable; nothing was recorded
 *
 * Deliberately not rate-limited: a failed/abandoned checkout may legitimately
 * be retried, and every row costs ~100 bytes. The orders table is small.
 */
/** 503-kernel shared by the order routes (naming the exact env var). */
export function configMissing(envVar) {
  return {
    error: {
      code: 'config_missing',
      message: `${envVar} is not set — add it to the environment before accepting orders (the owner's Stripe account switch sets STRIPE_SECRET_KEY; STRIPE_PRICE_ID is the $12 price object id)`,
    },
  };
}
/** Map a thrown stripe-client failure onto the 502 body. */
export function stripeFailure(err) {
  const code = err?.code ?? 'stripe_error';
  return { error: { code, message: err?.message ?? 'Stripe API request failed' } };
}
export function orderIntentRouter({
  db,
  now = () => new Date().toISOString(),
  stripe,
  stripeSecretKey,
  stripePriceId,
  publicBaseUrl,
} = {}) {
  const r = Router();
  // Resolve config ONCE at router creation (same convention as the rest of
  // the app: options win, env fills the gaps). The route guards presence per
  // request so an injected test client can bypass the env entirely.
  const priceId = String(stripePriceId ?? process.env.STRIPE_PRICE_ID ?? '').trim();
  const apiKey = String(stripeSecretKey ?? process.env.STRIPE_SECRET_KEY ?? '').trim();
  const successBase = (publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://www.ass-score.com').replace(/\/+$/, '');
  const stripeImpl = stripe ?? createStripeClient({ apiKey });
  r.post('/api/v1/order-intent', async (req, res) => {
    const body = req.body ?? {};
    const scanId = typeof body.scanId === 'string' ? body.scanId : body.scan_id;
    if (typeof scanId !== 'string' || scanId.trim() === '') {
      return res.status(400).json({ error: { code: 'invalid_scan_id', message: 'scanId is required' } });
    }
    const scan = db.getScan(scanId);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${scanId}"` } });
    }
    // Email is REQUIRED here (unlike the scan route where it is optional):
    // it pre-fills Stripe Checkout AND is the report recipient. Same
    // validation the scan/webhook routes use, so the address shape rules are
    // identical product-wide.
    const mail = validateEmail(body.email);
    if (!mail.ok || mail.email === null) {
      return res.status(400).json({
        error: { code: 'invalid_email', message: mail.email === null ? 'email is required' : mail.message },
      });
    }
    // Config gates BEFORE any side effect: a missing key/price is a deploy
    // error, not a Stripe failure — 503 with the exact env var named. An
    // injected test client skips the key gate (tests own their config).
    if (!priceId) return res.status(503).json(configMissing('STRIPE_PRICE_ID'));
    if (!apiKey && !stripe) return res.status(503).json(configMissing('STRIPE_SECRET_KEY'));
    const orderId = randomUUID();
    const email = mail.email.toLowerCase(); // normalized storage/Stripe prefill
    let session;
    try {
      session = await stripeImpl.createCheckoutSession({
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: orderId,
        customer_email: email,
        metadata: { scan_id: scan.id, order_id: orderId },
        // Stripe substitutes {CHECKOUT_SESSION_ID} with the real session id
        // in the redirect; the success page passes it back to verify.
        success_url: `${successBase}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${successBase}/scan/${encodeURIComponent(scan.id)}`,
      });
    } catch (err) {
      // NO order row was written — the buyer just sees the failure and can
      // retry. Unauthorized/unavailable are already normalized by the client;
      // anything else (bad price id, etc.) is a stripe_error with Stripe's
      // own message so ops can read the cause.
      return res.status(502).json(stripeFailure(err));
    }
    if (!session?.id || typeof session?.url !== 'string') {
      return res.status(502).json({
        error: { code: 'stripe_error', message: 'Stripe returned a Checkout Session without id/url' },
      });
    }
    const inserted = db.insertOrder({
      id: orderId,
      scanId: scan.id,
      email,
      createdAt: now(),
      checkoutSessionId: session.id,
    });
    if (!inserted) {
      // Practically impossible (fresh uuid), but never crash the checkout:
      // orphan session expires on its own, buyer can retry.
      return res.status(502).json({
        error: { code: 'stripe_error', message: 'Could not record the order' },
      });
    }
    res.status(200).json({ orderId, checkoutUrl: session.url });
  });
  return r;
}