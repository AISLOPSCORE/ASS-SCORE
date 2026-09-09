import express from 'express';
import { openDb } from './db.js';
import { Fetcher } from './fetch/client.js';
import { scanRouter } from './routes/scan.js';
import { scansRouter } from './routes/scans.js';
import { webhookRouter } from './routes/webhook.js';
import { createEmailSender } from './email.js';

/**
 * Build the Express app. Options are injectable for tests:
 *   dbPath          — SQLite file location (default ./data/ass-score.db)
 *   fetcher         — object with fetchHtml(rawUrl) (default: SSRF-protected Fetcher)
 *   webhookDeliverer — async (scan, webhookUrl) => result (default: best-effort
 *                     POST with retries; tests inject a stub)
 *   emailSender     — async (scan, to) => result (default: Nodemailer via
 *                     SMTP_* env vars, or a no-op that logs "email not
 *                     configured" when SMTP_HOST is absent; tests inject a stub)
 *   scanBudgetMs    — per-scan time budget covering target fetch + discovery
 *                     + additional fetches (default SCAN_BUDGET_MS; tests lower it)
 *   publicBaseUrl   — public origin used for share links and result pages
 *                     (default env PUBLIC_BASE_URL or https://ass-score.com)
 *   now             — ISO timestamp provider (default new Date().toISOString())
 *   maxWebhooksPerDay — per-IP daily cap on POST /api/v1/webhook (default env
 *                     MAX_WEBHOOKS_PER_DAY or 10; 0 disables the cap)
 *   validateTarget  — SSRF guard for webhook order targets (default: the same
 *                     validateUrl + resolveAndCheck the Fetcher runs)
 */
export function createApp({ dbPath = './data/ass-score.db', fetcher, webhookDeliverer, emailSender, scanBudgetMs, publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://ass-score.com', now, maxWebhooksPerDay, validateTarget } = {}) {
  const db = openDb(dbPath);
  const fetcherImpl = fetcher ?? new Fetcher();
  const emailSenderImpl = emailSender ?? createEmailSender({ publicBaseUrl });
  const nowImpl = now ?? (() => new Date().toISOString());
  const rawMax = maxWebhooksPerDay ?? process.env.MAX_WEBHOOKS_PER_DAY;
  const webhookCap = Number.isFinite(Number(rawMax)) ? Math.max(0, Number(rawMax)) : 10;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ass-score' }));
  app.use(scanRouter({ db, fetcher: fetcherImpl, webhookDeliverer, emailSender: emailSenderImpl, scanBudgetMs, now: nowImpl }));
  app.use(webhookRouter({
    db,
    fetcher: fetcherImpl,
    emailSender: emailSenderImpl,
    scanBudgetMs,
    now: nowImpl,
    maxWebhooksPerDay: webhookCap,
    validateTarget,
  }));
  app.use(scansRouter({ db, publicBaseUrl }));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  // Centralized error handler — no stack traces or internals reach clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    console.error('[ass-score] unhandled error:', err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}