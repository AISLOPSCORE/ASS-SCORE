import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateWebhookUrl, createWebhookDeliverer } from '../webhook.js';
import { validateBranding } from '../branding.js';
import { validateEmail } from '../email.js';
import { runScan, SCAN_BUDGET_MS } from '../scan.js';
import { toPublicScan } from '../serialize.js';
import { buildFreePayload } from '../paywall.js';
import { validateUrl, resolveAndCheck, SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { clientIp } from '../clientIp.js';

/**
 * POST /api/v1/scan
 * Body: { "url": "https://example.com", "webhookUrl"?: "https://hooks.example.com/x",
 *         "branding"?: { agencyName?, logoUrl?, accentColor?, footerText? },
 *         "email"?: "owner@example.com", "clientEmail"?: "owner@example.com",
 *         "businessName"?: "Acme Inc" }
 *
 * Thin route wrapper around the shared `runScan` pipeline (src/scan.js) — the
 * same pipeline `POST /api/v1/webhook` uses for paid-order fulfillment. This
 * route owns the request-shape validation (fail fast, BEFORE any network I/O),
 * the per-IP daily rate cap, and the async best-effort webhook/email delivery;
 * runScan owns fetching, rules, scoring, and SQLite persistence.
 *
 * Rate limiting mirrors POST /api/v1/webhook exactly: the SSRF guard and every
 * shape validation run BEFORE the cap is consulted, so 400s never consume
 * quota; an accepted request (guard passed) is ledgered in the scan_events
 * table (per-IP per-UTC-day, independent of the webhook cap) with no await
 * between the count check and the insert, then scanned. Over the cap → 429
 * with `resetAt` (next UTC midnight). Ledger rows are marked 'completed' with
 * the scan id on success, 'failed' on scan failure — never double-counted by
 * the best-effort webhook/email delivery paths.
 *
 * Response shape (PAYWALL — free tier): PUBLIC scan JSON — id, url, score
 * (0-100, higher = worse, 0 = clean, 100 = maximum ass), verdict (grade
 * label), breakdown (per-category scores as NUMBERS, in the same direction),
 * createdAt, `roast` on every scan, plus `teasers` (1-2 three-layer findings —
 * randomized per scan via the scan-id seed), the mandated `disclaimer`, and
 * `partial`/`note` when the scan was partial. The FULL findings/insights are
 * the paid content: delivered only by the token'd report link emailed after
 * the $12 checkout (see src/paywall.js + src/routes/scans.js).
 * Engine scores and the DB row are already in the public direction (higher =
 * more slop); the serialization boundary (see src/serialize.js) only relabels
 * and the webhook payload + email carry the same gated public object.
 */
export function scanRouter({
  db,
  fetcher,
  now = () => new Date().toISOString(),
  webhookDeliverer,
  emailSender,
  scanBudgetMs = SCAN_BUDGET_MS,
  maxScansPerDay = 3,
  validateTarget = null, // tests inject a DNS-skipping guard; default = the full fetcher guard
}) {
  const r = Router();
  const deliver = webhookDeliverer ?? createWebhookDeliverer();

  // The EXACT same SSRF guard the webhook route (and the Fetcher) applies on
  // every request hop: validateUrl (protocol/hostname/banned-host/literal-IP
  // checks) then resolveAndCheck (any resolved address in a blocked range ->
  // refuse). Runs BEFORE the rate cap so blocked targets never consume quota.
  const checkTarget = validateTarget ?? (async (raw) => {
    const url = validateUrl(raw);
    await resolveAndCheck(url);
    return url;
  });

  /** Next UTC midnight — when a fresh daily bucket opens. */
  const nextUtcMidnight = (iso) => {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
    return new Date(d.getTime() + 86_400_000).toISOString();
  };

  r.post('/api/v1/scan', async (req, res, next) => {
    try {
      const url = req.body?.url;
      if (typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({
          error: { code: 'invalid_request', message: 'Request body must be JSON of the form { "url": "https://example.com" }' },
        });
      }

      // Optional callback URL. Invalid values are a 400 BEFORE scanning (fail fast).
      // Missing / empty is allowed and means "no webhook delivery".
      const webhook = validateWebhookUrl(req.body?.webhookUrl);
      if (!webhook.ok) {
        return res.status(400).json({ error: { code: 'invalid_webhook_url', message: webhook.message } });
      }

      // Optional white-label branding. Invalid values are a 400 BEFORE scanning.
      const branding = validateBranding(req.body?.branding);
      if (!branding.ok) {
        return res.status(400).json({ error: { code: 'invalid_branding', message: branding.message } });
      }

      // Optional business name (spec parity — the same field the webhook order
      // flow normalizes). Stored on the scan row; a non-string value is a 400
      // BEFORE scanning. Missing / empty-after-trim = not stored.
      const rawBusiness = req.body?.businessName;
      if (rawBusiness !== undefined && rawBusiness !== null && typeof rawBusiness !== 'string') {
        return res.status(400).json({ error: { code: 'invalid_business_name', message: 'businessName must be a string when supplied' } });
      }
      const businessName = typeof rawBusiness === 'string' && rawBusiness.trim() !== '' ? rawBusiness.trim() : null;

      // Optional delivery email. `clientEmail` is the spec alias for `email`
      // (both name the report-link recipient); the documented `email` field
      // wins when both are supplied. Invalid values are a 400 BEFORE scanning.
      const mail = validateEmail(req.body?.email ?? req.body?.clientEmail);
      if (!mail.ok) {
        return res.status(400).json({ error: { code: 'invalid_email', message: mail.message } });
      }

      // SSRF guard BEFORE the rate cap: blocked/invalid targets are rejected
      // here (same shape runScan would produce) without consuming quota.
      let target;
      try {
        target = await checkTarget(url);
      } catch (err) {
        if (err instanceof SsrfError || err instanceof InvalidUrlError) {
          return res.status(400).json({ error: { code: 'blocked', message: err.message } });
        }
        throw err;
      }

      // Per-IP daily cap (SQLite ledger, independent of the webhook cap).
      const ip = clientIp(req);
      const createdAt = now();
      const day = createdAt.slice(0, 10); // UTC day bucket for the rate cap
      if (maxScansPerDay > 0) {
        const used = db.countScanEvents(day, ip);
        if (used >= maxScansPerDay) {
          return res.status(429).json({
            error: {
              code: 'rate_limited',
              message: `Daily scan limit reached for this IP (${maxScansPerDay} scans per day). New scans unlock at UTC midnight.`,
              resetAt: nextUtcMidnight(createdAt),
            },
          });
        }
      }

      // Ledger the scan BEFORE running it (single-process synchronous insert,
      // adjacent to the count check above = race-free, per the webhook ledger
      // convention). Accepted = guard passed + ledgered; a scan that then
      // fails is marked 'failed' but the accepted request keeps its slot —
      // exactly like webhook events that fail post-acceptance.
      const eventKey = randomUUID();
      db.insertScanEvent({ eventKey, ip, day, createdAt });

      const result = await runScan({
        db,
        fetcher,
        url: target.href,
        branding: branding.branding,
        businessName,
        now,
        scanBudgetMs,
      });
      if (!result.ok) {
        db.markScanEvent(eventKey, { status: 'failed', scanId: null });
        return res.status(result.status).json(result.json);
      }

      const { payload } = result;
      // PUBLIC shape at the serialization boundary: runScan computes + stores
      // the slop score (higher = worse, 0 = clean); the response, webhook
      // delivery and email all carry the same score unchanged (higher =
      // worse), the verdict label, and per-category scores in the same
      // direction. The DB row needs no migration — engine == public.
      const pub = toPublicScan(payload);
      // PAYWALL: the free tier response is the gated payload — score, verdict,
      // roast, category NUMBERS, 1-2 teasers, disclaimer. The full findings
      // (paid content) stay in the DB and in the token'd report only. The
      // webhook callback gets the same gated payload (identical semantics).
      const freePub = buildFreePayload(pub);
      const id = payload.id;
      db.markScanEvent(eventKey, { status: 'completed', scanId: id });

      if (webhook.url) {
        // Best-effort, non-blocking: defer delivery out of the request path.
        setImmediate(async () => {
          try {
            await deliver(freePub, webhook.url);
          } catch (err) {
            console.error(`[webhook] delivery to ${webhook.url} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      if (mail.email && emailSender) {
        // Best-effort, non-blocking: same semantics as webhooks. The sender
        // never rejects (missing SMTP config logs a no-op), so the response
        // below is never affected. FREE tier: the email carries the free
        // result-page link — never the paid content — and the sender sees the
        // EXACT same gated payload the response returns (no full findings).
        setImmediate(async () => {
          try {
            await emailSender(freePub, mail.email, { free: true });
          } catch (err) {
            console.error(`[email] delivery to ${mail.email} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      res.status(200).json(freePub);
    } catch (err) {
      next(err); // centralized error handler; never leaks stack traces
    }
  });

  return r;
}