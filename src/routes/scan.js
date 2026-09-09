import { Router } from 'express';
import { validateWebhookUrl, createWebhookDeliverer } from '../webhook.js';
import { validateBranding } from '../branding.js';
import { validateEmail } from '../email.js';
import { runScan, SCAN_BUDGET_MS } from '../scan.js';

/**
 * POST /api/v1/scan
 * Body: { "url": "https://example.com", "webhookUrl"?: "https://hooks.example.com/x",
 *         "branding"?: { agencyName?, logoUrl?, accentColor?, footerText? },
 *         "email"?: "owner@example.com" }
 *
 * Thin route wrapper around the shared `runScan` pipeline (src/scan.js) — the
 * same pipeline `POST /api/v1/webhook` uses for paid-order fulfillment. This
 * route owns the request-shape validation (fail fast, BEFORE any network I/O)
 * and the async best-effort webhook/email delivery; runScan owns fetching,
 * rules, scoring, and SQLite persistence.
 *
 * Response shape is unchanged from v1 (id, url, slopScore, breakdown,
 * createdAt) plus `pages`, `partial`, `note`, `worstPage` when multi-page,
 * plus `branding` when white-label branding was supplied and `roast` (Slop
 * Roast) on every scan.
 * The webhook payload is the exact response object. The email (if requested)
 * is delivered async + best-effort exactly like webhooks: failures are logged,
 * never propagated to the caller.
 */
export function scanRouter({ db, fetcher, now = () => new Date().toISOString(), webhookDeliverer, emailSender, scanBudgetMs = SCAN_BUDGET_MS }) {
  const r = Router();
  const deliver = webhookDeliverer ?? createWebhookDeliverer();

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

      // Optional delivery email. Invalid values are a 400 BEFORE scanning.
      const mail = validateEmail(req.body?.email);
      if (!mail.ok) {
        return res.status(400).json({ error: { code: 'invalid_email', message: mail.message } });
      }

      const result = await runScan({
        db,
        fetcher,
        url,
        branding: branding.branding,
        now,
        scanBudgetMs,
      });
      if (!result.ok) {
        return res.status(result.status).json(result.json);
      }

      const { payload } = result;
      const id = payload.id;

      if (webhook.url) {
        // Best-effort, non-blocking: defer delivery out of the request path.
        setImmediate(async () => {
          try {
            await deliver(payload, webhook.url);
          } catch (err) {
            console.error(`[webhook] delivery to ${webhook.url} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      if (mail.email && emailSender) {
        // Best-effort, non-blocking: same semantics as webhooks. The sender
        // never rejects (missing SMTP config logs a no-op), so the response
        // below is never affected.
        setImmediate(async () => {
          try {
            await emailSender(payload, mail.email);
          } catch (err) {
            console.error(`[email] delivery to ${mail.email} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      res.status(200).json(payload);
    } catch (err) {
      next(err); // centralized error handler; never leaks stack traces
    }
  });

  return r;
}