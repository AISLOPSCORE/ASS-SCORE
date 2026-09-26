import { Router } from 'express';
import { createReportToken, buildReportUrl } from '../paywall.js';
import { toPublicScan } from '../serialize.js';
import { createStripeClient } from '../stripeClient.js';
import { configMissing, stripeFailure } from './orderIntent.js';
/**
 * Order status + same-session verification for the full-Stripe checkout flow
 * (owner-approved 2026-09-25 — Task A of the fulfillment redesign).
 *
 * GET /api/v1/orders/:orderId        — polling read used by the site's
 *   /checkout/success page. DB-only (NO Stripe call): the status lives in
 *   our orders table and is flipped by whichever fulfillment path lands
 *   first (webhook is primary, POST .../verify is the same-session path,
 *   operator sweep is the delay-only backup). reportUrl is emitted ONLY when
 *   status is 'fulfilled'; order ids are random 122-bit uuids, so a client
 *   can never enumerate or guess an order.
 *
 * POST /api/v1/orders/:orderId/verify — the same-session unlock. Body
 *   { sessionId } (the success page's ?session_id= from the URL). The route
 *   fetches the session BACK from Stripe with the secret key and trusts only
 *   payment_status === 'paid' — the redirect (or a spoofed query param) is
 *   never the proof. On paid: race-safe markOrderFulfilled (only the first
 *   caller flips pending→fulfilled — webhook vs verify vs sweep are all
 *   idempotent against each other), then the token'd report email via the
 *   SAME emailSender the webhook uses, and returns the reportUrl for
 *   immediate same-session open. Unpaid → 200 { status: 'pending' } so the
 *   success page keeps polling; it is NOT an error.
 *
 * Contract (verify):
 *   200 { status: 'fulfilled', scanId, reportUrl }   — paid + fulfilled
 *   200 { status: 'pending' }                        — session exists but not
 *                                                      paid yet (keep polling)
 *   404 not_found        — unknown orderId
 *   400 invalid_session_id / invalid_session — sessionId missing/empty, or
 *       the session's client_reference_id does not match this order
 *   503 config_missing   — STRIPE_SECRET_KEY not set
 *   502 stripe_unauthorized / stripe_unavailable / stripe_error — could not
 *       reach/authenticate with Stripe; retry later
 *
 * Contract (status read):
 *   200 { status: 'pending'|'fulfilled', scanId, reportUrl? }
 *   404 not_found — unknown orderId
 */
export function ordersRouter({
  db,
  now = () => new Date().toISOString(),
  stripe,
  stripeSecretKey,
  reportTokenSecret,
  reportBaseUrl,
  emailSender,
} = {}) {
  const r = Router();
  const apiKey = String(stripeSecretKey ?? process.env.STRIPE_SECRET_KEY ?? '').trim();
  const stripeImpl = stripe ?? createStripeClient({ apiKey });
  /** The token'd full-report URL for an order's scan (needs no scan row). */
  const reportUrlFor = (order) =>
    buildReportUrl(reportBaseUrl, order.scan_id, createReportToken(reportTokenSecret, order.scan_id));
  /** Deliver the report email — identical path to webhook fulfillment. */
  async function deliverReport(order) {
    const scan = db.getScan(order.scan_id);
    if (!scan) {
      console.error(`[orders] order ${order.id}: scan ${order.scan_id} no longer exists — report email NOT sent`);
      return null;
    }
    if (!emailSender) return null;
    try {
      await emailSender(toPublicScan(scan), order.email);
      return order.email;
    } catch (err) {
      console.error(`[orders] email to ${order.email} for order ${order.id} crashed:`, err?.message ?? err);
      return null;
    }
  }
  /** POST /api/v1/orders/:orderId/verify */
  r.post('/api/v1/orders/:orderId/verify', async (req, res) => {
    const order = db.getOrder(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: { code: 'not_found', message: `No order found with id "${req.params.orderId}"` } });
    }
    const raw = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const sessionId = raw || (typeof order.checkout_session_id === 'string' ? order.checkout_session_id.trim() : '');
    if (!sessionId) {
      return res.status(400).json({ error: { code: 'invalid_session_id', message: 'sessionId is required' } });
    }
    if (!apiKey && !stripe) return res.status(503).json(configMissing('STRIPE_SECRET_KEY'));
    let session;
    try {
      session = await stripeImpl.getCheckoutSession(sessionId);
    } catch (err) {
      return res.status(502).json(stripeFailure(err));
    }
    if (!session || session.client_reference_id !== order.id) {
      return res.status(400).json({
        error: { code: 'invalid_session', message: 'This session does not belong to this order' },
      });
    }
    if (session.payment_status !== 'paid') {
      // Success page keeps polling — never an error.
      return res.status(200).json({ status: 'pending' });
    }
    // Paid → fulfill race-safely. Only the FIRST caller (webhook / verify /
    // sweep) flips pending→fulfilled; later callers skip the email but get
    // the same response shape (idempotent; a page refresh re-opens).
    const flipped = db.markOrderFulfilled(order.id, { checkoutSessionId: sessionId, paidAt: now() });
    if (flipped) {
      await deliverReport(order); // best-effort; fulfillment never waits on email
    } else {
      const fresh = db.getOrder(order.id);
      if (fresh?.status !== 'fulfilled') {
        // Row exists but not flippable (should not happen) — surface pending.
        return res.status(200).json({ status: 'pending' });
      }
    }
    return res.status(200).json({ status: 'fulfilled', scanId: order.scan_id, reportUrl: reportUrlFor(order) });
  });
  /** GET /api/v1/orders/:orderId — polling read, DB only. */
  r.get('/api/v1/orders/:orderId', (req, res) => {
    const order = db.getOrder(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: { code: 'not_found', message: `No order found with id "${req.params.orderId}"` } });
    }
    if (order.status === 'fulfilled') {
      return res.status(200).json({ status: 'fulfilled', scanId: order.scan_id, reportUrl: reportUrlFor(order) });
    }
    return res.status(200).json({ status: 'pending', scanId: order.scan_id });
  });
  return r;
}