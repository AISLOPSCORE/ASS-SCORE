/**
 * Email delivery of scan reports — best-effort, exactly like webhooks.
 *
 * The scan POST may include an optional `email` address. On completion an
 * email report is sent ASYNCronously, after the 200 response: sending never
 * blocks or fails the scan, failures are retried up to 3 attempts and logged,
 * and the send function never rejects.
 *
 * Transport is injectable (the `emailSender` app option; tests use stubs).
 * The default transport is Nodemailer configured from SMTP_* env vars. When
 * SMTP_HOST is NOT set, the default sender is a no-op that logs
 * "email not configured" and returns { ok: false, configured: false } — the
 * scan still succeeds. This guarantees nothing breaks before credentials
 * exist. SMTP_* is the ONLY thing the deploy needs to turn on real email.
 *
 * SUBJECT DECISION (owner spec: test subject-line variants, keep a fallback).
 * We cannot spam-test without a live SMTP provider, so the default subject is
 * the CONSERVATIVE primary "Your website audit is ready" (deliverability-safe:
 * no emoji, no score, no brand — unlikely to trip filters). The branded
 * variant "Your A.S.S. Score is ready 🔴" is available and selectable via
 * EMAIL_SUBJECT / the emailSubject app option, ready to swap in once the team
 * inbox can A/B test against real delivery.
 */

import { DISCLAIMER, verdictFor } from './card.js';
import nodemailer from 'nodemailer';

/** Conservative default primary — deliverability-safe, no emoji/brand tokens. */
export const DEFAULT_SUBJECT = 'Your website audit is ready';
/** Branded variant, ready to select once real SMTP allows spam-testing. */
export const ASS_SCORE_SUBJECT = 'Your A.S.S. Score is ready 🔴';

const DEFAULT_FROM = 'A.S.S. Score <no-reply@ass-score.com>';
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
 * @param {{ scan: object, to: string, publicBaseUrl: string, subject?: string, from?: string }}
 * @returns {{ from: string, to: string, subject: string, text: string, html: string }}
 */
export function buildReportEmail({ scan, to, publicBaseUrl, subject = DEFAULT_SUBJECT, from = DEFAULT_FROM }) {
  // The scan payload carries `slopScore`; stored rows use `score`. Accept both.
  const score = Number(scan.slopScore ?? scan.score);
  const reportUrl = `${String(publicBaseUrl).replace(/\/+$/, '')}/scan/${scan.id}`;

  const text = [
    'A.S.S. Score — your website audit',
    '',
    `URL scanned: ${scan.url}`,
    `A.S.S. Score: ${score} / 100`,
    `Verdict: ${verdictFor(score)}`,
    '',
    `Full report: ${reportUrl}`,
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
          <p style="margin:0 0 8px"><a href="${esc(reportUrl)}" style="display:inline-block;background:#0f172a;color:#f8fafc;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">View full report</a></p>
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
 * Build the email sender (function injectable into the app).
 *
 * @param {object} [opts]
 * @param {string} [opts.subject]           subject line (default env EMAIL_SUBJECT
 *                                          or DEFAULT_SUBJECT)
 * @param {string} [opts.publicBaseUrl]     report-link base
 * @param {string} [opts.from]              sender (default env SMTP_FROM or
 *                                          'A.S.S. Score <no-reply@ass-score.com>')
 * @param {object} [opts.env]               env to read SMTP_* from (default process.env)
 * @param {object} [opts.logger]            logger with .log/.error (default console)
 * @param {number} [opts.maxAttempts=3]     total attempts
 * @param {number[]} [opts.backoffMs]       delay before attempts 2, 3, ...
 * @returns {(scan: object, to: string) => Promise<{ok: boolean, configured: boolean,
 *           attempts?: number, error?: Error}>}
 *
 * Never rejects. Without SMTP_HOST the returned sender is a no-op that logs
 * "email not configured" and returns { ok: false, configured: false }.
 */
export function createEmailSender({
  subject = process.env.EMAIL_SUBJECT || DEFAULT_SUBJECT,
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://ass-score.com',
  from = process.env.SMTP_FROM || DEFAULT_FROM,
  env = process.env,
  logger = console,
  maxAttempts = 3,
  backoffMs = [1_000, 3_000, 9_000],
  transport = null, // tests inject a fake transporter; default = Nodemailer
} = {}) {
  const smtpHost = (env.SMTP_HOST || '').trim();

  if (!smtpHost) {
    // No credentials yet -> harmless no-op; the scan still succeeds.
    return async function sendScanEmailNoop(scan) {
      logger.log(
        `[email] email not configured (set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM); skipping delivery for scan ${scan?.id ?? '?'}`
      );
      return { ok: false, configured: false };
    };
  }

  const port = Number(env.SMTP_PORT) || (String(env.SMTP_SECURE) === 'true' ? 465 : 587);
  const secure = String(env.SMTP_SECURE) === 'true' || port === 465;
  const user = env.SMTP_USER || '';
  const pass = env.SMTP_PASS || '';
  const transporter = transport ?? nodemailer.createTransport({
    host: smtpHost,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });

  return async function sendScanEmail(scan, to) {
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
        const mail = buildReportEmail({ scan, to, publicBaseUrl, subject, from });
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