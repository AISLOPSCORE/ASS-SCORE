import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { isHttpUrl } from '../branding.js';
import { selectRoast, selectRoastInfo } from '../roast.js';
import { withInsights, isCleanEvidence } from '../threeLayer.js';
import { toPublicScan, publicScore } from '../serialize.js';
import { verdictBand, verdictLabel, scoreColor } from '../verdict.js';
import { CATEGORY_LABELS, CATEGORY_ONE_LINERS } from '../categories.js';
import { buildFreePayload, verifyReportToken, DISCLAIMER } from '../paywall.js';

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

/** Roast info (pool emoji/label + line) with the stored-line override. */
function roastInfoFor(scan) {
  const info = selectRoastInfo({ id: scan.id, slopScore: scan.score, breakdown: scan.breakdown });
  if (typeof scan.roast === 'string' && scan.roast.trim() !== '') info.line = scan.roast;
  return info;
}

/**
 * Breakdown with three-layer insights guaranteed: stored rows already carry
 * `insights` inside the JSON column (attached at scan time); rows written
 * before the feature derive them deterministically from the stored id +
 * breakdown — the same function the scan pipeline used (withInsights is
 * idempotent, so stored insights always win). Every surface (JSON + HTML)
 * therefore shows the same layers for the same scan id.
 */
function breakdownFor(scan) {
  return withInsights(scan.breakdown, scan.id);
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
 * (that would hand the token probe a non-error).
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
 * NOT rendered here — without a valid token it is a 403.
 */
export function scansRouter({ db, publicBaseUrl, reportTokenSecret, reportBaseUrl }) {
  const r = Router();
  const shareBase = publicBaseUrl || process.env.PUBLIC_BASE_URL || 'https://ass-score.com';

  /** True when the request carries the valid HMAC report token for this scan. */
  const hasValidToken = (req, scanId) =>
    typeof req.query.token === 'string' &&
    verifyReportToken(reportTokenSecret, scanId, req.query.token);

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

  r.get('/api/v1/scans/:id', (req, res) => {
    const scan = db.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    // A REPORT TOKEN unlocks the full report (HTML); the buyer's emailed link
    // lands here or on /api/v1/report/:id. Free (no token) is below.
    if (hasValidToken(req, scan.id)) {
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
    const scan = db.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    if (hasValidToken(req, scan.id)) {
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
    const scan = db.getScan(req.params.id);
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
    const scan = db.getScan(req.params.id);
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
  r.get('/api/v1/scans/:id/share', (req, res) => {
    const scan = db.getScan(req.params.id);
    if (!scan) return missing(res, req.params.id);
    const shareUrl = `${shareBase.replace(/\/+$/, '')}/scan/${scan.id}`;
    res.json({
      url: shareUrl,
      text: `My website scored ${publicScore(scan.score)}/100 on the A.S.S. Score (AI Slop Score). Check yours: ${shareUrl}`,
    });
  });

  return r;
}

function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Per-category classification from the sub-score (0-100, higher = worse).
 * Thresholds (judgment, documented): 0-24 CLEAN, 25-49 WATCH, 50-74 NEEDS
 * ATTENTION, 75-100 PRIORITY — deliberately aligned with the product-wide
 * 6-band verdict table, so a category inside the CLEAN/CLEANEST bands reads
 * clean, GETTING ASSY reads watch, VERY/EXTREMELY ASS reads needs attention,
 * and CATASTROPHICALLY ASS reads priority. A category with zero findings
 * always reads CLEAN ("Nothing meaningful to roast here.").
 */
function categoryClass(score, findingsCount) {
  if (!Number.isFinite(Number(score)) || score === null || findingsCount === 0) return 'CLEAN';
  const s = Number(score);
  if (s >= 75) return 'PRIORITY';
  if (s >= 50) return 'NEEDS ATTENTION';
  if (s >= 25) return 'WATCH';
  return 'CLEAN';
}

/** Deterministic truncation for receipt snippets in the fix-first list. */
function short(s, n) {
  return String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s);
}

/**
 * Human conclusion sentence for THE VERDICT — derived ONLY from real scan
 * data (public score, band, highest-scoring category, total findings count).
 * No manufactured claims: every number and name comes from the scan.
 */
function verdictConclusion(scan, pubScore, band) {
  const scored = Object.entries(scan.breakdown ?? {})
    .filter(([, r]) => Number.isFinite(Number(r?.score)) && r.score !== null)
    .map(([k, r]) => [k, Number(r.score), Array.isArray(r.findings) ? r.findings.length : 0]);
  const totalFindings = scored.reduce((n, [, , c]) => n + c, 0);
  const worst = scored.length ? scored.slice().sort((a, b) => b[1] - a[1])[0] : null;
  const worstName = worst ? CATEGORY_LABELS[worst[0]] ?? worst[0] : null;
  const worstScore = worst ? publicScore(worst[1]) : null;
  const byBand = {
    'CATASTROPHICALLY ASS': `At ${pubScore}/100 this is about as bad as it gets — ${totalFindings} finding${totalFindings === 1 ? '' : 's'} with receipts, and the weakest area is ${worstName} at ${worstScore}/100.`,
    'EXTREMELY ASS': `This site lands at ${pubScore}/100 — ${worstName} (${worstScore}/100) is doing most of the damage across ${totalFindings} finding${totalFindings === 1 ? '' : 's'}.`,
    'VERY ASS': `${pubScore}/100 is a lot of ass — ${worstName} (${worstScore}/100) is the biggest offender in a list of ${totalFindings} finding${totalFindings === 1 ? '' : 's'}.`,
    'GETTING ASSY': `At ${pubScore}/100 this site is getting assy — ${worstName} (${worstScore}/100) leads ${totalFindings} finding${totalFindings === 1 ? '' : 's'} keeping it out of the clean bands.`,
    'CLEAN': `${pubScore}/100 is genuinely decent — just ${totalFindings} finding${totalFindings === 1 ? '' : 's'} to tidy up, worst of all ${worstName} at ${worstScore}/100.`,
    'CLEANEST': totalFindings === 0
      ? `${pubScore}/100 — CLEANEST is rare, and this site earned it with zero findings across the whole report.`
      : `${pubScore}/100 — CLEANEST is rare, and this site earned it: only ${totalFindings} finding${totalFindings === 1 ? '' : 's'} across the whole report.`,
  };
  return byBand[band.shortLabel] ?? `This site scores ${pubScore}/100 on the A.S.S. Score.`;
}

/** Final Verdict kicker — band-scoped, references the real score. */
function finalVerdictSentence(pubScore, band) {
  const byBand = {
    'CATASTROPHICALLY ASS': `A ${pubScore}/100 A.S.S. Score is a badge nobody asked for — but every point is fixable, and the findings above are the roadmap.`,
    'EXTREMELY ASS': `At ${pubScore}/100 your site is fighting you. Fix the findings above and watch the number drop.`,
    'VERY ASS': `${pubScore}/100 is a lot of ass for one website — the findings above are your to-do list.`,
    'GETTING ASSY': `${pubScore}/100 isn't clean yet, but it's close enough to smell the finish line. Keep fixing.`,
    'CLEAN': `${pubScore}/100 and genuinely decent — fix the few findings above and you're basically done.`,
    'CLEANEST': `${pubScore}/100 — this is what a good website looks like. Keep doing whatever you're doing.`,
  };
  return byBand[band.shortLabel] ?? `This site scores ${pubScore}/100 on the A.S.S. Score.`;
}

/**
 * Render ONE finding with the full three-layer structure + verbatim receipts.
 *
 * Owner rule (2026-09-16): clean findings are compliments, not insults. When
 * the insight carries `kind:'clean'` the layers render as COMPLIMENT / WHY IT
 * MATTERS / KEEP IT UP; a real negative finding renders exactly as today
 * (roast line + WHY IT MATTERS / HOW TO FIX IT). The evidence/receipts line is
 * identical in both variants — the measurement never leaves the report.
 *
 * Markup constraint (sacred): the classed spans sit inside UNCLASSED
 * containers — a classed parent immediately followed by a child tag would
 * emit a literal `"><` sequence, which the report's blanket no-raw-delimiter
 * assertion (branding hostile test) rejects. Every classed element here is
 * followed by escaped text, never by a tag.
 *
 * Findings beyond the 6-insight cap have no stored insight (three-layer cap):
 * they render their verbatim evidence as the roast and keep the receipts.
 */
function renderFinding(categoryLabel, finding, insight, index) {
  const title = `Finding ${index + 1} · ${categoryLabel}`;
  const hasInsight = insight && typeof insight.roast === 'string' && insight.roast !== '';
  const clean = hasInsight && insight.kind === 'clean';
  const roast = hasInsight ? insight.roast : finding;
  const why = hasInsight ? insight.why : '';
  const fix = hasInsight ? insight.fix : '';
  const layers = hasInsight
    ? clean
      ? `<div><span class="ins-kind">Compliment:</span> ${esc(roast)}</div>
    <div><span class="ins-why">Why it matters:</span> ${esc(why)}</div>
    <div><span class="ins-fix">Keep it up:</span> ${esc(fix)}</div>`
      : `<p class="ins-roast">${esc(roast)}</p>
    <div><span class="ins-why">Why it matters:</span> ${esc(why)}</div>
    <div><span class="ins-fix">How to fix it:</span> ${esc(fix)}</div>`
    : '<p class="rec-note">No deeper insight was stored for this finding — the receipts below are the evidence.</p>';
  return `
  <div>
    <h3>${esc(title)}</h3>
    ${layers}
    <div><span class="rec-label">Show the receipts:</span>
      <ul><li><strong>${esc(finding)}</strong></li></ul>
    </div>
  </div>`;
}

/**
 * Render the FREE result page (no token) — the same teaser-level content as
 * the free JSON: score, verdict, roast, category numbers, 1–2 three-layer
 * teaser findings, the share-card link, the mandated disclaimer, and the $12
 * checkout CTA. It NEVER contains the full findings/insights — those are the
 * paid content, delivered only by email after checkout.
 *
 * Deterministic: teasers are seeded by the scan id (same id -> same page).
 */
function renderFreeHtmlReport(scan, shareBase = 'https://ass-score.com') {
  const pub = buildFreePayload(scan);
  const band = verdictBand(pub.score);
  const teaserLis = pub.teasers.map((t, i) => {
    const label = CATEGORY_LABELS[t.key] ?? t.key;
    // Clean findings are compliments, not insults (owner rule 2026-09-16):
    // a `kind:'clean'` teaser renders COMPLIMENT / WHY IT MATTERS / KEEP IT UP,
    // a negative teaser renders exactly as today.
    const clean = t.kind === 'clean';
    const roastEl = clean
      ? `<div><span class="ins-kind">Compliment:</span> ${esc(t.roast)}</div>`
      : `<p class="ins-roast">${esc(t.roast)}</p>`;
    const why = t.why ? `<div><span class="ins-why">Why it matters:</span> ${esc(t.why)}</div>` : '';
    const fix = t.fix ? `<div><span class="ins-fix">${clean ? 'Keep it up:' : 'How to fix it:'}</span> ${esc(t.fix)}</div>` : '';
    return `
  <div class="free-f">
    <h3>Free sample ${i + 1} · ${esc(label)}</h3>
    ${roastEl}
    ${why}
    ${fix}
    <div><span class="rec-label">Receipt:</span> <em>${esc(short(t.evidence, 140))}</em></div>
  </div>`;
  }).join('');
  const teasersBlock = teaserLis === ''
    ? '<p>Nothing to roast this scan — the full report will tell you why a clean site still matters.</p>'
    : teaserLis;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>A.S.S. Score — free result</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a202c; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.8rem; } h3 { font-size: 1rem; margin: 1.1rem 0 .2rem; }
    .score { font-size: 2.6rem; font-weight: 700; color: ${scoreColor(pub.score)}; }
    .verdict { font-size: 1.15rem; font-weight: 700; margin: .25rem 0 .75rem; color: ${band.color}; }
    .roast { font-size: 1.05rem; font-weight: 600; margin: .75rem 0 .25rem; }
    .ins-roast { font-style: italic; color: #7c3aed; font-weight: 600; margin: .25rem 0 .25rem; font-size: .92rem; }
    .ins-why, .ins-fix { font-weight: 700; color: #475569; margin-right: .25rem; }
    .rec-label { font-weight: 700; color: #64748b; font-size: .8rem; }
    .disclaimer { color: #64748b; font-size: .8rem; border-top: 1px solid #e2e8f0; padding-top: .75rem; margin-top: 1.5rem; }
    .cta { display: inline-block; background: #0f172a; color: #f8fafc; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; margin: .5rem 0; }
    ul { margin: .25rem 0 .75rem; padding-left: 1.1rem; }
  </style>
</head>
<body>
  <h1>A.S.S. Score — free result</h1>
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(pub.createdAt)}</p>
  <p class="score">A.S.S. Score: ${pub.score} / 100</p>
  <p class="verdict">${esc(pub.verdict)}</p>
  <p class="roast">${esc(pub.roast)}</p>
  <h2>Your numbers (0 = clean · 100 = maximum ass)</h2>
  <ul>${Object.entries(pub.breakdown).map(([key, rule]) =>
    `<li><strong>${esc(CATEGORY_LABELS[key] ?? key)}</strong> — ${rule.score === null || rule.score === undefined ? (rule.note ? esc(rule.note) : 'skipped') : `${rule.score}/100`}</li>`).join('')}</ul>
  <h2>Free samples</h2>
  ${teasersBlock}
  <p><a href="${esc(`${shareBase.replace(/\/+$/, '')}/api/v1/scans/${pub.id}/card`)}">Download your share card</a></p>
  <p><a class="cta" href="https://buy.stripe.com/cNi00j7zs1P49ju5B9abK00" target="_blank" rel="noreferrer">Unlock the full report — $12</a></p>
  <p>The full report — every finding with receipts, the fix list, the page that needs the most work — is emailed to you after checkout.</p>
  <p class="disclaimer">${DISCLAIMER}</p>
  <p>Score id: <code>${esc(pub.id)}</code> · deterministic rule-based analysis, no AI models.</p>
</body>
</html>`;
}

/**
 * Render the HTML report — the customer-facing Full Report (owner content/IA
 * rebuild 2026-09-15). Section order: THE VERDICT → THE BIG PICTURE → YOUR
 * BREAKDOWN → THE ACTUAL FINDINGS → PAGE THAT NEEDS THE MOST WORK → WHAT TO
 * FIX FIRST → FINAL VERDICT → METHODOLOGY + mandated DISCLAIMER.
 *
 * Old sections absorbed into the new IA: the evidence table became YOUR
 * BREAKDOWN + THE ACTUAL FINDINGS receipts; the "Slop Roast" section became
 * the roast line inside THE VERDICT; "Worst Page" became PAGE THAT NEEDS THE
 * MOST WORK; "Templated Content" pairs became REPETITION receipts.
 *
 * Everything is deterministic: same scan id -> byte-identical HTML. This is
 * the PAID report — reachable ONLY via the token'd routes (see scansRouter).
 *
 * White-label branding (optional, stored with the scan):
 *   - agencyName  -> the report header shows the agency name; the metric
 *                    label "A.S.S. Score" stays visible (title tag, "powered
 *                    by" line + the score line below).
 *   - logoUrl     -> <img> at the top, ONLY when it is an http(s) URL
 *                    (re-checked at render, attrs escaped).
 *   - accentColor -> inline style on the agency header + the A.S.S. Score
 *                    number (only when it is a valid hex color).
 *   - footerText  -> an extra footer line (the mandated disclaimer and the
 *                    score id are always rendered, never replaced).
 */
function renderHtmlReport(scan) {
  // --- white-label branding (normalized + re-validated at render) -----------
  const branding = scan.branding ?? {};
  const agencyName = typeof branding.agencyName === 'string' ? branding.agencyName : '';
  const logoUrl = isHttpUrl(branding.logoUrl) ? branding.logoUrl : '';
  const accentColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(branding.accentColor ?? '')
    ? branding.accentColor
    : '';
  const footerText = typeof branding.footerText === 'string' ? branding.footerText : '';

  // --- white-label header (agency name, optional logo, accent color) --------
  // The metric label "A.S.S. Score" is ALWAYS visible: in the <title>, in the
  // "powered by" line when branded, and in the score line below.
  const header = agencyName
    ? `<h1${accentColor ? ` style="color:${accentColor};border-bottom:3px solid ${accentColor};display:inline-block;padding-bottom:.2rem"` : ''}>${esc(agencyName)}</h1>
  <p class="powered">A.S.S. Score report · powered by <a href="https://ass-score.com">A.S.S. Score</a></p>`
    : `<h1>A.S.S. Score report</h1>`;
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(agencyName || 'agency logo')}" style="max-height:56px;max-width:220px;display:block;margin:0 0 .75rem" />`
    : '';
  const scoreAccent = accentColor ? ` style="color:${accentColor}"` : '';
  const footerLine = footerText ? `<p class="footer">${esc(footerText)}</p>` : '';

  // Score + verdict: the stored score IS the public score (0-100, higher =
  // worse — no inversion); the grade label and its band color come from the
  // shared verdict module (src/verdict.js).
  const pubScore = publicScore(scan.score);
  const publicVerdict = verdictBand(pubScore);
  const verdictClass = { 'CATASTROPHICALLY ASS': 'b-catastrophic', 'EXTREMELY ASS': 'b-extreme', 'VERY ASS': 'b-very', 'GETTING ASSY': 'b-mild', 'CLEAN': 'b-clean', 'CLEANEST': 'b-cleanest' }[publicVerdict.shortLabel] ?? 'b-very';
  const verdictLine = `<p class="verdict ${verdictClass}">${verdictLabel(pubScore)}</p>`;

  // Deterministic personality line (stored, or derived for pre-roast rows).
  const roastInfo = roastInfoFor(scan);
  const cross = scan.breakdown?.crossPage ?? {};

  // Pages scanned line (+ partial-scan note, surfaced right under the score).
  const pagesLine = Array.isArray(cross.pages) && cross.pages.length >= 2
    ? `<p>Pages scanned: ${cross.pages.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(', ')}${scan.partial && scan.note ? ` · ${esc(scan.note)}` : ''}</p>`
    : '';

  // --- 1. THE VERDICT --------------------------------------------------------
  const verdictSection = `
  <h2>The Verdict</h2>
  <p class="roast">${roastInfo.emoji} ${esc(roastInfo.line)}</p>
  <p>${esc(verdictConclusion(scan, pubScore, publicVerdict))}</p>`;

  // --- 2. THE BIG PICTURE (real findings only, never invented) ---------------
  // A category "reads clean" when its classification is CLEAN (sub-score
  // < 25 or zero findings) — zero-count evidence lines ("0 filler phrase
  // occurrence(s)...") are receipts of cleanliness, not problems.
  const catEntries = Object.entries(scan.breakdown ?? {});
  const scoredCat = (r) => Number.isFinite(Number(r?.score)) && r.score !== null;
  const catClean = ([, r]) => scoredCat(r) && categoryClass(publicScore(r.score), Array.isArray(r.findings) ? r.findings.length : 0) === 'CLEAN';
  const cleanCats = catEntries.filter(catClean);
  const problemCats = catEntries.filter(([, r]) => scoredCat(r) && !catClean([, r]) && Array.isArray(r.findings) && r.findings.length > 0);
  const withFindings = catEntries.filter(([, r]) => scoredCat(r) && Array.isArray(r.findings) && r.findings.length > 0);
  const topProblems = problemCats.slice().sort((a, b) => Number(b[1].score) - Number(a[1].score)).slice(0, 3);
  const goodLis = cleanCats.length > 0
    ? cleanCats.map(([k]) => `<li><strong>${esc(CATEGORY_LABELS[k] ?? k)}</strong> — nothing meaningful to roast here.</li>`).join('')
    : '<li>Not much — every scored category came back with at least one finding this scan.</li>';
  const betterLis = topProblems.length > 0
    ? topProblems.map(([k, r]) => `<li><strong>${esc(CATEGORY_LABELS[k] ?? k)} (${publicScore(r.score)}/100)</strong> — ${esc(CATEGORY_ONE_LINERS[k] ?? '')}</li>`).join('')
    : '<li>Nothing flagged — every scored category reads clean this scan.</li>';
  const bigPicture = `
  <h2>The Big Picture</h2>
  <h3>What's working</h3><ul>${goodLis}</ul>
  <h3>What could be better</h3><ul>${betterLis}</ul>
  <h3>Bottom line</h3><p>${esc(publicVerdict.line1)} ${esc(publicVerdict.line2)}</p>`;

  // --- 3. YOUR BREAKDOWN (7 customer-facing categories + classification) -----
  const breakdownLis = catEntries.map(([key, rule]) => {
    const label = CATEGORY_LABELS[key] ?? key;
    if (!scoredCat(rule)) {
      // Skipped module (score null, e.g. crossPage on a single-page scan):
      // surface its note instead of a score.
      const note = rule?.note ? esc(rule.note) : 'skipped';
      return `<li><strong>${esc(label)}</strong> — ${note}</li>`;
    }
    const sub = publicScore(rule.score);
    const nFindings = Array.isArray(rule.findings) ? rule.findings.length : 0;
    const cls = categoryClass(sub, nFindings);
    const line = cls === 'CLEAN' ? 'Nothing meaningful to roast here.' : (CATEGORY_ONE_LINERS[key] ?? '');
    return `<li><strong>${esc(label)}</strong> — ${sub}/100 <em>(${cls})</em> — ${esc(line)}</li>`;
  }).join('');
  const breakdownSection = `
  <h2>Your Breakdown</h2>
  <ul>${breakdownLis}</ul>`;

  // --- 4. THE ACTUAL FINDINGS (three-layer + verbatim receipts) --------------
  const findingsTotal = withFindings.reduce((n, [, r]) => n + r.findings.length, 0);
  // Clean-aware intro: a report whose findings are compliments must not talk
  // about "roasts" (owner rule). All-negative reports keep today's exact line.
  const cleanFindingCount = withFindings.reduce(
    (n, [key, r]) => n + (Array.isArray(r.findings) ? r.findings : []).filter((f, i) => {
      const ins = Array.isArray(r.insights) ? r.insights[i] : undefined;
      return (ins && ins.kind === 'clean') || isCleanEvidence(key, f);
    }).length,
    0,
  );
  const findingsIntro = findingsTotal === 0
    ? 'No findings this scan — nothing to roast, and nothing to hide.'
    : cleanFindingCount === findingsTotal
      ? `${findingsTotal} finding${findingsTotal === 1 ? '' : 's'} across ${withFindings.length} categor${withFindings.length === 1 ? 'y' : 'ies'} — and every single one is a compliment. The receipts below are what clean looks like.`
      : cleanFindingCount > 0
        ? `${findingsTotal} finding${findingsTotal === 1 ? '' : 's'} across ${withFindings.length} categor${withFindings.length === 1 ? 'y' : 'ies'} — every line is backed by the receipts below.`
        : `${findingsTotal} finding${findingsTotal === 1 ? '' : 's'} across ${withFindings.length} categor${withFindings.length === 1 ? 'y' : 'ies'} — every roast points at the receipts below.`;
  const findingGroups = withFindings.map(([key, rule]) => {
    const label = CATEGORY_LABELS[key] ?? key;
    const items = rule.findings
      .map((f, i) => renderFinding(label, f, Array.isArray(rule.insights) ? rule.insights[i] : undefined, i))
      .join('');
    // Cross-page duplication pairs -> REPETITION receipts (real evidence,
    // replaces the old "Templated Content" section).
    const pairs = key === 'crossPage' && Array.isArray(cross.pairs)
      ? cross.pairs.filter((p) => p.similarity >= 0.8)
      : [];
    const pairsBlock = pairs.length > 0
      ? `<div><span class="rec-label">Duplicated page pairs (receipts):</span>
    <ul>${pairs.map((p) => `<li><a href="${esc(p.pageA)}">${esc(p.pageA)}</a> ~ <a href="${esc(p.pageB)}">${esc(p.pageB)}</a> — ${(p.similarity * 100).toFixed(1)}% similar</li>`).join('')}</ul>
  </div>`
      : '';
    return `
  <div>
    <h3>${esc(label)}</h3>
    ${items}
    ${pairsBlock}
  </div>`;
  }).join('');
  const findingsSection = `
  <h2>The Actual Findings</h2>
  <p>${findingsIntro}</p>
  ${findingGroups}`;

  // --- 5. PAGE THAT NEEDS THE MOST WORK (worstPage; single-page graceful) ----
  const worst = scan.worstPage || null;
  const pageSection = worst
    ? `\n  <h2>Page That Needs The Most Work</h2>\n  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined score ${Number(worst.score)} / 100 (higher = worse)</p>\n  ` +
      (Array.isArray(worst.findings) && worst.findings.length > 0
        ? `<ul>${worst.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
        : '<p>No per-page findings were captured for this page.</p>')
    : `\n  <h2>Page That Needs The Most Work</h2>\n  <p>Single page scanned — this page IS the site.</p>`;

  // --- 6. WHAT TO FIX FIRST (prioritized from REAL problems only) ------------
  // Items come ONLY from categories that do not read clean (classification
  // CLEAN is excluded — zero-count evidence lines are receipts of cleanliness,
  // not things to fix), AND only from findings that are actually negative at
  // the finding level: a `kind:'clean'` insight (or a clean evidence string
  // with no stored insight) is a compliment, never a to-do (owner rule —
  // never manufacture a negative from a clean measurement). Order by category
  // sub-score descending (impact proxy; stable sort keeps finding order inside
  // a category). Effort is treated as roughly equal — each item is one
  // concrete, scoped fix, and the "How to fix it" layer gives the effort
  // detail. Cap at 5 for a scannable list.
  const fixItems = [];
  for (const [key, rule] of problemCats) {
    const label = CATEGORY_LABELS[key] ?? key;
    const insights = Array.isArray(rule.insights) ? rule.insights : [];
    rule.findings.forEach((f, i) => {
      const ins = insights[i];
      if (ins && ins.kind === 'clean') return; // compliment — not a fix item
      if (!ins && isCleanEvidence(key, f)) return; // clean receipts are not to-dos
      fixItems.push({
        score: Number(rule.score),
        label,
        roast: ins && ins.roast ? ins.roast : f,
        evidence: f,
      });
    });
  }
  fixItems.sort((a, b) => b.score - a.score);
  const fixLis = fixItems.slice(0, 5)
    .map((it) => `<li><strong>${esc(it.label)}</strong> — ${esc(it.roast)} <em>(receipt: ${esc(short(it.evidence, 90))})</em></li>`)
    .join('');
  const fixSection = `
  <h2>What To Fix First</h2>
  ${fixLis === '' ? '<p>No findings to fix this scan — every category reads clean.</p>' : `<ol>${fixLis}</ol>`}`;

  // --- 7. FINAL VERDICT ------------------------------------------------------
  const finalSection = `
  <h2>Final Verdict</h2>
  <p>${esc(finalVerdictSentence(pubScore, publicVerdict))}</p>`;

  // --- 8. METHODOLOGY + mandated DISCLAIMER (never cut, never reworded) ------
  const partialNote = scan.partial && scan.note ? ` Some pages could not be scanned this run: ${esc(scan.note)}.` : '';
  const methodologySection = `
  <h2>Methodology</h2>
  <p>Every finding in this report comes from a deterministic, rule-based analysis of the pages we fetched — the same URL always produces the same score. The seven categories look for concrete, documented patterns: filler phrasing, generic marketing boilerplate, vague content, repeated text, duplicated language across pages, template-built design fingerprints, and stock or placeholder imagery. Every finding lists the verbatim evidence behind it, and the overall A.S.S. Score is the weighted rollup of the seven category scores.${partialNote}</p>
  <p class="disclaimer">${DISCLAIMER}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>A.S.S. Score report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a202c; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.8rem; }
    h3 { font-size: 1rem; margin-top: 1.2rem; margin-bottom: .2rem; }
    .powered { color: #64748b; font-size: .85rem; margin-top: -.25rem; }
    .score { font-size: 2.6rem; font-weight: 700; }
    .verdict { font-size: 1.15rem; font-weight: 700; margin: .25rem 0 .75rem; }
    .b-catastrophic { color: #f87171; } .b-extreme { color: #f97316; } .b-very { color: #fb923c; }
    .b-mild { color: #facc15; } .b-clean { color: #a3e635; } .b-cleanest { color: #4ade80; }
    .roast { font-size: 1.15rem; font-weight: 600; margin: .75rem 0 .25rem; }
    .footer { color: #64748b; font-size: .9rem; border-top: 1px solid #e2e8f0; padding-top: .75rem; margin-top: 1.5rem; }
    ul, ol { margin: .25rem 0 .75rem; padding-left: 1.1rem; }
    li { margin-bottom: .45rem; }
    .ins-roast { font-style: italic; color: #7c3aed; font-weight: 600; margin: .25rem 0 .25rem; font-size: .92rem; }
    .ins-why, .ins-fix { font-weight: 700; color: #475569; margin-right: .25rem; }
    .rec-label { font-weight: 700; color: #64748b; font-size: .8rem; }
    .rec-note { color: #94a3b8; font-size: .85rem; font-style: italic; }
    .disclaimer { color: #64748b; font-size: .8rem; border-top: 1px solid #e2e8f0; padding-top: .75rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  ${logo}
  ${header}
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(scan.created_at)}</p>
  <p class="score"${scoreAccent}>A.S.S. Score: ${pubScore} / 100</p>
  ${verdictLine}
  ${pagesLine}
  ${verdictSection}
  ${bigPicture}
  ${breakdownSection}
  ${findingsSection}
  ${pageSection}
  ${fixSection}
  ${finalSection}
  ${methodologySection}
  ${footerLine}
  <p>Score id: <code>${esc(scan.id)}</code> · deterministic rule-based analysis, no AI models.</p>
</body>
</html>`;
}