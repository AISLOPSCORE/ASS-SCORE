import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateEmail } from '../email.js';

/**
 * POST /api/v1/order-intent — the 'collect email before checkout' flow
 * (built 2026-09-25; the static Stripe payment link collects NO email and its
 * sessions carry no metadata, so the backend needs the recipient + scan id
 * BEFORE the buyer is redirected to Stripe).
 *
 * The site calls this with { scanId, email } (scan_id alias accepted) when the
 * buyer clicks "Unlock the full report — $12". The backend records a PENDING
 * order row, then hands back the Stripe payment link pre-filled with the email
 * plus the order id as `client_reference_id`. When the checkout completes,
 * Stripe's `checkout.session.completed` webhook echoes the session with
 * `client_reference_id` (and the `prefilled_email`), and the webhook route
 * correlates the session back to this order and emails the token'd report
 * link — no Stripe secret API key involved anywhere.
 *
 * Contract:
 *   200 { orderId, redirectUrl } — order recorded, send the buyer here
 *   404 not_found — scanId does not exist
 *   400 invalid_scan_id / invalid_email — bad input
 *
 * Deliberately NOT rate-limited: a failed/abandoned checkout may legitimately
 * be retried, and every row costs ~100 bytes. The orders table is small.
 */

/** The static $12 buy link (ass-score.com catalog product, created by the
 *  owner); the deploy overrides it with STRIPE_PAYMENT_LINK. */
export const DEFAULT_STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/cNi00j7zs1P49ju5B9abK00';

export function orderIntentRouter({
  db,
  now = () => new Date().toISOString(),
  stripePaymentLink,
} = {}) {
  const r = Router();
  const linkBase = (stripePaymentLink ?? process.env.STRIPE_PAYMENT_LINK ?? DEFAULT_STRIPE_PAYMENT_LINK).trim();

  r.post('/api/v1/order-intent', (req, res) => {
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
    // without it there is no recipient for the report link and nothing for the
    // webhook to correlate by email. Same validation the scan/webhook routes
    // use, so the address shape rules are identical product-wide.
    const mail = validateEmail(body.email);
    if (!mail.ok || mail.email === null) {
      return res.status(400).json({
        error: { code: 'invalid_email', message: mail.email === null ? 'email is required' : mail.message },
      });
    }

    const orderId = randomUUID();
    const email = mail.email.toLowerCase(); // normalized storage; webhook fallback matches lowercased
    const createdAt = now();
    db.insertOrder({ id: orderId, scanId: scan.id, email, createdAt });

    // Stripe payment link, pre-filled with the email + our order id. The
    // `?` vs `&` choice is defensive: an env-configured link that already
    // carries its own query string must not break.
    const sep = linkBase.includes('?') ? '&' : '?';
    const redirectUrl =
      `${linkBase}${sep}prefilled_email=${encodeURIComponent(email)}` +
      `&client_reference_id=${encodeURIComponent(orderId)}`;

    res.status(200).json({ orderId, redirectUrl });
  });

  return r;
}