/**
 * Email delivery of scan reports — best-effort, exactly like webhooks.
 *
 * The scan POST may include an optional `email` address. On completion an
 * email report is sent ASYNCronously, after the 200 response: sending never
 * blocks or fails the scan, failures are retried up to 3 attempts and logged,
 * and the send function never rejects.
 *
 * Transport is injectable (the `emailSender` app option; tests use stubs).
 * The default transport is chosen by env in this precedence order:
 *   1. Resend API — when `RESEND_API_KEY` is set, POST the report to
 *      https://api.resend.com/emails via global fetch (from-address =
 *      `RESEND_FROM` ?? `SMTP_FROM` ?? 'A.S.S. Score <onboarding@resend.dev>').
 *   2. Nodemailer over SMTP — when `SMTP_HOST` is set (unchanged behavior).
 *   3. No-op — when neither is set: logs "email not configured" and returns
 *      { ok: false, configured: false } — the scan still succeeds. This
 *      guarantees nothing breaks before credentials exist. The deploy needs
 *      only `RESEND_API_KEY` (preferred) or `SMTP_*` to turn on real email.
 *
 * SUBJECT DECISION (owner spec: test subject-line variants, keep a fallback).
 * We cannot spam-test without a live SMTP provider, so the default subject is
 * the CONSERVATIVE primary "Your website audit is ready" (deliverability-safe:
 * no emoji, no score, no brand — unlikely to trip filters). The branded
 * variant "Your A.S.S. Score is ready 🔴" is available and selectable via
 * EMAIL_SUBJECT / the emailSubject app option, ready to swap in once the team
 * inbox can A/B test against real delivery.
 */

import { DISCLAIMER } from './card.js';
import { verdictFor } from './verdict.js';
import { createReportToken, reportSecret } from './paywall.js';
import nodemailer from 'nodemailer';

/** Conservative default primary — deliverability-safe, no emoji/brand tokens. */
export const DEFAULT_SUBJECT = 'Your website audit is ready';
/** Branded variant, ready to select once real SMTP allows spam-testing. */
export const ASS_SCORE_SUBJECT = 'Your A.S.S. Score is ready 🔴';

const DEFAULT_FROM = 'A.S.S. Score <no-reply@ass-score.com>';
/** Resend's sandbox from-address — real sending requires a verified domain. */
export const RESEND_DEFAULT_FROM = 'A.S.S. Score <onboarding@resend.dev>';
/** Resend API endpoint — consumed with Node's global fetch (no SDK). */
export const RESEND_API_URL = 'https://api.resend.com/emails';
const MAX_EMAIL_LEN = 254;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Validate an optional email address from a scan request.
 *
 * @param {unknown} value - req.body.email
 * @returns {{ ok: true, email: null | string } | { ok: false, message: string }}
 *   - { ok: true, email: null }  → missing/empty (allowed, no delivery)
 *   - { ok: true, email: string } → normalized address to send to
 *   - { ok: false, message }    → invalid → API must 400 `invalid_email`
 */
export function validateEmail(value) {
  if (value === undefined || value === null) return { ok: true, email: null };
  if (typeof value !== 'string') {
    return { ok: false, message: 'email must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, email: null }; // empty = no delivery
  if (trimmed.length > MAX_EMAIL_LEN) {
    return { ok: false, message: 'email must be at most 254 characters' };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, message: 'email must look like an address, e.g. custodies@example.com' };
  }
  return { ok: true, email: trimmed };
}

function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Build the report email (plain text + simple HTML). All variable content is
 * escaped; the A.S.S. Score brand header, the verdict, and the mandated
 * disclaimer are present in BOTH bodies.
 *
 * PAYWALL: `reportUrl` is the link in the email. The paid path (default, used
 * by the order-fulfillment webhook) passes the token'd full-report URL built
 * by the senders; the free path (POST /api/v1/scan with an optional email)
 * passes the free result-page URL. When omitted, falls back to the legacy
 * public-by-id link (kept for direct callers).
 *
 * @param {{ scan: object, to: string, publicBaseUrl: string, subject?: string,
 *           from?: string, reportUrl?: string, ctaLabel?: string, textLabel?: string }}
 * @returns {{ from: string, to: string, subject: string, text: string, html: string }}
 *
 * `ctaLabel` (HTML button text, default "View full report") and `textLabel`
 * (plain-text line label, default "Full report") describe the link honestly:
 * paid senders keep the full-report framing; free senders pass "View your
 * result" because free-tier recipients only get the free result page.
 */
export function buildReportEmail({ scan, to, publicBaseUrl, subject = DEFAULT_SUBJECT, from = DEFAULT_FROM, reportUrl, ctaLabel = 'View full report', textLabel = 'Full report' }) {
  // The scan payload is the PUBLIC scan shape (`score` 0-100, higher = worse,
  // with a `verdict`); legacy payloads may carry `slopScore` (same direction)
  // — accept both, prefer the public `score`.
  const score = Number(scan.score ?? scan.slopScore);
  const link = reportUrl ?? `${String(publicBaseUrl).replace(/\/+$/, '')}/scan/${scan.id}`;

  const text = [
    'A.S.S. Score — your website audit',
    '',
    `URL scanned: ${scan.url}`,
    `A.S.S. Score: ${score} / 100`,
    `Verdict: ${verdictFor(score)}`,
    '',
    `${textLabel}: ${link}`,
    '',
    '————',
    '',
    DISCLAIMER,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;color:#1a202c">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
        <tr><td style="background:linear-gradient(90deg,#f59e0b,#fbbf24);padding:18px 28px">
          <span style="font-size:20px;font-weight:700;color:#0f172a">A.S.S. Score</span>
          <span style="float:right;font-size:13px;color:#78350f">ass-score.com</span>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">URL scanned</p>
          <p style="margin:0 0 22px;font-size:17px;font-weight:600;color:#1e293b">${esc(scan.url)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#64748b">A.S.S. Score</p>
          <p style="margin:0 0 4px;font-size:40px;font-weight:800;color:#f59e0b">${score} <span style="font-size:18px;color:#94a3b8">/ 100</span></p>
          <p style="margin:0 0 24px;font-size:16px;color:#334155">${esc(verdictFor(score))}</p>
          <p style="margin:0 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#0f172a;color:#f8fafc;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${esc(ctaLabel)}</a></p>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#64748b">${esc(DISCLAIMER)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { from, to, subject, text, html };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The PUBLIC-origin link for a PAID report — the only link shape the site
 * (ass-score.com) can serve. The backend's own /api/v1/report/:id path is NOT
 * routed by the public origin (verified live 2026-09-28: www.ass-score.com
 * 404s it), while the site's TanStack route /report/:scanId (report.$scanId.tsx)
 * proxies/iframes the backend at `${API_BASE}/api/v1/report/:id?token=…`.
 * The buyer's emailed link MUST therefore be `${publicBaseUrl}/report/…`
 * (owner-approved cleanup). Keeps buildReportUrl (src/paywall.js) untouched —
 * that API shape is still the orders verify-RESPONSE contract; the site's
 * toProxyPath regex-matches it and strips the host, so that response must not
 * change.
 *
 * @param {string} publicBaseUrl e.g. https://www.ass-score.com
 * @param {string} scanId
 * @param {string} token report token (`v1.<hex>`)
 * @returns {string} `${publicBaseUrl}/report/${encodeURIComponent(scanId)}?token=${encodeURIComponent(token)}`
 */
export function buildSiteReportUrl(publicBaseUrl, scanId, token) {
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/report/${encodeURIComponent(scanId)}?token=${encodeURIComponent(token)}`;
}

/**
 * Build a Resend API email sender (global fetch — no SDK dependency).
 *
 * POSTs the report to https://api.resend.com/emails with
 * `Authorization: Bearer <apiKey>` and JSON body `{ from, to, subject, html }`.
 * Same soft-fail contract as the SMTP sender: never rejects, retries
 * transient failures (5xx / network) up to maxAttempts with the same backoff,
 * and gives up immediately on 4xx (a client-side rejection retrying would
 * never succeed — webhook-deliverer convention).
 *
 * @param {object} opts
 * @param {string} opts.apiKey            Resend API key (REQUIRED)
 * @param {string} [opts.from]            sender ("Name <email@verified-domain>")
 * @param {string} [opts.subject]         subject line (default env EMAIL_SUBJECT
 *                                        or DEFAULT_SUBJECT)
 * @param {string} [opts.publicBaseUrl]   public origin the paid /report/<scanId>
 *                                        email link is built on (site route)
 * @param {string} [opts.reportBaseUrl]   RETAINED for call-site compatibility
 *                                        only — NO LONGER affects the emailed
 *                                        link (owner-approved: emailed links
 *                                        must point at the PUBLIC site origin)
 * @param {object} [opts.logger]          logger with .log/.error (default console)
 * @param {number} [opts.maxAttempts=3]   total attempts
 * @param {number[]} [opts.backoffMs]     delay before attempts 2, 3, ...
 * @param {Function} [opts.fetchImpl]     fetch to use (default globalThis.fetch)
 * @returns {(scan: object, to: string) => Promise<{ok: boolean, configured: boolean,
 *           attempts?: number, error?: Error}>} — never rejects
 */
export function createResendSender({
  apiKey,
  from = RESEND_DEFAULT_FROM,
  subject = process.env.EMAIL_SUBJECT || DEFAULT_SUBJECT,
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://ass-score.com',
  reportBaseUrl,
  reportTokenSecret,
  logger = console,
  maxAttempts = 3,
  backoffMs = [1_000, 3_000, 9_000],
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    // Programming error — the factory guards this; never reachable in prod.
    throw new Error('createResendSender requires a non-empty apiKey');
  }
  const secret = reportTokenSecret ?? reportSecret(process.env, logger);
  return async function sendScanEmailViaResend(scan, to, opts = {}) {
    if (!scan || typeof scan.id !== 'string') {
      logger.error(`[email] send to ${to} aborted: payload is not a scan result`);
      return { ok: false, configured: true, attempts: 0, error: new Error('missing scan payload') };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = backoffMs[attempt - 2] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }
      try {
        // PAYWALL: paid (default) -> token'd full-report link on the PUBLIC
        // site origin (/report/<scanId>, the site's proxy route — the backend
        // /api/v1/report path 404s on the public domain); free -> the free
        // result page (/scan/<scanId> — the site route the public origin
        // actually serves; /api/v1/scans/<id> is backend-only and 404s on
        // www). The token is HMAC'd to this scan id + secret. Free senders
        // also label the CTA honestly ("View your result").
        const reportUrl = opts.free
          ? `${String(publicBaseUrl).replace(/\/+$/, '')}/scan/${scan.id}`
          : buildSiteReportUrl(publicBaseUrl, scan.id, createReportToken(secret, scan.id));
        const mail = buildReportEmail({
          scan,
          to,
          publicBaseUrl,
          subject,
          from,
          reportUrl,
          ...(opts.free ? { ctaLabel: 'View your result', textLabel: 'View your result' } : {}),
        });
        const response = await fetchImpl(RESEND_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: mail.from,
            to: mail.to,
            subject: mail.subject,
            html: mail.html,
          }),
        });
        const status = Number(response?.status);
        if (status >= 200 && status < 300) {
          return { ok: true, configured: true, attempts: attempt };
        }
        if (status >= 400 && status < 500) {
          // Client error — permanent rejection; retrying cannot change it.
          const err = new Error(`Resend rejected the email with HTTP ${status} (4xx is not retried)`);
          logger.error(
            `[email] delivery to ${to} for scan ${scan.id} rejected by Resend: HTTP ${status} (attempt ${attempt}/${maxAttempts})`
          );
          return { ok: false, configured: true, attempts: attempt, error: err };
        }
        // 5xx (or unknown) — transient; fall through to the retry loop.
        throw new Error(`Resend returned HTTP ${status}`);
      } catch (err) {
        lastError = err;
        logger.error(
          `[email] delivery to ${to} for scan ${scan.id} failed: ${err?.message ?? err} (attempt ${attempt}/${maxAttempts})`
        );
      }
    }
    return { ok: false, configured: true, attempts: maxAttempts, error: lastError };
  };
}

/**
 * Build the email sender (function injectable into the app). Transport factory
 * with explicit precedence:
 *
 *   1. Resend API — env `RESEND_API_KEY` set → POST to api.resend.com via
 *      global fetch (from = RESEND_FROM ?? SMTP_FROM ?? RESEND_DEFAULT_FROM).
 *   2. SMTP        — env `SMTP_HOST` set → Nodemailer (unchanged behavior).
 *   3. no-op       — otherwise; logs "email not configured", skips delivery.
 *
 * @param {object} [opts]
 * @param {string} [opts.subject]           subject line (default env EMAIL_SUBJECT
 *                                          or DEFAULT_SUBJECT)
 * @param {string} [opts.publicBaseUrl]     public origin the paid /report/<scanId>
 *                                          email link is built on (site route)
 * @param {string} [opts.reportBaseUrl]     RETAINED for call-site compatibility
 *                                          only — NO LONGER affects the emailed
 *                                          link (owner-approved: emailed links
 *                                          must point at the PUBLIC site origin)
 * @param {string} [opts.from]              sender override (default per transport:
 *                                          Resend → RESEND_FROM ?? SMTP_FROM ?? RESEND_DEFAULT_FROM;
 *                                          SMTP → SMTP_FROM ?? DEFAULT_FROM)
 * @param {object} [opts.env]               env to read RESEND_* and SMTP_* vars from (default process.env)
 * @param {object} [opts.logger]            logger with .log/.error (default console)
 * @param {number} [opts.maxAttempts=3]     total attempts
 * @param {number[]} [opts.backoffMs]       delay before attempts 2, 3, ...
 * @param {object} [opts.transport]         injected Nodemailer transporter (SMTP path only)
 * @param {Function} [opts.fetchImpl]       injected fetch (Resend path only; default globalThis.fetch)
 * @returns {(scan: object, to: string) => Promise<{ok: boolean, configured: boolean,
 *           attempts?: number, error?: Error}>}
 *
 * Never rejects. Without any credentials the returned sender is a no-op that
 * logs "email not configured" and returns { ok: false, configured: false }.
 */
export function createEmailSender({
  subject = process.env.EMAIL_SUBJECT || DEFAULT_SUBJECT,
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://ass-score.com',
  reportBaseUrl,
  reportTokenSecret,
  from,
  env = process.env,
  logger = console,
  maxAttempts = 3,
  backoffMs = [1_000, 3_000, 9_000],
  transport = null, // tests inject a fake transporter; default = Nodemailer (SMTP path)
  fetchImpl = globalThis.fetch, // tests inject a fake fetch (Resend path)
} = {}) {
  const resendApiKey = (env.RESEND_API_KEY || '').trim();

  // 1) Resend takes precedence over SMTP whenever a key is present.
  if (resendApiKey) {
    const resendFrom = from ?? env.RESEND_FROM ?? env.SMTP_FROM ?? RESEND_DEFAULT_FROM;
    if (!env.RESEND_FROM && !env.SMTP_FROM) {
      // No explicit from-domain — flag it so the lead configures a real one.
      const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
      warn(
        `[email] RESEND_API_KEY set but no from-address configured — using default "${RESEND_DEFAULT_FROM}". ` +
          'Verify a real sending domain with Resend and set RESEND_FROM before production sends.'
      );
    }
    return createResendSender({
      apiKey: env.RESEND_API_KEY,
      from: resendFrom,
      subject,
      publicBaseUrl,
      reportBaseUrl,
      reportTokenSecret,
      logger,
      maxAttempts,
      backoffMs,
      fetchImpl,
    });
  }

  const smtpHost = (env.SMTP_HOST || '').trim();

  if (!smtpHost) {
    // No credentials yet -> harmless no-op; the scan still succeeds.
    return async function sendScanEmailNoop(scan) {
      logger.log(
        `[email] email not configured (set RESEND_API_KEY, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM); skipping delivery for scan ${scan?.id ?? '?'}`
      );
      return { ok: false, configured: false };
    };
  }
  // 2) SMTP via Nodemailer — behavior unchanged apart from the paywall link.
  const port = Number(env.SMTP_PORT) || (String(env.SMTP_SECURE) === 'true' ? 465 : 587);
  const secure = String(env.SMTP_SECURE) === 'true' || port === 465;
  const user = env.SMTP_USER || '';
  const pass = env.SMTP_PASS || '';
  const smtpFrom = from ?? env.SMTP_FROM ?? DEFAULT_FROM;
  const secret = reportTokenSecret ?? reportSecret(env, logger);
  const transporter = transport ?? nodemailer.createTransport({
    host: smtpHost,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });

  return async function sendScanEmail(scan, to, opts = {}) {
    if (!scan || typeof scan.id !== 'string') {
      logger.error(`[email] send to ${to} aborted: payload is not a scan result`);
      return { ok: false, configured: true, attempts: 0, error: new Error('missing scan payload') };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = backoffMs[attempt - 2] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }
      try {
        // PAYWALL: paid (default) -> token'd full-report link on the PUBLIC
        // site origin (/report/<scanId>, the site's proxy route — the backend
        // /api/v1/report path 404s on the public domain); free -> the free
        // result page (/scan/<scanId> — see the Resend path above). The token
        // is HMAC'd to this scan id + secret. Free senders also label the CTA
        // honestly ("View your result").
        const reportUrl = opts.free
          ? `${String(publicBaseUrl).replace(/\/+$/, '')}/scan/${scan.id}`
          : buildSiteReportUrl(publicBaseUrl, scan.id, createReportToken(secret, scan.id));
        const mail = buildReportEmail({
          scan,
          to,
          publicBaseUrl,
          subject,
          from: smtpFrom,
          reportUrl,
          ...(opts.free ? { ctaLabel: 'View your result', textLabel: 'View your result' } : {}),
        });
        await transporter.sendMail(mail);
        return { ok: true, configured: true, attempts: attempt };
      } catch (err) {
        lastError = err;
        logger.error(
          `[email] delivery to ${to} for scan ${scan.id} failed: ${err?.message ?? err} (attempt ${attempt}/${maxAttempts})`
        );
      }
    }
    return { ok: false, configured: true, attempts: maxAttempts, error: lastError };
  };
}