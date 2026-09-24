/**
 * Stripe webhook signature verification — HMAC-SHA256 over
 * `${timestamp}.${rawPayload}`, exactly the way Stripe signs events
 * (https://docs.stripe.com/webhooks#signatures).
 *
 * This module needs NO Stripe SDK and NO Stripe secret API key — only the
 * webhook signing secret (STRIPE_WEBHOOK_SECRET), which the lead registers
 * with Stripe and sets as an env var. Until that env var exists the app
 * intentionally still processes Stripe events unsigned (so local tests and
 * the staged deploy work); see the warning logged by the webhook router.
 *
 * Timestamp tolerance: 300 s (5 min), covering Stripe's own clock-skew advice
 * and webhook retries without accepting stale replays.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_TOLERANCE_MS = 300_000; // 5 minutes

/**
 * Verify a Stripe `Stripe-Signature` header against the raw request body.
 *
 * @param {object} opts
 * @param {string} opts.secret   STRIPE_WEBHOOK_SECRET (the `whsec_...` value)
 * @param {string|undefined} opts.header  the raw `Stripe-Signature` header
 * @param {string} opts.payload  the RAW request body string (byte-exact —
 *                               signature verification must run before any
 *                               re-serialization, e.g. from req.rawBody)
 * @param {number} [opts.nowMs]  current epoch ms (injectable for tests)
 * @param {number} [opts.toleranceMs=STRIPE_SIGNATURE_TOLERANCE_MS]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyStripeSignature({
  secret,
  header,
  payload,
  nowMs = Date.now(),
  toleranceMs = STRIPE_SIGNATURE_TOLERANCE_MS,
}) {
  if (typeof secret !== 'string' || secret.trim() === '') {
    return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not configured' };
  }
  if (typeof header !== 'string' || header.trim() === '') {
    return { ok: false, reason: 'missing Stripe-Signature header' };
  }
  // Header shape: `t=<unix-seconds>,v1=<hex[,v0=<hex>...]>`. Only v1 is the
  // current scheme; v0 entries are ignored (Stripe rotates schemes by adding
  // new keys, never by removing old ones from the header immediately).
  const parts = {};
  for (const item of header.split(',')) {
    const eq = item.indexOf('=');
    if (eq === -1) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key && value) parts[key] = value;
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) {
    return { ok: false, reason: 'Stripe-Signature header is missing t= or v1=' };
  }
  if (!/^\d+$/.test(t)) {
    return { ok: false, reason: 'Stripe-Signature timestamp is not an integer' };
  }
  const tsMs = Number(t) * 1000;
  if (Math.abs(nowMs - tsMs) > toleranceMs) {
    return { ok: false, reason: 'Stripe-Signature timestamp is outside the tolerance window' };
  }
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Stripe-Signature v1 does not match the computed signature' };
  }
  return { ok: true };
}