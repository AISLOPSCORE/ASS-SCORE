import express from 'express';
import { openDb } from './db.js';
import { Fetcher } from './fetch/client.js';
import { validateUrl, resolveAndCheck } from './fetch/ssrf.js';
import { scanRouter } from './routes/scan.js';
import { scansRouter } from './routes/scans.js';
import { webhookRouter } from './routes/webhook.js';
import { orderIntentRouter } from './routes/orderIntent.js';
import { ordersRouter } from './routes/orders.js';
import { trackRouter } from './routes/track.js';
import { adminRouter } from './routes/admin.js';
import { createEmailSender } from './email.js';
import { reportSecret } from './paywall.js';
import { createCors } from './cors.js';
import { runRetention } from './retention.js';

/** Retention job cadence (owner-approved 2026-09-23): every 24h. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
 *   adminPassword — password for the private GET /admin/stats page (default:
 *                     env ADMIN_PASSWORD; unset => the route is disabled/403).
 *                     Injectable so the test suite can pin a secret; never
 *                     passed through the public API.
 *   now             — ISO timestamp provider (default new Date().toISOString())
 *   maxWebhooksPerDay — per-IP daily cap on POST /api/v1/webhook (default env
 *                     MAX_WEBHOOKS_PER_DAY or 10; 0 disables the cap)
 *   maxScansPerDay  — per-IP daily cap on POST /api/v1/scan (default env
 *                     MAX_SCANS_PER_DAY or 3; 0 disables the cap)
 *   allowedOrigins  — browser origins allowed cross-origin access (default
 *                     env CORS_ORIGINS or the site's known origins; see
 *                     src/cors.js)
 *   validateTarget  — SSRF guard for scan/webhook targets (default: the same
 *                     validateUrl + resolveAndCheck the Fetcher runs; tests
 *                     inject a DNS-skipping guard)
 *   reportTokenSecret — HMAC secret for full-report access tokens (default
 *                     env REPORT_TOKEN_SECRET; when neither is set a random
 *                     per-boot secret is used — emailed links die on restart,
 *                     a warning is logged)
 *   reportBaseUrl   — host for the orders verify-RESPONSE reportUrl ONLY
 *                     (default publicBaseUrl; env REPORT_BASE_URL when unset).
 *                     Emailed PAID-report links are built from publicBaseUrl
 *                     (the PUBLIC site origin — buildSiteReportUrl in
 *                     src/email.js); REPORT_BASE_URL no longer affects those.
 *                     The site's toProxyPath strips the host from the verify
 *                     response anyway, so this value is display-only there.
 *   runRetentionOnBoot — boolean; when true the daily retention sweep
 *                     (src/retention.js — purge scans/scan_events/webhook_events/
 *                     page_views older than 30 days) runs once at app creation
 *                     and then every 24h on an unref()'d timer. Default FALSE
 *                     so test app instances (created repeatedly by the suite)
 *                     never touch fixture rows; the production entrypoint
 *                     (src/server.js) sets it true.
 *
 * NOTE on client IPs: the app trusts ONE proxy hop (the platform edge, e.g.
 * Railway's LB) and Express then derives the client IP from the last
 * X-Forwarded-For entry, falling back to the socket address when no proxy
 * header is present. Both rate-limit ledgers key on that derivation via
 * src/clientIp.js; without trust proxy, Express ignores X-Forwarded-For and
 * every request would look like the LB's IP, collapsing the per-IP caps.
 */
export function createApp({ dbPath = './data/ass-score.db', fetcher, webhookDeliverer, emailSender, scanBudgetMs, publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://www.ass-score.com', now, maxWebhooksPerDay, maxScansPerDay, validateTarget, allowedOrigins, reportTokenSecret, reportBaseUrl, adminPassword, stripeWebhookSecret, stripe, stripeSecretKey, stripePriceId, runRetentionOnBoot = false } = {}) {
  const db = openDb(dbPath);
  const fetcherImpl = fetcher ?? new Fetcher();
  // PAYWALL secret: env REPORT_TOKEN_SECRET, or random per-boot (fail closed —
  // tokens die on restart; reportSecret logs the warning).
  const secret = reportTokenSecret ?? reportSecret(process.env);
  const reportLinkBase = reportBaseUrl ?? process.env.REPORT_BASE_URL ?? publicBaseUrl;
  const emailSenderImpl = emailSender ?? createEmailSender({ publicBaseUrl, reportTokenSecret: secret, reportBaseUrl: reportLinkBase });
  const nowImpl = now ?? (() => new Date().toISOString());
  const rawMaxWebhooks = maxWebhooksPerDay ?? process.env.MAX_WEBHOOKS_PER_DAY;
  const webhookCap = Number.isFinite(Number(rawMaxWebhooks)) ? Math.max(0, Number(rawMaxWebhooks)) : 10;
  const rawMaxScans = maxScansPerDay ?? process.env.MAX_SCANS_PER_DAY;
  const scanCap = Number.isFinite(Number(rawMaxScans)) ? Math.max(0, Number(rawMaxScans)) : 3;
  const checkTarget = validateTarget ?? defaultCheckTarget;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // platform edge in front; req.ip = real client (XFF / socket)
  app.use(createCors({ allowedOrigins })); // browser origins only; no-op for non-browser clients
  // The verify callback stashes the RAW body buffer on req.rawBody — Stripe
  // signature verification needs the byte-exact payload, which the parsed
  // req.body cannot reproduce (whitespace/encoding). Harmless for every other
  // route (one extra property on the request object).
  app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Spec-parity health endpoints: `GET /health` (Railway healthcheckPath) plus
  // the `/api/health` alias — identical 200 JSON contract.
  const health = (_req, res) => res.json({ ok: true, service: 'ass-score' });
  app.get('/health', health);
  app.get('/api/health', health);
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
    stripeWebhookSecret,
  }));
  // Paid-order checkout — full-Stripe flow (owner-approved 2026-09-25):
  // order-intent creates a per-order Checkout Session, /orders/:orderId is
  // the success page's polling read, /orders/:orderId/verify verifies the
  // session DIRECTLY against Stripe (payment_status) for same-session unlock.
  // The webhook route above stays the primary fulfillment mechanism — all
  // three paths share the race-safe markOrderFulfilled + email delivery.
  app.use(orderIntentRouter({
    db,
    now: nowImpl,
    stripe,
    stripeSecretKey,
    stripePriceId,
    publicBaseUrl,
  }));
  app.use(ordersRouter({
    db,
    now: nowImpl,
    stripe,
    stripeSecretKey,
    reportTokenSecret: secret,
    reportBaseUrl: reportLinkBase,
    emailSender: emailSenderImpl,
  }));
  app.use(scansRouter({ db, publicBaseUrl, reportTokenSecret: secret, reportBaseUrl: reportLinkBase, now: nowImpl }));
  // Homepage view tracking + private admin stats (backlog db64a1c9 — owner
  // lifted the hold 2026-09-23). track is a silent beacon; admin is gated on
  // ADMIN_PASSWORD (disabled/403 until the owner sets it on Railway).
  app.use(trackRouter({ db, now: nowImpl }));
  app.use(adminRouter({ db, adminPassword, emailSender: emailSenderImpl, now: nowImpl }));

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

  // Retention job (owner-approved 2026-09-23): purge rows older than 30 days
  // from scans / scan_events / webhook_events. Runs once at boot and then
  // every 24h; the timer is unref()'d so it never holds the process open.
  // better-sqlite3 is synchronous, so the boot run completes before this
  // function returns — listen() only starts after the first sweep.
  // Gated on an explicit option (server.js sets it) so the test suite —
  // which calls createApp() repeatedly — never runs a destructive sweep over
  // fixtures with backdated created_at values.
  app.locals.db = db; // openDb wrapper, for ops/tooling that needs the handle
  if (runRetentionOnBoot) {
    runRetention({ db, now: nowImpl });
    const retentionTimer = setInterval(() => runRetention({ db, now: nowImpl }), RETENTION_INTERVAL_MS);
    retentionTimer.unref();
    // Any future teardown should clearInterval(this handle).
    app.locals.retentionTimer = retentionTimer;
  }

  return app;
}