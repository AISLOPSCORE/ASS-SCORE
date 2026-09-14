import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateUrl, resolveAndCheck, SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { normalizeOrder } from '../orderNormalizer.js';
import { validateEmail } from '../email.js';
import { runScan, SCAN_BUDGET_MS } from '../scan.js';
import { toPublicScan } from '../serialize.js';
import { clientIp } from '../clientIp.js';

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
 * Contract:
 *   202 accepted + scan queued (runs async, out of the request path)
 *   400 malformed / unknown provider payload, blocked target, bad email
 *   429 per-IP daily cap exceeded (MAX_WEBHOOKS_PER_DAY, default 10)
 *   500 only on genuine internal errors
 *   Provider event id (when present) is the idempotency key: a replayed event
 *   returns 200 { status: 'already_processed' } and never scans twice.
 *
 * Rate limiting is backed by the SQLite webhook_events ledger (per-IP per-UTC
 * day count) and is independent of any future /api/v1/scan rate limiting.
 */
export function webhookRouter({
  db,
  fetcher,
  emailSender,
  now = () => new Date().toISOString(),
  scanBudgetMs = SCAN_BUDGET_MS,
  maxWebhooksPerDay = 10,
  validateTarget = null, // tests inject a DNS-skipping guard; default = the full fetcher guard
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

  r.post('/api/v1/webhook', async (req, res, next) => {
    try {
      // 1. Provider extraction — fail fast with a reason, never crash.
      const norm = normalizeOrder(req.body);
      if (!norm.ok) {
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
                // PUBLIC scan shape (score flipped, verdict added) — same
                // serialization boundary as POST /api/v1/scan.
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