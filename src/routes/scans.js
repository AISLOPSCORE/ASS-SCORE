import fs from 'node:fs';
import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { selectRoast } from '../roast.js';
import { toPublicScan, publicScore } from '../serialize.js';
import { buildFreePayload, verifyReportToken, DISCLAIMER } from '../paywall.js';
import { isReportExpired } from '../ttl.js';
import { breakdownFor, renderFreeHtmlReport, renderHtmlReport } from '../reportHtml.js';

export { worstPageSummary } from '../reportHtml.js'; // test/reportQuality.test.js imports it from the scans.js path
/**
 * The stored line when the row has one; for rows written before the roast
 * column existed (roast null), derive it deterministically from the stored
 * id + score + breakdown — the same function the scan pipeline used, so the
 * result is identical to what a fresh scan would have stored.
 */
function roastFor(scan) {
  if (typeof scan.roast === 'string' && scan.roast.trim() !== '') return scan.roast;
  return selectRoast({ id: scan.id, slopScore: scan.score, breakdown: scan.breakdown });
}


/**
 * GET /api/v1/scans/:id — fetch a stored scan.
 *
 * PAYWALL (owner-flagged gap, built 2026-09-16): without a valid report
 * token this endpoint returns ONLY the free payload — score, verdict, roast,
 * category scores as numbers, 1–2 teaser findings, disclaimer — as JSON, or
 * renders the free teaser page when the client prefers text/html. The FULL
 * report (all findings + receipts) is served only when `?token=` carries a
 * valid HMAC token for this scan id (the link emailed to the paying buyer).
 * A supplied-but-invalid token is a 403 — it never degrades to the free page
 * (that would hand the token probe a non-error). ACCESS WINDOW
 * (owner-approved preserve-data/expire-access): the token'd branch mirrors the
 * /api/v1/report/:id gate — a VALID token on a scan older than
 * REPORT_ACCESS_TTL_MS (30 days past scan.created_at — see src/ttl.js) is a
 * 410 report_expired (the scan row itself survives retention; only the report
 * link expires). The no-token free path below is NEVER gated.
 *
 * GET /api/v1/scans/:id/card — the shareable result card: a deterministic
 * 1600x900 PNG (A.S.S. Score + scanned URL + band + donkey + branding +
 * disclaimer), composed as SVG and rasterized with sharp (no headless
 * browser). Same scan id -> byte-identical PNG, always. NO report content —
 * free-tier-shareable by design.
 *
 * GET /api/v1/scans/:id/share — pre-filled social share text + public result
 * URL (publicBaseUrl, default env PUBLIC_BASE_URL || https://ass-score.com).
 *
 * GET /api/v1/report/:id — the token'd full-report page (the URL inside the
 * buyer email). Same gating as the token'd scans route, plus the free page is
 * NOT rendered here — without a valid token it is a 403. ACCESS WINDOW
 * (owner-approved preserve-data/expire-access): a VALID token on a scan older
 * than REPORT_ACCESS_TTL_MS (30 days past scan.created_at — see src/ttl.js) is a
 * 410 report_expired — the scan row itself survives retention (see
 * src/retention.js), only the report link expires. Ordering: missing scan ->
 * 404, invalid/missing token -> 403, valid token past the window -> 410. The
 * free routes (/api/v1/scans/:id and the /report/:id alias) are NOT gated —
 * they are free by construction and their rows still purge at 30 days.
 */
export function scansRouter({ db, publicBaseUrl, reportTokenSecret, reportBaseUrl, now = () => new Date().toISOString() }) {
  const r = Router();
  const shareBase = publicBaseUrl || process.env.PUBLIC_BASE_URL || 'https://ass-score.com';
  // Approved Donkey System asset (owner spec 2026-09-22 v3): the dashboard/analyst
  // cutout, served from the BACKEND so the token'd report HTML can reference it on
  // the same origin (no CORS, no dependence on the site's public dir). Brand art
  // only — never report content, so it is safe to serve without a token.
  const DONKEY_DASHBOARD_PNG = fs.readFileSync(new URL('../assets/donkey-dashboard.png', import.meta.url));
  r.get('/assets/donkey-dashboard.png', (_req, res) => {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(DONKEY_DASHBOARD_PNG);
  });

  /** True when the request carries the valid HMAC report token for this scan. */
  const hasValidToken = (req, scanId) =>
    typeof req.query.token === 'string' &&
    verifyReportToken(reportTokenSecret, scanId, req.query.token);

  /**
   * Fetch a scan that PUBLIC surfaces may serve: missing AND admin-internal
   * rows (the /admin/share-card tool — owner 2026-10-01) both read as "no
   * scan". Every public GET uses this, so an admin-generated row 404s with the
   * EXACT same shape as a missing id (404 not_found) on ALL public read
   * surfaces — including when a VALID report token is supplied (the guard runs
   * BEFORE the token branch, so an internal row is 404, never 403/200, and the
   * existence oracle is unchanged: internal ids look exactly like holes).
   * Public rows behave byte-identically to today.
   */
  const publicScan = (id) => {
    const s = db.getScan(id);
    if (!s || s.internal === true) return null;
    return s;
  };

  /** 403 for a supplied-but-invalid (or missing-on-report-route) token. */
  const forbidden = (res, accept) => {
    const wantsHtml = /text\/html/.test(accept) && !/application\/json/.test(accept);
    if (wantsHtml) {
      return res.status(403).type('html').send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>403 — Link invalid</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1a202c">
<h1>This report link is invalid.</h1>
<p>The report link you opened has an invalid or missing access token.</p>
<p class="disclaimer" style="color:#64748b;font-size:.8rem">${DISCLAIMER}</p>
</body></html>`
      );
    }
    return res.status(403).json({ error: { code: 'forbidden', message: 'A valid report token is required for the full report' } });
  };

  /**
   * 410 for a VALID-token request on a scan past its report-access window.
   * Mirrors `forbidden` (same content negotiation): HTML accept -> the tiny
   * branded expiry page (copy owner-approved preserve-data/expire-access:
   * "This report link has expired — reports are available for 30 days after
   * your purchase." + support contact + the mandated disclaimer); JSON accept
   * -> 410 { error: { code: 'report_expired', ... } }. Only reachable with a
   * valid token (the 403 branch above runs first), so it never widens the
   * existence oracle beyond current behavior.
   *
   * The window is FIXED to scan.created_at (see src/ttl.js — REPORT_ACCESS_TTL_MS),
   * NOT the token-mint time, so the gate is deterministic for a given row.
   */
  const expired = (res, accept) => {
    const wantsHtml = /text\/html/.test(accept) && !/application\/json/.test(accept);
    if (wantsHtml) {
      return res.status(410).type('html').send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>410 — Link expired</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1a202c">
<h1>This report link has expired.</h1>
<p>This report link has expired — reports are available for 30 days after your purchase.</p>
<p>If you bought a report and need it again, email <a href="mailto:support@ass-score.com">support@ass-score.com</a>.</p>
<p class="disclaimer" style="color:#64748b;font-size:.8rem">${DISCLAIMER}</p>
</body></html>`
      );
    }
    return res.status(410).json({ error: { code: 'report_expired', message: 'This report link has expired — reports are available for 30 days after your purchase' } });
  };

  r.get('/api/v1/scans/:id', (req, res) => {
    const scan = publicScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    // A REPORT TOKEN unlocks the full report (HTML); the buyer's emailed link
    // lands here or on /api/v1/report/:id. The ACCESS GATE mirrors
    // /api/v1/report/:id (owner-approved preserve-data/expire-access): a valid
    // token on a scan past its 30-day window (fixed to scan.created_at —
    // src/ttl.js) is a 410 report_expired, not the report. Free (no token) is
    // below and is NEVER gated.
    if (hasValidToken(req, scan.id)) {
      if (isReportExpired(scan, now())) return expired(res, req.get('accept') || '');
      return res.type('html').send(renderHtmlReport({ ...scan, breakdown: breakdownFor(scan) }));
    }
    // A supplied token that does NOT verify is a 403 — never the free page.
    if (typeof req.query.token === 'string' && req.query.token !== '') {
      return forbidden(res, req.get('accept') || '');
    }

    // PUBLIC free shape (no token): the stored internal slop score IS the
    // public score (score 0-100, higher = worse — same direction, no
    // inversion; verdict added). Pre-flip rows read correctly with NO
    // migration. Three-layer insights are attached/stored but STRIPPED from
    // the free payload — only numbers + 1–2 teasers + roast + disclaimer
    // leave this route (the full findings are the paid content).
    const pub = toPublicScan({ ...scan, breakdown: breakdownFor(scan), roast: roastFor(scan) });
    const accept = req.get('accept') || '';
    const wantsHtml = /text\/html/.test(accept) && !/application\/json/.test(accept);
    if (wantsHtml) {
      return res.type('html').send(renderFreeHtmlReport(pub, shareBase));
    }
    res.json(buildFreePayload(pub));
  });

  // --- Token'd full report (the URL inside the buyer email) -----------------
  r.get('/api/v1/report/:id', (req, res) => {
    const scan = publicScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    if (hasValidToken(req, scan.id)) {
      // ACCESS GATE (owner-approved preserve-data/expire-access): a valid token
      // on a scan past its 30-day window (fixed to scan.created_at — src/ttl.js)
      // is a 410, not the report. Only reachable with a valid token.
      if (isReportExpired(scan, now())) return expired(res, req.get('accept') || '');
      return res.type('html').send(renderHtmlReport({ ...scan, breakdown: breakdownFor(scan) }));
    }
    return forbidden(res, req.get('accept') || '');
  });

  // --- Free HTML report alias (spec parity) ---------------------------------
  // GET /report/:scanId — serves the SAME free result page as
  // GET /api/v1/scans/:id with Accept: text/html (score, verdict, roast,
  // category numbers, 1–2 teasers, $12 CTA, disclaimer). This is a FREE page
  // by construction: any ?token is IGNORED — the full report is reachable ONLY
  // via the token'd /api/v1/report/:id route, so this alias can never become a
  // leak path for the paid findings.
  r.get('/report/:id', (req, res) => {
    const scan = publicScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    const pub = toPublicScan({ ...scan, breakdown: breakdownFor(scan), roast: roastFor(scan) });
    return res.type('html').send(renderFreeHtmlReport(pub, shareBase));
  });

  const missing = (res, id) =>
    res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${id}"` } });

  // --- Shareable result card (deterministic PNG, sharp-rasterized SVG) -------
  r.get('/api/v1/scans/:id/card', async (req, res, next) => {
    const scan = publicScan(req.params.id);
    if (!scan) return missing(res, req.params.id);
    try {
      const png = await renderCardPng(buildCardSvg({
        score: publicScore(scan.score), // public score = stored slop direction (higher = worse, 0 = clean)
        url: scan.url,
      }));
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=60');
      res.send(png);
    } catch (err) {
      next(err); // centralized error handler; PNG render errors never leak internals
    }
  });

  // --- Pre-filled share text (copy-to-clipboard + social post) ---------------
  // Text mirrors the site's share fallback exactly (owner-approved): the
  // "(low is good)" clarification rides the same line on every surface.
  r.get('/api/v1/scans/:id/share', (req, res) => {
    const scan = publicScan(req.params.id);
    if (!scan) return missing(res, req.params.id);
    const shareUrl = `${shareBase.replace(/\/+$/, '')}/scan/${scan.id}`;
    res.json({
      url: shareUrl,
      text: `My website got an A.S.S. Score of ${publicScore(scan.score)}/100 (low is good). Check yours at ass-score.com`,
    });
  });

  return r;
}

