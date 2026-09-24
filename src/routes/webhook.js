import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateUrl, resolveAndCheck, SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { normalizeOrder, extractStripeSession } from '../orderNormalizer.js';
import { verifyStripeSignature } from '../stripeSignature.js';
import { validateEmail } from '../email.js';
import { runScan, SCAN_BUDGET_MS } from '../scan.js';
import { toPublicScan } from '../serialize.js';
import { clientIp } from '../clientIp.js';

/** 24h window for the email-fallback correlation (pending orders only). */
const ORDER_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/v1/webhook — paid-order fulfillment.
 *
 * Accepts order webhooks from Fiverr / Stripe Checkout / LemonSqueezy,
 * normalizes them into ONE internal shape ({ targetUrl, businessName?,
 * clientEmail? }), validates the target with the exact same SSRF guard the
 * scan endpoint uses, and runs a REAL scan through the shared `runScan`
 * pipeline (src/scan.js). On completion the client is emailed their report
 * link via the existing soft-fail email sender — the webhook response is
 * never blocked or failed by email problems.
 *
 * Stripe PAYMENT-LINK sessions (built 2026-09-25) are handled as a second,
 * order-based path: those sessions carry NO metadata.target_url (the static
 * buy link collects none), so normalizeStripe() fails by design. The route
 * instead correlates the session to a `orders` row (client_reference_id
 * first, then the customer email against pending orders < 24h old), marks it
 * fulfilled, and emails the token'd report link for the order's scan. A
 * session that matches NO pending order (a bare-link purchase) is recorded in
 * `unmatched_orders` for manual fulfillment via POST /admin/deliver and the
 * event still returns 200 — Stripe retries must never see a failure.
 *
 * Stripe signature verification: when STRIPE_WEBHOOK_SECRET is set, every
 * checkout.session.completed event must carry a valid Stripe-Signature header
 * (HMAC-SHA256 over `t.<timestamp>.<raw-body>`, 5 min tolerance) — 401 on
 * failure. Until the lead sets that env var, a warning is logged once at boot
 * and Stripe events are still processed (so local tests and the staged deploy
 * work); Fiverr/LemonSqueezy payloads are unaffected either way.
 *
 * Contract:
 *   202 accepted + scan queued (runs async, out of the request path)
 *   200 fulfilled / already_processed / unmatched — Stripe payment-link flows
 *   400 malformed / unknown provider payload, blocked target, bad email
 *   401 invalid Stripe signature (when the webhook secret is configured)
 *   429 per-IP daily cap exceeded (MAX_WEBHOOKS_PER_DAY, default 10)
 *   500 only on genuine internal errors
 *   Provider event id (when present) is the idempotency key: a replayed event
 *   returns 200 { status: 'already_processed' } and never scans twice.
 *
 * Rate limiting is backed by the SQLite webhook_events ledger (per-IP per-UTC
 * day count) and is independent of any future /api/v1/scan rate limiting.
 * Payment-link events skip that ledger (their idempotency lives in the orders
 * / unmatched_orders tables), so Stripe's egress IPs can never be 429'd out of
 * fulfilling a sale.
 */
export function webhookRouter({
  db,
  fetcher,
  emailSender,
  now = () => new Date().toISOString(),
  scanBudgetMs = SCAN_BUDGET_MS,
  maxWebhooksPerDay = 10,
  validateTarget = null, // tests inject a DNS-skipping guard; default = the full fetcher guard
  stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  logger = console,
}) {
  const r = Router();

  // The EXACT same SSRF guard the Fetcher applies on every request hop:
  // validateUrl (protocol/hostname/banned-host/literal-IP checks) then
  // resolveAndCheck (any resolved address in a blocked range -> refuse).
  const checkTarget = validateTarget ?? (async (raw) => {
    const url = validateUrl(raw);
    await resolveAndCheck(url);
    return url;
  });

  const logError = (...args) => {
    if (typeof logger.error === 'function') logger.error(...args);
    else console.error(...args);
  };

  if (!stripeWebhookSecret) {
    const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn.bind(console);
    warn(
      '[webhook] STRIPE_WEBHOOK_SECRET is not set — Stripe signature verification is DISABLED ' +
        '(checkout.session.completed events are accepted unsigned). Set the env var in production ' +
        'so payment-link webhooks are verified.'
    );
  }

  /**
   * Stripe PAYMENT-LINK fulfillment — the order-based path for
   * checkout.session.completed events that carry NO metadata.target_url.
   * Correlates the session to a pending `orders` row (client_reference_id
   * first, then the customer email within a 24h window), fulfills it, and
   * emails the token'd report link for the order's scan via the EXACT same
   * emailSender the metadata path uses. No pending order matches → the event
   * is recorded in `unmatched_orders` for manual fulfillment and still
   * returns 200 (Stripe retries re-insert nothing thanks to the session-id PK).
   */
  async function handlePaymentLinkSession(res, session) {
    const customerEmail = String(
      session.customer_details?.email ?? session.customer_email ?? ''
    ).trim().toLowerCase();

    // 1. Correlation — client_reference_id (set by our order-intent redirect)
    //    beats the email fallback whenever it exists, and an already-fulfilled
    //    ref match is AUTHORITATIVE: a Stripe retry of a handled event must
    //    never fall through to the email fallback (that could fulfill a
    //    DIFFERENT pending order the same buyer created for a second scan).
    let order = null;
    const ref = typeof session.client_reference_id === 'string' && session.client_reference_id.trim() !== ''
      ? session.client_reference_id.trim()
      : '';
    if (ref) {
      order = db.getOrder(ref);
      if (order?.status === 'fulfilled') {
        return res.status(200).json({ accepted: true, status: 'already_fulfilled', orderId: order.id });
      }
      if (order?.status !== 'pending') order = null; // unknown/voided status
    }
    if (!order && customerEmail) {
      const sinceIso = new Date(Date.parse(now()) - ORDER_EMAIL_WINDOW_MS).toISOString();
      order = db.findPendingOrderByEmail(customerEmail, sinceIso);
    }

    if (!order) {
      // Bare-link purchase (the owner's 09-24 case): no scan id to attach, so
      // support fulfills it manually once the customer names their site.
      const inserted = db.insertUnmatchedOrder({
        sessionId: session.id ?? `unknown-${randomUUID()}`,
        email: customerEmail || null,
        receivedAt: now(),
      });
      logError(
        `[webhook] checkout.session.completed ${session.id ?? '?'} matched no pending order — ` +
          `recorded in unmatched_orders${inserted ? '' : ' (duplicate replay)'}`
      );
      return res.status(200).json({
        accepted: true,
        status: 'unmatched',
        note: 'No pending order matched this checkout; recorded for manual fulfillment.',
      });
    }

    // 2. Fulfill — race-safe: only the FIRST webhook for this order flips the
    //    status, so Stripe retries are idempotent (200 already_fulfilled).
    const fulfilled = db.markOrderFulfilled(order.id, {
      checkoutSessionId: session.id ?? null,
      paidAt: now(),
    });
    if (!fulfilled) {
      return res.status(200).json({ accepted: true, status: 'already_fulfilled', orderId: order.id });
    }

    // 3. Deliver the report — same delivery code path as the metadata flow
    //    (emailSender builds the token'd full-report link; best-effort, never
    //    fails the webhook response). The scan MUST still exist: admin
    //    retention purges scans after 30 days, which would orphan an order.
    const scan = db.getScan(order.scan_id);
    let emailDeliveredTo = null;
    if (!scan) {
      logError(`[webhook] order ${order.id}: scan ${order.scan_id} no longer exists — report email NOT sent`);
    } else if (emailSender) {
      try {
        await emailSender(toPublicScan(scan), order.email);
        emailDeliveredTo = order.email;
      } catch (err) {
        logError(`[webhook] email to ${order.email} for order ${order.id} crashed:`, err?.message ?? err);
      }
    }

    return res.status(200).json({
      accepted: true,
      status: 'fulfilled',
      orderId: order.id,
      scanId: order.scan_id,
      emailDeliveredTo,
    });
  }

  /** The raw request body as the exact byte string Stripe signed. */
  const rawBodyOf = (req) => {
    if (typeof req.rawBody === 'string') return req.rawBody;
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
    return JSON.stringify(req.body ?? {});
  };

  r.post('/api/v1/webhook', async (req, res, next) => {
    try {
      // 0. Stripe signature gate — applies ONLY to checkout.session.completed
      //    events, and ONLY when the webhook secret is configured (the lead
      //    sets STRIPE_WEBHOOK_SECRET after registering the endpoint).
      const stripeSession = extractStripeSession(req.body);
      if (stripeSession?.ok && stripeWebhookSecret) {
        const sig = verifyStripeSignature({
          secret: stripeWebhookSecret,
          header: req.get('stripe-signature'),
          payload: rawBodyOf(req),
        });
        if (!sig.ok) {
          logError(`[webhook] Stripe signature rejected: ${sig.reason}`);
          return res.status(401).json({ error: { code: 'invalid_signature', message: 'Invalid Stripe webhook signature' } });
        }
      }

      // 1. Provider extraction — fail fast with a reason, never crash.
      const norm = normalizeOrder(req.body);

      // A Stripe checkout.session.completed WITHOUT metadata.target_url is the
      // payment-link flow: normalizeStripe intentionally fails, and the event
      // is fulfilled from the orders table instead (no scan to run here — the
      // buyer already scanned the site before checkout).
      if (!norm.ok) {
        if (stripeSession?.ok) return handlePaymentLinkSession(res, stripeSession.session);
        if (stripeSession) {
          return res.status(400).json({ error: { code: 'invalid_payload', message: stripeSession.message } });
        }
        return res.status(400).json({ error: { code: 'invalid_payload', message: norm.message } });
      }

      // 2. Target validation — same SSRF guard as POST /api/v1/scan, reused.
      //    Blocked targets are rejected BEFORE anything is enqueued, so no
      //    event row, no scan, and no rate-limit slot are consumed.
      let target;
      try {
        target = await checkTarget(norm.targetUrl);
      } catch (err) {
        if (err instanceof SsrfError || err instanceof InvalidUrlError) {
          return res.status(400).json({ error: { code: 'blocked', message: err.message } });
        }
        throw err;
      }

      // 3. Client email shape — malformed addresses are a 400 before enqueue
      //    (missing is allowed: the order still scans, email is skipped).
      const mail = validateEmail(norm.clientEmail ?? null);
      if (!mail.ok) {
        return res.status(400).json({ error: { code: 'invalid_email', message: mail.message } });
      }

      const ip = clientIp(req); // shared derivation: X-Forwarded-For (trust proxy) / socket
      const createdAt = now();
      const day = createdAt.slice(0, 10); // UTC day bucket for the rate cap
      const eventKey = norm.eventId ? `${norm.provider}:${norm.eventId}` : randomUUID();

      // 4. Idempotency — a replayed provider event id never scans twice.
      if (norm.eventId) {
        const existing = db.getWebhookEvent(eventKey);
        if (existing) {
          return res.status(200).json({
            accepted: true,
            status: 'already_processed',
            note: 'already processed',
            provider: existing.provider,
            eventId: existing.event_id ?? norm.eventId,
            scanId: existing.scan_id ?? null,
          });
        }
      }

      // 5. Per-IP daily cap (SQLite-backed, independent of scan rate limiting).
      if (maxWebhooksPerDay > 0) {
        const used = db.countWebhookEvents(day, ip);
        if (used >= maxWebhooksPerDay) {
          return res.status(429).json({
            error: {
              code: 'rate_limited',
              message: `Daily webhook limit reached for this IP (${maxWebhooksPerDay} per day). Try again tomorrow.`,
            },
          });
        }
      }

      // 6. Ledger the event BEFORE scanning (single-process synchronous insert
      //    = race-free; INSERT OR IGNORE guards any concurrent duplicate).
      const inserted = db.insertWebhookEvent({
        eventKey,
        provider: norm.provider,
        eventId: norm.eventId ?? null,
        ip,
        day,
        business_name: norm.businessName ?? null,
        payload: req.body,
        createdAt,
        status: 'pending',
      });
      if (!inserted) {
        const existing = db.getWebhookEvent(eventKey);
        return res.status(200).json({
          accepted: true,
          status: 'already_processed',
          note: 'already processed',
          provider: existing?.provider ?? norm.provider,
          eventId: norm.eventId ?? null,
          scanId: existing?.scan_id ?? null,
        });
      }

      // 7. Run the real scan async (same pipeline as /api/v1/scan), then email
      //    the client their report link — best-effort, never blocks the 202.
      setImmediate(async () => {
        let status = 'failed';
        let scanId = null;
        try {
          const result = await runScan({ db, fetcher, url: target.href, branding: null, now, scanBudgetMs });
          if (result.ok) {
            status = 'completed';
            scanId = result.payload.id;
            if (mail.email && emailSender) {
              try {
                // PUBLIC scan shape (score 0-100 higher = worse, verdict
                // added) — same serialization boundary as POST /api/v1/scan.
                await emailSender(toPublicScan(result.payload), mail.email);
              } catch (err) {
                logError(`[webhook] email to ${mail.email} for scan ${scanId} crashed:`, err?.message ?? err);
              }
            }
          } else {
            logError(
              `[webhook] scan for event ${eventKey} failed with HTTP ${result.status} (${result.json?.error?.code ?? 'unknown'}) — ${result.json?.error?.message ?? ''}`
            );
          }
        } catch (err) {
          logError(`[webhook] scan for event ${eventKey} crashed:`, err?.message ?? err);
        } finally {
          try {
            db.markWebhookEvent(eventKey, { status, scanId });
          } catch (err) {
            logError(`[webhook] could not update event ${eventKey} status:`, err?.message ?? err);
          }
        }
      });

      res.status(202).json({
        accepted: true,
        status: 'queued',
        provider: norm.provider,
        eventId: norm.eventId ?? null,
        targetUrl: target.href,
        businessName: norm.businessName ?? null,
        emailDeliveredTo: mail.email,
      });
    } catch (err) {
      next(err); // centralized error handler — 500 on genuine internal errors only
    }
  });

  return r;
}