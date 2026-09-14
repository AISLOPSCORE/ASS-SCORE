import express from 'express';
import { openDb } from './db.js';
import { Fetcher } from './fetch/client.js';
import { validateUrl, resolveAndCheck } from './fetch/ssrf.js';
import { scanRouter } from './routes/scan.js';
import { scansRouter } from './routes/scans.js';
import { webhookRouter } from './routes/webhook.js';
import { createEmailSender } from './email.js';

/** The full SSRF guard both routes run before their rate caps (validateUrl +
 *  resolveAndCheck — the Fetcher applies the same checks on every hop). */
const defaultCheckTarget = async (raw) => {
  const url = validateUrl(raw);
  await resolveAndCheck(url);
  return url;
};

/**
 * Build the Express app. Options are injectable for tests:
 *   dbPath          — SQLite file location (default ./data/ass-score.db)
 *   fetcher         — object with fetchHtml(rawUrl) (default: SSRF-protected Fetcher)
 *   webhookDeliverer — async (scan, webhookUrl) => result (default: best-effort
 *                     POST with retries; tests inject a stub)
 *   emailSender     — async (scan, to) => result (default: created by the
 *                     createEmailSender factory — Resend API when
 *                     RESEND_API_KEY is set, else Nodemailer via SMTP_* env
 *                     vars, else a no-op that logs "email not configured";
 *                     tests inject a stub)
 *   scanBudgetMs    — per-scan time budget covering target fetch + discovery
 *                     + additional fetches (default SCAN_BUDGET_MS; tests lower it)
 *   publicBaseUrl   — public origin used for share links and result pages
 *                     (default env PUBLIC_BASE_URL or https://ass-score.com)
 *   now             — ISO timestamp provider (default new Date().toISOString())
 *   maxWebhooksPerDay — per-IP daily cap on POST /api/v1/webhook (default env
 *                     MAX_WEBHOOKS_PER_DAY or 10; 0 disables the cap)
 *   maxScansPerDay  — per-IP daily cap on POST /api/v1/scan (default env
 *                     MAX_SCANS_PER_DAY or 3; 0 disables the cap)
 *   validateTarget  — SSRF guard for scan/webhook targets (default: the same
 *                     validateUrl + resolveAndCheck the Fetcher runs; tests
 *                     inject a DNS-skipping guard)
 *
 * NOTE on client IPs: the app trusts ONE proxy hop (the platform edge, e.g.
 * Railway's LB) and Express then derives the client IP from the last
 * X-Forwarded-For entry, falling back to the socket address when no proxy
 * header is present. Both rate-limit ledgers key on that derivation via
 * src/clientIp.js; without trust proxy, Express ignores X-Forwarded-For and
 * every request would look like the LB's IP, collapsing the per-IP caps.
 */
export function createApp({ dbPath = './data/ass-score.db', fetcher, webhookDeliverer, emailSender, scanBudgetMs, publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://ass-score.com', now, maxWebhooksPerDay, maxScansPerDay, validateTarget } = {}) {
  const db = openDb(dbPath);
  const fetcherImpl = fetcher ?? new Fetcher();
  const emailSenderImpl = emailSender ?? createEmailSender({ publicBaseUrl });
  const nowImpl = now ?? (() => new Date().toISOString());
  const rawMaxWebhooks = maxWebhooksPerDay ?? process.env.MAX_WEBHOOKS_PER_DAY;
  const webhookCap = Number.isFinite(Number(rawMaxWebhooks)) ? Math.max(0, Number(rawMaxWebhooks)) : 10;
  const rawMaxScans = maxScansPerDay ?? process.env.MAX_SCANS_PER_DAY;
  const scanCap = Number.isFinite(Number(rawMaxScans)) ? Math.max(0, Number(rawMaxScans)) : 3;
  const checkTarget = validateTarget ?? defaultCheckTarget;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // platform edge in front; req.ip = real client (XFF / socket)
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ass-score' }));
  app.use(scanRouter({
    db,
    fetcher: fetcherImpl,
    webhookDeliverer,
    emailSender: emailSenderImpl,
    scanBudgetMs,
    now: nowImpl,
    maxScansPerDay: scanCap,
    validateTarget: checkTarget,
  }));
  app.use(webhookRouter({
    db,
    fetcher: fetcherImpl,
    emailSender: emailSenderImpl,
    scanBudgetMs,
    now: nowImpl,
    maxWebhooksPerDay: webhookCap,
    validateTarget: checkTarget,
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