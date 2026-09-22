import fs from 'node:fs';
import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { isHttpUrl } from '../branding.js';
import { selectRoast, selectRoastInfo } from '../roast.js';
import { withInsights, isCleanEvidence, isMetricFinding, classifyFinding, buildCategoryInsights, parseEvidenceTokens } from '../threeLayer.js';
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Human-readable scan date (owner IA §11): "September 17, 2026" instead of a
 * raw ISO timestamp. Deterministic (UTC); unparseable/legacy values fall back
 * to the raw string so old rows never crash the render.
 */
function humanScanDate(value) {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Human conclusion sentence for THE VERDICT — derived ONLY from real scan
 * data (public score, band, highest-scoring category, ACTUAL NEGATIVE finding
 * count). Owner IA (2026-09-17 §1): summaries count NEGATIVE findings ONLY —
 * compliments and metric measurements are never "findings", so a clean report
 * says zero findings even when its breakdown carries clean receipts. When no
 * negative finding exists the conclusion says so plainly instead of inventing
 * a weakest area. No manufactured claims: every number and name comes from
 * the scan.
 */
function verdictConclusion(scan, pubScore, band, negativeTotal) {
  const scored = Object.entries(scan.breakdown ?? {})
    .filter(([, r]) => Number.isFinite(Number(r?.score)) && r.score !== null)
    .map(([k, r]) => [k, Number(r.score)]);
  const worst = scored.length ? scored.slice().sort((a, b) => b[1] - a[1])[0] : null;
  const worstName = worst ? CATEGORY_LABELS[worst[0]] ?? worst[0] : null;
  const worstScore = worst ? publicScore(worst[1]) : null;
  if (negativeTotal === 0) {
    return band.shortLabel === 'CLEANEST'
      ? `${pubScore}/100 — CLEANEST is rare, and this site earned it with zero negative findings across the whole report.`
      : `${pubScore}/100 — no specific problems flagged this scan: the score is driven by the diagnostic measurements below, and every category line reads clean or neutral.`;
  }
  const n = negativeTotal;
  const byBand = {
    'CATASTROPHICALLY ASS': `At ${pubScore}/100 this is about as bad as it gets — ${n} finding${n === 1 ? '' : 's'} with receipts, and the weakest area is ${worstName} at ${worstScore}/100.`,
    'EXTREMELY ASS': `This site lands at ${pubScore}/100 — ${worstName} (${worstScore}/100) is doing most of the damage across ${n} finding${n === 1 ? '' : 's'}.`,
    'VERY ASS': `${pubScore}/100 is a lot of ass — ${worstName} (${worstScore}/100) is the biggest offender in a list of ${n} finding${n === 1 ? '' : 's'}.`,
    'GETTING ASSY': `At ${pubScore}/100 this site is getting assy — ${worstName} (${worstScore}/100) leads ${n} finding${n === 1 ? '' : 's'} keeping it out of the clean bands.`,
    'CLEAN': `${pubScore}/100 is genuinely decent — just ${n} finding${n === 1 ? '' : 's'} to tidy up, worst of all ${worstName} at ${worstScore}/100.`,
    'CLEANEST': `${pubScore}/100 — CLEANEST is rare: only ${n} finding${n === 1 ? '' : 's'} across the whole report, and every one is fixable.`,
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
 * Classify every finding of one category via the shared three-layer machinery
 * (owner IA 2026-09-17). The report sections derive from this SPLIT ONLY:
 *
 *   'negative' — a real detector problem: the four-concept finding, counts in
 *                summaries, feeds What To Fix First and Page That Needs The
 *                Most Work.
 *   'clean'    — a healthy measurement: WHAT'S WORKING compliment + receipt,
 *                never a roast, never counted.
 *   'metric'   — an out-of-band diagnostic MEASUREMENT (vocab diversity,
 *                stopword ratio, mean sentence length, short par %): neutral
 *                evidence only, never a finding/roast, never counted (owner
 *                IA §4 — metrics are not automatically findings).
 *
 * @param {string} key breakdown category key
 * @param {object} rule the category rule (findings + insights arrays)
 * @returns {{ items: Array<{ finding: string, insight: object|null, cls: string }>,
 *             negatives: Array, cleans: Array, metrics: Array }}
 */
function splitCategory(key, rule) {
  const findings = Array.isArray(rule?.findings) ? rule.findings : [];
  const insights = Array.isArray(rule?.insights) ? rule.insights : [];
  const items = findings.map((f, i) => {
    const finding = String(f ?? '');
    return {
      finding,
      insight: insights[i] && typeof insights[i] === 'object' ? insights[i] : null,
      cls: classifyFinding(key, finding, insights[i]),
    };
  });
  return {
    items,
    negatives: items.filter((x) => x.cls === 'negative'),
    cleans: items.filter((x) => x.cls === 'clean'),
    metrics: items.filter((x) => x.cls === 'metric'),
  };
}

/**
 * The stored three-layer insight for a negative finding, or a deterministic
 * per-finding derivation for findings outside the 6-insight cap (assets and
 * fingerprint detail lines can exceed it). Every negative finding must render
 * THE ROAST / WHY IT MATTERS / HOW TO FIX IT / THE RECEIPTS (owner IA §3), so
 * the beyond-cap ones derive their layers from the same pools with a stable
 * seed — same scan id -> identical bytes, always.
 */
function insightFor(scanId, key, finding, insight, index) {
  if (insight && typeof insight.roast === 'string' && insight.roast !== '') return insight;
  const derived = buildCategoryInsights({
    category: key,
    findings: [String(finding)],
    id: `${scanId}:report:beyond:${key}:${index}`,
  });
  return derived && derived[0] ? derived[0] : null;
}

/**
 * Render ONE actual NEGATIVE finding with the four owner concepts: THE ROAST /
 * WHY IT MATTERS / HOW TO FIX IT / THE RECEIPTS (owner IA 2026-09-17 §3).
 * Only ever called for classifyFinding() === 'negative' — clean results and
 * metric measurements never pass through here.
 *
 * Markup constraint (sacred): the classed spans sit inside UNCLASSED
 * containers — a classed parent immediately followed by a child tag would
 * emit a literal `"><` sequence, which the report's blanket no-raw-delimiter
 * assertion (branding hostile test) rejects. Every classed element here is
 * followed by escaped text, never by a tag.
 */
function renderFinding(scanId, categoryKey, categoryLabel, finding, insight, index, state = null, ordinal = index + 1) {
  const ins = insightFor(scanId, categoryKey, finding, insight, index);
  const roast = ins ? ins.roast : finding;
  const why = ins ? ins.why : '';
  const fix = ins ? ins.fix : '';
  // Phase 2B diagnostic card — each negative finding is ONE clearly separated
  // card with four labeled zones: THE ROAST / WHY IT MATTERS / HOW TO FIX IT /
  // RECEIPTS. The label TEXT stays exactly as Phase 1 emitted it (so every
  // existing assertion still matches); the display case is applied via CSS
  // text-transform. The severity badge comes from the SAME existing category
  // classification (categoryClass on the stored sub-score) — never invented.
  const stateBadge = state && state !== 'CLEAN'
    ? `<span class="fc-state fc-state-${String(state).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${esc(state)}</span>`
    : '';
  const roastBlock = ins
    ? `<p class="ins-roast">${esc(roast)}</p>`
    : '<p class="rec-note">No deeper insight was stored for this finding — the receipts below are the evidence.</p>';
  const whyBlock = why
    ? `<div class="fc-why">\n      <span class="ins-why">Why it matters:</span> ${esc(why)}\n    </div>`
    : '';
  const fixBlock = fix
    ? `<div class="fc-fix">\n      <span class="ins-fix">How to fix it:</span> ${esc(fix)}\n    </div>`
    : '';
  return `\n  <div class="finding-card">
    <div class="fc-head">
      <span class="fc-count">Finding ${ordinal}</span>
      <span class="fc-cat">${esc(categoryLabel)}</span>
      ${stateBadge}
    </div>
    <div class="fc-body">
      <div class="fc-roast">
        <span class="fc-label fc-label-roast">The Roast</span>
        ${roastBlock}
      </div>
      ${whyBlock}
      ${fixBlock}
      <details class="fc-receipts">
        <summary>
          <span class="rec-label">Show the receipts:</span>
          <span class="rec-count">1 line of evidence</span>
        </summary>
        <ul><li><strong>${esc(finding)}</strong></li></ul>
      </details>
    </div>
  </div>`;
}

/**
 * Render ONE clean/positive measurement for WHAT'S WORKING (owner IA §1-2): a
 * short "LABEL — CLEAN:" observation with its evidence receipt. Never a roast,
 * never a fix task, never counted as a finding.
 */
function renderCleanItem(categoryLabel, item) {
  const roast = item.insight && typeof item.insight.roast === 'string' && item.insight.roast !== ''
    ? item.insight.roast
    : 'No meaningful signal detected here.';
  return `<li class="working-item">
    <span class="working-point">
      <strong>${esc(categoryLabel)} — CLEAN:</strong> ${esc(roast)}</span>
    <span class="working-receipt">
      <span class="rec-label">Receipt:</span> <em>${esc(short(item.finding, 140))}</em>
    </span>
  </li>`;
}

/** The four categories a worstPage.findings list can contain (scan.js order). */
const WORST_PAGE_KEYS = ['filler', 'boilerplate', 'infoDensity', 'repetitive'];

/**
 * Summarize a stored worstPage.findings list into ACTUAL-NEGATIVE counts per
 * customer category (owner IA §8: the page with the strongest concentration of
 * actual negative findings). Clean measurements and metric lines are receipts,
 * not page problems — they never count. Deterministic: the rule modules' own
 * evidence formats identify both the category and the class, so a metric line
 * can never be presented as a page problem.
 */
function worstPageSummary(findings = []) {
  const per = new Map();
  for (const raw of findings) {
    const f = String(raw ?? '');
    const key = WORST_PAGE_KEYS.find((k) => Object.keys(parseEvidenceTokens(k, f)).length > 0);
    if (!key || isCleanEvidence(key, f) || isMetricFinding(key, f)) continue;
    per.set(key, (per.get(key) ?? 0) + 1);
  }
  return [...per.entries()];
}

/**
 * Render the FREE result page (no token) — the same teaser-level content as
 * the free JSON: score, verdict, roast, category numbers, 1–2 three-layer
 * teaser findings, the share-card link, the mandated disclaimer, and the $12
 * checkout CTA. It NEVER contains the full findings/insights — those are the
 * paid content, delivered only by email after checkout.
 *
 * Deterministic: teasers are seeded by the scan id (same id -> same page).
 * Owner IA §11: the footer carries no "Score id" metadata, and the scanned
 * date renders human-readable.
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
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(humanScanDate(pub.createdAt))}</p>
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
  <p>Deterministic rule-based analysis — the same URL always produces the same score.</p>
</body>
</html>`;
}

/**
 * Render the HTML report — the customer-facing Full Report (owner content/IA
 * rebuild 2026-09-17, Phase 1, wrapped by the Phase 2A dashboard shell).
 * Page order (dashboard final cleanup, owner/lead 2026-09-23 — hierarchy:
 * Big Picture → Score/Verdict → What Needs Attention → Category Breakdown →
 * What's Working → Findings/detail): SCORE HERO → THE VERDICT → PAGE THAT
 * NEEDS THE MOST WORK → WHAT TO FIX FIRST (the "What Needs Attention" block,
 * moved up so the action plan reads right after the verdict) → YOUR BREAKDOWN
 * (category cards) → WHAT'S WORKING → THE ACTUAL FINDINGS → FINAL VERDICT →
 * METHODOLOGY + mandated DISCLAIMER. Phase 2A is presentation-only:
 * every content string (roast copy, why/fix, receipts, methodology,
 * disclaimer) is emitted verbatim by the sections below.
 *
 * Finding semantics (owner IA §1–4, §7–9):
 *   - WHAT'S WORKING holds CLEAN/positive detector results ONLY (compliments
 *     + their receipts; "COPY — CLEAN: …").
 *   - THE ACTUAL FINDINGS holds NEGATIVE findings ONLY, each in the four-part
 *     form THE ROAST / WHY IT MATTERS / HOW TO FIX IT / THE RECEIPTS; clean
 *     and skipped categories render NO card inside it (they are represented
 *     by the breakdown cards + WHAT'S WORKING) — they keep only an invisible
 *     anchor target so the Phase 2A/2C wiring (cards + focused views + no-JS
 *     hash scroll) still resolves. Metric-only categories keep their NEUTRAL
 *     Measurements block (owner IA §4 — neutral evidence, never a finding).
 *   - Summary counts count NEGATIVE findings only — compliments and metric
 *     measurements are never "findings" and are never counted.
 *   - Diagnostic metric measurements (vocab diversity, stopword ratio, mean
 *     sentence length, short par %) render as NEUTRAL evidence when the
 *     detector flags them out-of-band, never as findings/roasts (§4).
 *   - PAGE THAT NEEDS THE MOST WORK: single-page scans read "Homepage — this
 *     is the only page scanned." plus a summary of the actual findings;
 *     multi-page scans name the stored worst page with its actual-negative
 *     concentration (§8).
 *   - WHAT TO FIX FIRST lists actual negative findings only, prioritized by
 *     category severity, each as a COMPACT ranked summary (rank/pill,
 *     category + severity, one-line what-to-fix, link to the category view) —
 *     never a repeat of the full Roast/Why/Fix/Receipts (§9, cleanup pass).
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
 *   - footerText  -> an extra footer line (the mandated disclaimer is always
 *                    rendered, never replaced).
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
    ? `<p class="pages">Pages scanned: ${cross.pages.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(', ')}${scan.partial && scan.note ? ` · ${esc(scan.note)}` : ''}</p>`
    : '';

  // --- Per-finding classification (owner IA) --------------------------------
  // ONE split drives every section: WHAT'S WORKING (clean only), THE ACTUAL
  // FINDINGS + summary counts (negative only), WHAT TO FIX FIRST (negative
  // only), page summaries (negative only). Metrics render as neutral evidence.
  const classified = Object.entries(scan.breakdown ?? {}).map(([key, rule]) => ({
    key,
    rule,
    ...splitCategory(key, rule),
  }));
  const negativeTotal = classified.reduce((n, g) => n + g.negatives.length, 0);
  const negativeCats = classified.filter((g) => g.negatives.length > 0);

  // --- 1. THE VERDICT --------------------------------------------------------
  const verdictSection = `
  <h2>The Verdict</h2>
  <p class="roast">${roastInfo.emoji} ${esc(roastInfo.line)}</p>
  <p class="conclusion">${esc(verdictConclusion(scan, pubScore, publicVerdict, negativeTotal))}</p>`;

  // --- 5. WHAT'S WORKING (clean/positive detector results only; rendered
  // below the breakdown, per the Phase 2A target hierarchy) ------------------
  const cleanLis = classified
    .flatMap((g) => g.cleans.map((item) => renderCleanItem(CATEGORY_LABELS[g.key] ?? g.key, item)))
    .join('');
  const workingSection = `
  <h2>What's Working</h2>
  ${cleanLis === ''
    ? '<div class="working-empty">\n      <p class="working-empty-line">Nothing to compliment this scan — the findings and measurements below are the whole story.</p>\n    </div>'
    : `<ul class="working-list">
  ${cleanLis}
  </ul>`}`;

  // --- 4. YOUR BREAKDOWN (7 customer-facing CATEGORY CARDS, Phase 2A shell) ---
  // Each category renders as a CLICKABLE card whose href="#cat-<key>" hash now
  // opens that category's FOCUSED view (Phase 2C) — the inline script shows the
  // matching #view-cat-<key> section. The dashboard's own id="cat-<key>"
  // sections stay in place (Phase 2A anchor contract + the no-JS degraded path
  // still scroll to them). The number + state come from the SAME existing
  // classification as the old list (categoryClass on the stored sub-score;
  // stored note for skipped modules) — no recalculation, no reinterpretation.
  // State colors are applied by class only (green/amber/red/gray), driven by
  // that classification, never by changing data.
  const breakdownCards = Object.entries(scan.breakdown ?? {}).map(([key, rule]) => {
    const label = CATEGORY_LABELS[key] ?? key;
    const anchor = `cat-${key.toLowerCase()}`;
    if (!(Number.isFinite(Number(rule?.score)) && rule.score !== null)) {
      // Skipped module (score null, e.g. crossPage on a single-page scan):
      // surface its note instead of a score.
      const note = rule?.note ? esc(rule.note) : 'skipped';
      return `\n  <a class="cat-card cat-skipped" href="#${anchor}">
    <span class="cat-top">
      <span class="cat-name">${esc(label)}</span>
      <span class="cat-go">details →</span>
    </span>
    <span class="cat-line">${note}</span>
  </a>`;
    }
    const sub = publicScore(rule.score);
    const nFindings = Array.isArray(rule.findings) ? rule.findings.length : 0;
    const cls = categoryClass(sub, nFindings);
    const stateClass = cls === 'NEEDS ATTENTION' ? 'cat-attention' : `cat-${cls.toLowerCase()}`;
    const line = cls === 'CLEAN' ? 'Nothing meaningful to roast here.' : (CATEGORY_ONE_LINERS[key] ?? '');
    // Findings-or-not line: counts NEGATIVE findings only (the report-wide
    // convention — compliments and metric measurements are never "findings").
    const grp = classified.find((x) => x.key === key);
    const negs = grp ? grp.negatives.length : 0;
    const metr = grp ? grp.metrics.length : 0;
    const findingsLine = negs > 0
      ? `<span class="cat-findings cat-findings-problem">${negs} roast${negs === 1 ? '' : 's'} — see receipts</span>`
      : (metr > 0 ? '<span class="cat-findings">Measurements only</span>' : '<span class="cat-findings cat-findings-clean">No roasts</span>');
    return `\n  <a class="cat-card ${stateClass}" href="#${anchor}">
    <span class="cat-top">
      <span class="cat-name">${esc(label)}</span>
      <span class="cat-go">details →</span>
    </span>
    <span class="cat-mid">
      <span class="cat-score">${sub}<span class="cat-den">/100</span></span>
      <span class="cat-state">${cls}</span>
    </span>
    <span class="cat-meter" aria-hidden="true">
      <span class="cat-meter-fill" style="width:${sub}%"> </span>
    </span>
    ${findingsLine}
    <span class="cat-line">${esc(line)}</span>
  </a>`;
  }).join('');
  const breakdownSection = `
  <h2>Your Breakdown</h2>
  <p class="hint">Tap a category to open its focused view — the details are one click away.</p>
  <div class="cat-grid">
  ${breakdownCards}
  </div>`;

  // --- 6. THE ACTUAL FINDINGS (negative findings only, four concepts) --------
  const findingsIntro = negativeTotal === 0
    ? 'No findings this scan — nothing to roast, and nothing to hide.'
    : `${negativeTotal} finding${negativeTotal === 1 ? '' : 's'} across ${negativeCats.length} categor${negativeCats.length === 1 ? 'y' : 'ies'} — every roast points at the receipts below.`;
  // Groups render for categories with negative findings OR neutral metric
  // measurements — a metric-only category (e.g. low score but only MATTR/
  // stopword/sentence-length measurements) still shows its Measurements block.
  // negativeCats above stays strictly negative-only for the intro count, the
  // page summary, and What To Fix First (owner IA §4/§5/§8).
  // Phase 2A shell: EVERY category gets an anchor target id="cat-<key>" here
  // (the breakdown cards link to it). Categories with negative findings render
  // their finding cards; metric-only categories render their NEUTRAL
  // Measurements block; clean/skipped categories render ONLY an invisible
  // anchor marker (dashboard final cleanup — no more "Nothing meaningful to
  // roast here" placeholder cards inside THE ACTUAL FINDINGS).
  // Phase 2B: global finding ordinal across the whole report ("Finding 1, 2,
  // 3…" in owner spec), independent of the per-category insight-seeding index
  // which is deliberately left untouched for byte-determinism of derived copy.
  let findingOrdinal = 0;
  const findingGroups = classified.map((g) => {
    const label = CATEGORY_LABELS[g.key] ?? g.key;
    if (!(g.negatives.length > 0 || g.metrics.length > 0)) {
      // Clean / skipped category (dashboard final cleanup 2026-09-23): render
      // NO card inside THE ACTUAL FINDINGS — the breakdown card and WHAT'S
      // WORKING already represent it, and a "Nothing meaningful to roast here"
      // panel only reads as a fake finding. The Phase 2A/2C contract still
      // needs an in-page anchor (the category cards link here; the focused
      // Category View resolves its data-source here; no-JS hash scroll lands
      // here), so emit an invisible marker element instead of a visible card.
      return `\n  <span class="cat-anchor" aria-hidden="true" id="cat-${g.key.toLowerCase()}"
></span>`;
    }
    // Phase 2B: each negative finding's severity badge comes from the SAME
    // existing category classification (categoryClass on the stored sub-score
    // + finding count) — never a new/reinterpreted severity. CLEAN is never
    // badgeable here: a category with negative findings is never CLEAN.
    const fgScore = g.rule?.score;
    const fgSub = (Number.isFinite(Number(fgScore)) && fgScore !== null) ? publicScore(fgScore) : null;
    const fgCount = Array.isArray(g.rule?.findings) ? g.rule.findings.length : 0;
    const fgState = (g.negatives.length > 0 && fgSub !== null) ? categoryClass(fgSub, fgCount) : null;
    // Phase 2D-1: the section carries a semantic state accent class (watch /
    // needs-attention / priority / neutral) — presentation only, same
    // classification as the cards; never a data change. `cat-detail-empty`
    // stays intact in its own className for the 2C clone check.
    const fgAccent = fgState === null ? 'neutral' : (fgState === 'NEEDS ATTENTION' ? 'needs-attention' : fgState.toLowerCase());
    const items = g.negatives
      .map((x, i) => renderFinding(scan.id, g.key, label, x.finding, x.insight, i, fgState, ++findingOrdinal))
      .join('');
    // Cross-page duplication pairs -> REPETITION receipts (real evidence,
    // replaces the old "Templated Content" section).
    const pairs = g.key === 'crossPage' && Array.isArray(cross.pairs)
      ? cross.pairs.filter((p) => p.similarity >= 0.8)
      : [];
    const pairsBlock = pairs.length > 0
      ? `<div class="rec-block">
      <span class="rec-label">Duplicated page pairs (receipts):</span>
    <ul>${pairs.map((p) => `<li><a href="${esc(p.pageA)}">${esc(p.pageA)}</a> ~ <a href="${esc(p.pageB)}">${esc(p.pageB)}</a> — ${(p.similarity * 100).toFixed(1)}% similar</li>`).join('')}</ul>
  </div>`
      : '';
    // Out-of-band metric measurements render as NEUTRAL evidence (owner IA
    // §4): never a finding/roast, never counted — just the numbers, labelled
    // as measurements.
    const metricsBlock = g.metrics.length > 0
      ? `<div class="rec-block rec-block-metric">
      <span class="rec-label">Measurements:</span> <em>${g.metrics.map((m) => esc(m.finding)).join(' · ')}</em>
    </div>`
      : '';
    return `
  <section class="cat-detail cat-detail-${fgAccent}" id="cat-${g.key.toLowerCase()}">
    <h3>${esc(label)}</h3>
    ${items}
    ${pairsBlock}
    ${metricsBlock}
  </section>`;
  }).join('');
  const findingsSection = `
  <h2>The Actual Findings</h2>
  <p>${findingsIntro}</p>
  ${findingGroups}`;

  // --- 2. PAGE THAT NEEDS THE MOST WORK (owner IA §8) ------------------------
  // Single-page scan (no stored worstPage): name the homepage — the only page
  // scanned — and summarize what is actually wrong there. Multi-page scan:
  // the stored worst page (engine-picked combined score) plus its actual
  // negative concentration; cross-page conclusions are never invented here.
  const worst = scan.worstPage || null;
  let pageSection;
  if (worst) {
    const per = worstPageSummary(worst.findings);
    const lis = per.length > 0
      ? per.map(([k, n]) => `<li><strong>${esc(CATEGORY_LABELS[k] ?? k)}</strong> — ${n} actual finding${n === 1 ? '' : 's'} on this page.</li>`).join('')
      : '<li>No actual negative findings captured for this page — its combined score comes from duplication or sub-threshold signals.</li>';
    pageSection = `
  <h2>Page That Needs The Most Work</h2>
  <div class="page-panel" style="--pp:${negativeTotal === 0 ? '#4ade80' : '#f87171'}">
  <p class="page-head">
    <a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined score ${Number(worst.score)} / 100 (higher = worse).</p>
  <ul class="page-list">
  ${lis}
  </ul>
  </div>`;
  } else {
    const lis = negativeCats.length > 0
      ? negativeCats.map((g) => `<li><strong>${esc(CATEGORY_LABELS[g.key] ?? g.key)}</strong> — ${g.negatives.length} actual finding${g.negatives.length === 1 ? '' : 's'} to fix.</li>`).join('')
      : '<li>Nothing to fix here this scan.</li>';
    pageSection = `
  <h2>Page That Needs The Most Work</h2>
  <div class="page-panel" style="--pp:${negativeTotal === 0 ? '#4ade80' : '#f87171'}">
  <p class="page-head">
    <strong>Homepage</strong> — this is the only page scanned.</p>
  <ul class="page-list">
  ${lis}
  </ul>
  </div>`;
  }

  // --- 3. WHAT TO FIX FIRST (actual negative findings only, prioritized) -----
  // Owner IA §9: only NEGATIVE findings become to-dos (clean results and
  // metric measurements never do). Prioritized by category sub-score
  // descending (impact proxy; stable sort keeps finding order inside a
  // category); capped at 5 for a scannable list. Each item renders as a
  // COMPACT summary (dashboard final cleanup) — see the map below.
  const fixItems = [];
  for (const g of classified) {
    if (g.negatives.length === 0) continue;
    const label = CATEGORY_LABELS[g.key] ?? g.key;
    const sub = (Number.isFinite(Number(g.rule?.score)) && g.rule?.score !== null) ? publicScore(g.rule.score) : 0;
    const nFindings = Array.isArray(g.rule?.findings) ? g.rule.findings.length : 0;
    const cls = categoryClass(sub, nFindings);
    g.negatives.forEach((x, i) => {
      const ins = insightFor(scan.id, g.key, x.finding, x.insight, i);
      fixItems.push({
        key: g.key,
        score: Number(g.rule?.score),
        label,
        cls,
        problem: ins ? ins.roast : x.finding,
        action: ins ? ins.fix : '',
        evidence: x.finding,
      });
    });
  }
  fixItems.sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));
  // Each fix is a COMPACT RANKED SUMMARY (dashboard final cleanup 2026-09-23):
  // rank (CSS counter) + state pill + category chip + ONE-LINE what-to-fix +
  // a link into the category view — never a repeat of the full Roast / Why /
  // How To Fix / Receipts (those live once, in THE ACTUAL FINDINGS). Rank =
  // real priority order (category severity desc), links reuse the same
  // #cat-<key> anchor pattern as the category cards, so the browser opens the
  // focused Category View (JS) or scrolls the category section (no-JS).
  const fixLis = fixItems.slice(0, 5)
    .map((it) => {
      const summary = it.action
        ? short(String(it.action), 120)
        : 'See the full finding for the concrete fix.';
      return `\n  <li class="fix-item fix-${it.cls.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">
    <div class="fix-top">
      <span class="fix-cat">${esc(it.label)}</span>
      <span class="fix-pill">${esc(it.cls)}</span>
    </div>
    <p class="fix-action">
      <span class="fix-action-label">Fix it:</span> ${esc(summary)}
    </p>
    <a class="fix-link" href="#cat-${it.key.toLowerCase()}">See the full finding ↓</a>
  </li>`;
    })
    .join('');
  const fixSection = `
  <h2>What To Fix First</h2>
  <p class="hint">Ranked by category severity — the highest A.S.S. score first. Fix these and the number drops.</p>
  ${fixLis === '' ? '<p>No negative findings to fix this scan — nothing in this report needs fixing.</p>' : `<ol class="fix-list">${fixLis}</ol>`}`;

  // --- 7. FINAL VERDICT ------------------------------------------------------
  // The approved donkey-dashboard cutout appears here as the "analyst" —
  // the authority figure signing off on the verdict (Donkey System spec v3).
  // /assets/donkey-dashboard.png is served by this router on the same origin.
  const finalSection = `
  <h2>Final Verdict</h2>
  <div class="final-analyst">
    <img class="final-donkey" src="/assets/donkey-dashboard.png" alt="The A.S.S. analyst — final verdict" width="384" height="737" loading="lazy" />
    <p class="final-note" style="--band:${publicVerdict.color}">${esc(finalVerdictSentence(pubScore, publicVerdict))}</p>
  </div>`;

  // --- 8. METHODOLOGY + mandated DISCLAIMER (never cut, never reworded) ------
  const partialNote = scan.partial && scan.note ? ` Some pages could not be scanned this run: ${esc(scan.note)}.` : '';
  const methodologySection = `
  <h2>Methodology</h2>
  <p>Every finding in this report comes from a deterministic, rule-based analysis of the pages we fetched — the same URL always produces the same score. The seven categories look for concrete, documented patterns: filler phrasing, generic marketing boilerplate, vague content, repeated text, duplicated language across pages, template-built design fingerprints, and stock or placeholder imagery. Every finding lists the verbatim evidence behind it, and the overall A.S.S. Score is the weighted rollup of the seven category scores.${partialNote}</p>
  <p class="disclaimer">${DISCLAIMER}</p>`;

  // --- Phase 2C: focused Category Views (navigation/presentation only) ------
  // Hash-driven (#cat-<key>) drill-down in the SAME single document. Each view
  // is a hidden <section class="cat-view" id="view-cat-<key>"> carrying only the
  // navigation chrome (Back to Dashboard → category name → existing score/state
  // → the category's own clean items), plus an empty .cat-view-body whose
  // data-source names the SAME existing dashboard section (id="cat-<key>"). On
  // open, the inline script CLONES that existing section into the body — so the
  // view shows the exact existing finding cards / duplication pairs /
  // measurements, never regenerated content. Because the cards are cloned
  // client-side, the server HTML stays free of duplicate audit text: the
  // Phase 2A anchors (id="cat-<key>") and Phase 2B card counts are untouched,
  // and the dashboard remains fully present for no-JS/print/SEO. The state and
  // one-liner lines reuse the SAME existing classification data as the cards
  // (categoryClass on the stored sub-score; CATEGORY_ONE_LINERS) — no
  // reinterpretation. Clean categories show their clean items; a category with
  // measurements but no negative finding keeps those measurements as neutral
  // evidence (never a warning) via the cloned section.
  const categoryViews = Object.entries(scan.breakdown ?? {}).map(([key, rule]) => {
    const label = CATEGORY_LABELS[key] ?? key;
    const anchor = `cat-${key.toLowerCase()}`;
    const g = classified.find((x) => x.key === key);
    let stateLine;
    if (!(Number.isFinite(Number(rule?.score)) && rule.score !== null)) {
      stateLine = `\n    <span class="cv-none">${rule?.note ? esc(rule.note) : 'skipped'}</span>`;
    } else {
      const sub = publicScore(rule.score);
      const nFindings = Array.isArray(rule.findings) ? rule.findings.length : 0;
      const cls = categoryClass(sub, nFindings);
      stateLine = `\n    <span class="cv-score">${sub}<span class="cv-den">/100</span></span>\n    <span class="cv-state cv-state-${cls.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${esc(cls)}</span>\n    <span class="cv-line">${esc(CATEGORY_ONE_LINERS[key] ?? '')}</span>`;
    }
    const cleanLis = (g && g.cleans.length > 0)
      ? `\n    <ul class="cv-clean">\n      ${g.cleans.map((item) => renderCleanItem(label, item)).join('')}\n    </ul>`
      : '';
    return `
  <section class="cat-view" id="view-${anchor}" hidden>
    <a class="cat-back" href="#dashboard">← Back to Dashboard</a>
    <h2 class="cat-view-name">${esc(label)}</h2>
    <p class="cat-view-state">${stateLine}
    </p>${cleanLis}
    <div class="cat-view-body" data-source="${anchor}">
    </div>
  </section>`;
  }).join('');

  // Inline, dependency-free view toggle. Degrades to the dashboard (views stay
  // hidden); the cards' native #cat-<key> anchors still scroll to the sections
  // when JS is off. KEYS is generated from the same breakdown keys as the views.
  const viewKeys = Object.keys(scan.breakdown ?? {}).map((k) => `cat-${k.toLowerCase()}`);
  const categoryViewScript = `
<script>
/* Phase 2C category drill-down — hash-driven, single document, no dependencies.
   The dashboard stays fully present; a #cat-<key> hash shows that category's
   focused view. The view's .cat-view-body is filled by CLONING the dashboard's
   own cat-<key> section (same finding cards / measurements, no regeneration).
   Unknown or empty hash = dashboard. With JS off, the report is simply the
   dashboard and the cards' native hash anchors scroll as in Phase 2A. */
(function () {
  var KEYS = ['${viewKeys.join("','")}'];
  function currentKey() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h.indexOf('cat-') === 0 && KEYS.indexOf(h) !== -1) return h;
    return null;
  }
  function showDashboard() {
    var d = document.getElementById('dashboard');
    if (d) d.hidden = false;
    var views = document.querySelectorAll('.cat-view');
    for (var i = 0; i < views.length; i++) views[i].hidden = true;
    window.scrollTo(0, 0);
  }
  function openView(key) {
    var d = document.getElementById('dashboard');
    var view = document.getElementById('view-' + key);
    if (!d || !view) return;
    var body = view.querySelector('.cat-view-body');
    var section = document.getElementById(key);
    if (body && section && !body.firstElementChild
        && section.className.indexOf('cat-detail-empty') === -1) {
      var clone = section.cloneNode(true);
      clone.removeAttribute('id');
      body.appendChild(clone);
    }
    d.hidden = true;
    var views = document.querySelectorAll('.cat-view');
    for (var i = 0; i < views.length; i++) views[i].hidden = (views[i] !== view);
    window.scrollTo(0, 0);
  }
  function apply() {
    var key = currentKey();
    if (key) openView(key); else showDashboard();
  }
  window.addEventListener('hashchange', apply);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  window.addEventListener('load', function () {
    if (currentKey()) window.scrollTo(0, 0);
  });
})();
</script>`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>A.S.S. Score report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Caveat:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
/* ================================================================
       A.S.S. Score — Full Report visual identity.
       Phase 2D-1 foundation (dark A.S.S. brand) + Phase 2D-2 polish
       (owner spec 2026-09-21): hero severity at a glance, scannable
       category meters, premium audit finding cards, prominent
       receipts, actionable priority cards, intentional empty
       states for clean scans. CSS/UI ONLY: every class/id the dashboard, finding
       cards and Category Views use is preserved and restyled; no
       audit text, scoring, category structure or 2C navigation is
       changed. Score direction locked: 0 = LEAST ASS / BEST,
       100 = MAX ASS / WORST. Lower = better. Band colors
       (green -> amber -> red, HIGHER = WORSE) are used semantically
       for scores, states and accents; brand lime (#d4f000) is
       reserved for interaction and the wordmark. No generic AI
       glow, no decorative gradients.
       ================================================================ */
    :root {
      color-scheme: dark;
      --ass:#d4f000;             /* A.S.S. brand lime — wordmark + interaction */
      --bg:#0a0a0b;              /* page foundation (near-black) */
      --surface:#151517;         /* cards */
      --surface-2:#1d1d21;       /* raised / hover */
      --line:rgba(255,255,255,.09);
      --line-strong:rgba(255,255,255,.17);
      --ink:#f4f4f5;             /* primary text */
      --ink-dim:#b8b8c0;         /* secondary */
      --ink-faint:#8b8b95;       /* captions/meta */
      --good:#4ade80;            /* CLEAN / CLEANEST (low = best) */
      --warn:#facc15;            /* WATCH / GETTING ASSY */
      --mid:#fb923c;             /* NEEDS ATTENTION / VERY ASS */
      --worse:#f87171;           /* PRIORITY / EXTREMELY+ ASS */
      --neutral:#8b8b95;         /* skipped / no data */
      --font-display:"Anton","Impact","Arial Black",sans-serif;
      --font-hand:"Caveat","Comic Sans MS",cursive;
      --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      --band:#f87171;            /* overridden inline per scan */
      --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { font-family: var(--font-sans); background: var(--bg); color: var(--ink); max-width: 1024px; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.6; font-size: .95rem; overflow-x: clip; }
    /* --- Masthead (wordmark h1 kept verbatim for the branding contract;
       styled as the Anton wordmark, with the donkey as the brand moment) --- */
    .report-head { border-bottom: 1px solid var(--line); padding-bottom: 1.1rem; margin-bottom: 1rem; }
    .head-row { display: flex; align-items: center; justify-content: space-between; gap: 1.25rem; }
    .head-text { min-width: 0; }
    h1 { font-family: var(--font-display); font-size: clamp(1.45rem, 4vw, 2rem); text-transform: uppercase; letter-spacing: .03em; color: var(--ass); line-height: 1.05; margin: 0; font-weight: 400; }
    .powered { color: var(--ink-faint); font-size: .8rem; margin: .35rem 0 0; }
    .powered a { color: var(--ass); }
    .head-tag { font-family: var(--font-hand); text-transform: uppercase; font-size: 1.02rem; letter-spacing: .03em; color: var(--ink-dim); margin: .45rem 0 0; }
    .head-donkey { width: 56px; height: 56px; flex: none; background: url(/assets/donkey-dashboard.png) center 15% / cover no-repeat; border-radius: 50%; background-color: rgba(255,255,255,.04); }
    .meta { color: var(--ink-faint); font-size: .84rem; margin: 0 0 1.6rem; overflow-wrap: anywhere; }
    .meta a { color: var(--ink-dim); text-decoration: none; border-bottom: 1px dotted var(--line-strong); }
    .meta a:hover { color: var(--ass); border-color: var(--ass); }
    /* --- Score hero (poster language): small label line, GIANT band-colored
       number, solid band pill verdict, band fill gauge, scale caption.
       Everything below the number is optional reading — the score + its
       severity read in 2 seconds from number color, pill and gauge fill.
       0 = best / 100 = worst, per the locked direction. --- */
    .hero { margin: 0 0 2.2rem; padding: 2.7rem 1.4rem 1.7rem; border-radius: 20px; text-align: center; border: 1px solid var(--line-strong); border-top: 6px solid var(--band, #f87171); background: var(--surface); }
    .hero .score { margin: 0 0 .45rem; font-size: .8rem; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; color: var(--ink-faint); }
    .hero-num { display: flex; align-items: baseline; justify-content: center; gap: .4rem; margin: 0; font-family: var(--font-display); color: var(--band, #f87171); font-weight: 400; }
    .hero-val { font-size: clamp(4.3rem, 15vw, 7.4rem); line-height: .9; letter-spacing: .01em; }
    .hero-den { font-size: clamp(1.35rem, 4vw, 2.1rem); color: var(--ink-faint); letter-spacing: .02em; }
    .hero .verdict { display: inline-block; font-family: var(--font-display); font-size: clamp(1.2rem, 3.6vw, 1.65rem); font-weight: 400; text-transform: uppercase; letter-spacing: .1em; margin: 1.15rem 0 .75rem; padding: .55rem 1.7rem; border-radius: 999px; border: 2px solid rgba(0,0,0,.18); }
    .hero .b-catastrophic { color: #150a0a; background: #f87171; }
    .hero .b-extreme { color: #150a0a; background: #f97316; }
    .hero .b-very { color: #150a0a; background: #fb923c; }
    .hero .b-mild { color: #150a0a; background: #facc15; }
    .hero .b-clean { color: #0f1103; background: #a3e635; }
    .hero .b-cleanest { color: #07110a; background: #4ade80; }
    /* the severity gauge: fill width = score (0 clean -> 100 full+red) */
    .hero-gauge { width: min(430px, 100%); height: 13px; margin: .35rem auto 0; border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid var(--line-strong); overflow: hidden; }
    .hero-gauge-fill { display: block; height: 100%; border-radius: 999px; background: var(--band, #f87171); }
    .hero-scale { color: var(--ink-faint); font-size: .72rem; letter-spacing: .16em; text-transform: uppercase; margin: .9rem 0 0; }
    .hero .pages { color: var(--ink-faint); font-size: .85rem; margin: .85rem 0 0; }
    .hero .pages a { color: var(--ink-dim); text-decoration: none; border-bottom: 1px dotted var(--line-strong); }
    .hero .pages a:hover { color: var(--ass); border-color: var(--ass); }
    .score { font-size: 2.6rem; font-weight: 700; }
    .verdict { font-size: 1.15rem; font-weight: 700; margin: .25rem 0 .75rem; }
    .b-catastrophic { color: #f87171; } .b-extreme { color: #f97316; } .b-very { color: #fb923c; }
    .b-mild { color: #facc15; } .b-clean { color: #a3e635; } .b-cleanest { color: #4ade80; }
    .roast { font-family: var(--font-hand); font-size: 1.38rem; line-height: 1.45; color: var(--ink); margin: .6rem 0 .3rem; }
    .hint { color: var(--ink-faint); font-size: .85rem; margin: -.35rem 0 1rem; }
    .conclusion { color: var(--ink-dim); font-size: .97rem; max-width: 78ch; margin: .4rem 0 0; }
    /* --- Section headings: numbered Anton editorial rules. Numbers are pure
       presentation (updates only with the section order, never the data). --- */
    #dashboard { counter-reset: sec; }
    #dashboard > h2 { counter-increment: sec; }
    #dashboard > h2::before { content: counter(sec, decimal-leading-zero) "  /  "; font-size: .62em; letter-spacing: .05em; color: var(--ink-faint); }
    h2 { font-family: var(--font-display); font-size: clamp(1.12rem, 3.2vw, 1.32rem); text-transform: uppercase; letter-spacing: .05em; margin: 3.4rem 0 1rem; padding-bottom: .55rem; border-bottom: 1px solid var(--line); color: var(--ink); font-weight: 400; scroll-margin-top: 1.4rem; }
    h3 { font-family: var(--font-sans); font-weight: 800; font-size: .9rem; text-transform: uppercase; letter-spacing: .07em; color: var(--ink); margin: 1.4rem 0 .5rem; }
    /* --- Category cards: clickable <a>, state-colored left edge, state pill
       (solid band + dark ink), per-category severity meter (fill = sub-score,
       band color = state), findings-or-not line. Scan = name + number +
       meter + pill. The accent has a job: it IS the severity. --- */
    .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); gap: .9rem; margin: 1.25rem 0 1rem; }
    .cat-card { display: block; text-decoration: none; color: inherit; border: 1px solid var(--line); border-left: 4px solid var(--cat, #8b8b95); border-radius: 14px; padding: 1rem 1.05rem .95rem; background: var(--surface); transition: transform .08s ease, border-color .15s ease, background-color .15s ease, box-shadow .15s ease; }
    .cat-card:hover { background: var(--surface-2); transform: translateY(-2px); border-color: var(--cat, #8b8b95); box-shadow: 0 8px 22px rgba(0,0,0,.35); }
    .cat-card:focus-visible { outline: 2px solid var(--cat, #8b8b95); outline-offset: 2px; }
    .cat-clean { --cat: #4ade80; }
    .cat-watch { --cat: #facc15; }
    .cat-attention { --cat: #fb923c; }
    .cat-priority { --cat: #f87171; }
    .cat-skipped { --cat: #8b8b95; }
    .cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
    .cat-name { font-weight: 800; font-size: .95rem; letter-spacing: .03em; color: var(--ink); }
    .cat-go { color: var(--cat, #8b8b95); font-size: .69rem; font-weight: 800; text-transform: uppercase; letter-spacing: .09em; }
    .cat-card:hover .cat-go, .cat-card:focus-visible .cat-go { text-decoration: underline; }
    .cat-mid { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; margin: .55rem 0 .15rem; }
    .cat-score { font-family: var(--font-display); font-weight: 400; font-size: 1.75rem; letter-spacing: .01em; color: var(--cat, var(--ink)); }
    .cat-den { font-size: .78rem; font-weight: 600; color: var(--ink-faint); }
    .cat-state { font-size: .66rem; font-weight: 800; letter-spacing: .07em; padding: .2rem .6rem; border-radius: 999px; color: #0a0a0b; background: var(--cat, #8b8b95); }
    .cat-meter { display: block; height: 5px; border-radius: 999px; background: rgba(255,255,255,.08); margin: .6rem 0 .15rem; overflow: hidden; }
    .cat-meter-fill { display: block; height: 100%; border-radius: 999px; background: var(--cat, #8b8b95); transition: width .25s ease; }
    .cat-findings { display: block; font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); margin-top: .35rem; }
    .cat-findings-clean { color: var(--good); }
    .cat-findings-problem { color: var(--worse); }
    .cat-line { display: block; font-size: .82rem; color: var(--ink-dim); margin-top: .45rem; line-height: 1.5; }
    /* --- Category detail sections (card targets) + state accent edges;
       empty sections render as an intentional dashed panel, not a hole --- */
    .cat-detail { border: 1px solid var(--line); border-radius: 16px; padding: 1rem 1.2rem 1.15rem; margin: 1.5rem 0; background: var(--surface); scroll-margin-top: 1.4rem; }
    /* invisible anchor markers for clean/skipped categories inside THE ACTUAL
       FINDINGS: no card is rendered for them (dashboard final cleanup), but the
       Phase 2A/2C wiring still needs an in-page anchor target — this marker
       carries the id with zero visual footprint. */
    .cat-anchor { display: block; height: 0; }
    .cat-detail-empty { background: rgba(255,255,255,.015); border-style: dashed; }
    .cat-detail-watch { border-left: 3px solid #facc15; }
    .cat-detail-needs-attention { border-left: 3px solid #fb923c; }
    .cat-detail-priority { border-left: 3px solid #f87171; }
    .cat-detail-neutral { border-left: 3px solid #8b8b95; }
    .cat-empty { color: var(--ink-faint); font-size: .9rem; margin: .4rem 0 .5rem; font-style: italic; }
    /* --- Phase 2B finding cards: premium paid-audit cards, one per negative
       finding, four labeled zones. The ROAST is the loudest block (band-tinted
       evidence panel); the receipts drawer is a clear, bordered control with a
       real line count; receipts render like terminal transcripts. --- */
    .finding-card { border: 1px solid var(--line); border-left: 4px solid var(--fc, #f87171); border-radius: 16px; padding: 1.15rem 1.25rem 1.05rem; margin: 1.15rem 0; background: var(--surface); overflow-wrap: break-word; word-break: break-word; }
    .finding-card + .finding-card { margin-top: 1.5rem; }
    .cat-detail-watch .finding-card { --fc: #facc15; }
    .cat-detail-needs-attention .finding-card { --fc: #fb923c; }
    .cat-detail-priority .finding-card { --fc: #f87171; }
    .fc-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .9rem; padding-bottom: .75rem; border-bottom: 1px dashed var(--line); }
    .fc-count { font-size: .7rem; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-faint); }
    .fc-cat { font-size: .7rem; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim); background: rgba(255,255,255,.06); border: 1px solid var(--line); padding: .16rem .6rem; border-radius: 999px; }
    .fc-state { font-size: .64rem; font-weight: 800; letter-spacing: .07em; padding: .16rem .55rem; border-radius: 999px; color: #0a0a0b; background: #8b8b95; }
    .fc-state-watch { background: #facc15; }
    .fc-state-needs-attention { background: #fb923c; }
    .fc-state-priority { background: #f87171; }
    .fc-body { display: flex; flex-direction: column; gap: 1rem; }
    .fc-roast { max-width: 78ch; }
    .fc-label { display: block; font-size: .66rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: .45rem; }
    .fc-roast .ins-roast { font-size: 1.2rem; font-weight: 800; line-height: 1.45; color: var(--ink); margin: 0; font-style: normal; padding: 1rem 1.05rem; border: 1px solid var(--line); border-left: 4px solid var(--fc, #f87171); border-radius: 12px; background: rgba(255,255,255,.035); }
    .fc-roast .rec-note { margin: 0; font-style: italic; color: var(--ink-faint); font-size: .9rem; }
    .fc-why, .fc-fix { max-width: 78ch; border-top: 1px solid var(--line); padding-top: .9rem; line-height: 1.65; color: var(--ink-dim); font-size: .93rem; }
    .fc-why .ins-why, .fc-fix .ins-fix { display: block; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; font-size: .66rem; color: var(--ink-faint); margin: 0 0 .3rem; }
    .fc-fix { border-left: 3px solid var(--ass); padding-left: .9rem; background: rgba(212,240,0,.03); }
    /* the receipts drawer: an obvious evidence control, not a footnote */
    .fc-receipts { margin-top: .25rem; border-top: 1px dashed var(--line); padding-top: .95rem; }
    .fc-receipts summary { display: flex; align-items: center; gap: .6rem; cursor: pointer; color: var(--ink-dim); font-weight: 700; font-size: .85rem; list-style: none; user-select: none; border: 1px solid var(--line-strong); border-radius: 10px; padding: .6rem .85rem; background: var(--surface-2); transition: border-color .15s ease, color .15s ease, background-color .15s ease; }
    .fc-receipts summary:hover, .fc-receipts summary:focus-visible { border-color: var(--ass); color: var(--ink); background: var(--surface); }
    .fc-receipts summary:focus-visible { outline: 2px solid var(--ass); outline-offset: 2px; }
    .fc-receipts summary::-webkit-details-marker { display: none; }
    .fc-receipts summary::before { content: "▸"; color: var(--ass); font-size: .85rem; line-height: 1; }
    .fc-receipts[open] summary::before { content: "▾"; }
    .rec-count { margin-left: auto; font-size: .64rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--ass); background: rgba(212,240,0,.1); border: 1px solid rgba(212,240,0,.28); padding: .16rem .6rem; border-radius: 999px; }
    .fc-receipts ul { margin: .7rem 0 0; padding: .85rem 1rem; list-style: none; background: #0d0d0f; border: 1px solid var(--line); border-left: 3px solid var(--fc, #f87171); border-radius: 10px; }
    .fc-receipts li { margin: 0; font-family: var(--mono); font-size: .86rem; color: #cfcfd8; line-height: 1.6; overflow-wrap: anywhere; }
    .fc-receipts .rec-label { color: var(--ink-faint); font-family: var(--font-sans); }
    /* neutral evidence blocks (duplicated-page pairs, metric measurements):
       terminal-style panels inside the category sections */
    .rec-block { margin: 1rem 0 0; padding: .85rem 1rem; background: #0d0d0f; border: 1px solid var(--line); border-left: 3px solid var(--neutral); border-radius: 10px; }
    .rec-block .rec-label { display: block; color: var(--ink-faint); font-size: .68rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin-bottom: .35rem; }
    .rec-block ul { margin: .2rem 0 0; padding-left: 1.1rem; }
    .rec-block li, .rec-block em { font-family: var(--mono); font-size: .84rem; color: #c9c9d1; font-style: normal; overflow-wrap: anywhere; }
    .rec-block a { color: var(--ass); text-decoration: none; border-bottom: 1px dotted rgba(212,240,0,.5); }
    /* --- Positive results: real compliments render as rewarded, checkmarked
       items; when a scan has no compliments, an intentional A.S.S.-voiced
       empty panel. Compliments are never invented — only real scan
       measurements render here. --- */
    .working-list { list-style: none; padding: 0; margin: 1.1rem 0 .4rem; }
    .working-item { position: relative; margin: .7rem 0; padding: .85rem 1rem .8rem 2.6rem; background: rgba(74,222,128,.05); border: 1px solid rgba(74,222,128,.22); border-left: 4px solid var(--good); border-radius: 12px; }
    .working-item::before { content: "✓"; position: absolute; left: .9rem; top: .78rem; color: var(--good); font-weight: 800; font-size: 1.05rem; line-height: 1; }
    .working-point { display: block; color: var(--ink); font-size: .93rem; line-height: 1.55; }
    .working-point strong { color: var(--good); }
    .working-receipt { display: block; margin-top: .4rem; font-size: .8rem; color: var(--ink-dim); }
    .working-receipt em { font-family: var(--mono); font-size: .78rem; color: #c9c9d1; font-style: normal; overflow-wrap: anywhere; }
    .working-empty { margin: 1.1rem 0 .4rem; padding: 1.05rem 1.15rem; border: 1px dashed var(--line-strong); border-left: 4px solid var(--neutral); border-radius: 12px; background: rgba(255,255,255,.015); }
    .working-empty-line { margin: 0; color: var(--ink-dim); font-size: .92rem; font-style: italic; }
    /* --- The scanner-selected worst page renders as a panel card --- */
    .page-panel { margin: .4rem 0 1.2rem; padding: 1.05rem 1.15rem .95rem; border: 1px solid var(--line); border-left: 4px solid var(--pp, #f87171); border-radius: 14px; background: var(--surface); overflow-wrap: anywhere; }
    .page-head { margin: 0 0 .55rem; }
    .page-head a { color: var(--ink); text-decoration: none; border-bottom: 1px dotted var(--line-strong); }
    .page-head a:hover { color: var(--ass); border-color: var(--ass); }
    .page-list { margin: .25rem 0 0; }
    /* --- Priority fixes: ranked cards. Rank = real priority order (category
       severity desc); each card carries the category chip, state pill,
       problem, specific action, receipt and a link to the full finding. --- */
    .fix-list { list-style: none; counter-reset: fix; padding: 0; margin: 1.15rem 0 .4rem; }
    .fix-item { position: relative; margin: .8rem 0; padding: 1rem 1.05rem .9rem 3.5rem; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--fix, #f87171); border-radius: 14px; overflow-wrap: anywhere; }
    .fix-item::before { counter-increment: fix; content: counter(fix); position: absolute; left: 1.1rem; top: .95rem; font-family: var(--font-display); font-size: 1.8rem; line-height: 1; color: var(--fix, #f87171); font-weight: 400; }
    .fix-watch { --fix: #facc15; }
    .fix-needs-attention { --fix: #fb923c; }
    .fix-priority { --fix: #f87171; }
    .fix-top { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .45rem; }
    .fix-cat { font-size: .7rem; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim); background: rgba(255,255,255,.06); border: 1px solid var(--line); padding: .18rem .6rem; border-radius: 999px; }
    .fix-pill { font-size: .64rem; font-weight: 800; letter-spacing: .07em; padding: .18rem .55rem; border-radius: 999px; color: #0a0a0b; background: var(--fix, #f87171); }
    .fix-problem { margin: .15rem 0 .4rem; font-size: 1rem; font-weight: 700; line-height: 1.5; color: var(--ink); max-width: 78ch; }
    .fix-action { margin: .35rem 0; padding: .55rem .8rem; border-left: 3px solid var(--ass); background: rgba(212,240,0,.035); border-radius: 0 8px 8px 0; color: var(--ink-dim); font-size: .9rem; line-height: 1.6; max-width: 78ch; }
    .fix-action-label { display: block; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; font-size: .64rem; color: var(--ass); margin-bottom: .2rem; }
    .fix-evidence { margin: .3rem 0 .6rem; font-size: .82rem; color: var(--ink-faint); }
    .fix-evidence em { font-family: var(--mono); font-size: .78rem; color: #c9c9d1; font-style: normal; overflow-wrap: anywhere; }
    .fix-link { font-size: .8rem; font-weight: 800; color: var(--ass); text-decoration: none; border-bottom: 1px dotted rgba(212,240,0,.55); }
    .fix-link:hover { border-bottom-style: solid; }
    .fix-link:focus-visible { outline: 2px solid var(--ass); outline-offset: 2px; border-radius: 2px; }
    /* --- Closing verdict callout (band-tinted) --- */
    .final-note { margin: .4rem 0 0; padding: .95rem 1.1rem; border: 1px solid var(--line); border-left: 4px solid var(--band, #f87171); border-radius: 12px; background: rgba(255,255,255,.03); font-size: 1.03rem; line-height: 1.6; max-width: 78ch; }
    /* --- Closing-verdict analyst: the approved donkey-dashboard cutout as the
       authority figure next to the verdict sentence (Donkey System v3).
       The transparent PNG floats on the dark panel — no box, no border. --- */
    .final-analyst { display: flex; align-items: center; gap: 1.4rem; margin-top: .8rem; flex-wrap: wrap; }
    .final-donkey { width: clamp(96px, 24vw, 168px); height: auto; flex: none; filter: drop-shadow(0 10px 22px rgba(0,0,0,.45)); }
    .final-analyst .final-note { flex: 1 1 320px; margin: 0; }
    .footer { color: var(--ink-faint); font-size: .9rem; border-top: 1px solid var(--line); padding-top: .8rem; margin-top: 1.5rem; }
    ul, ol { margin: .4rem 0 1rem; padding-left: 1.25rem; }
    li { margin-bottom: .45rem; }
    .ins-roast { font-style: italic; color: var(--ink); font-weight: 600; margin: .3rem 0; font-size: .95rem; }
    .ins-why, .ins-fix { font-weight: 700; color: var(--ink-dim); margin-right: .25rem; }
    .rec-label { font-weight: 700; color: var(--ink-faint); font-size: .78rem; }
    .rec-note { color: var(--ink-faint); font-size: .87rem; font-style: italic; }
    .disclaimer { color: var(--ink-faint); font-size: .78rem; border-top: 1px solid var(--line); padding-top: .8rem; margin-top: 2rem; line-height: 1.6; }
    /* --- Phase 2C focused Category Views (hash-driven, single document).
       Chrome keeps the same classes the inline script selects on; the
       per-category accent is themed via :has() on the existing cv-state
       badge (pure CSS, no markup change, no data change). --- */
    #dashboard[hidden], .cat-view[hidden] { display: none !important; }
    .cat-view { max-width: 100%; padding-top: .4rem; }
    .cat-back { display: inline-flex; align-items: center; gap: .45rem; text-decoration: none; font-weight: 700; font-size: .85rem; color: var(--ink); border: 1px solid var(--line-strong); border-radius: 999px; padding: .55rem 1.05rem; margin: 0 0 1.5rem; background: var(--surface); transition: border-color .15s ease, color .15s ease; }
    .cat-back:hover, .cat-back:focus-visible { border-color: var(--ass); color: var(--ass); }
    .cat-back:focus-visible { outline: 2px solid var(--ass); outline-offset: 2px; }
    .cat-view-name { font-family: var(--font-display); font-size: 1.55rem; text-transform: uppercase; letter-spacing: .03em; margin: 0 0 .5rem; border: none; padding: 0 0 0 .65rem; border-left: 4px solid var(--view-accent, #8b8b95); color: var(--ink); font-weight: 400; }
    .cat-view:has(.cv-state-clean) { --view-accent: #4ade80; }
    .cat-view:has(.cv-state-watch) { --view-accent: #facc15; }
    .cat-view:has(.cv-state-needs-attention) { --view-accent: #fb923c; }
    .cat-view:has(.cv-state-priority) { --view-accent: #f87171; }
    .cat-view-state { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem; margin: .1rem 0 1.1rem; }
    .cv-none { color: var(--ink-faint); font-size: .92rem; }
    .cv-score { font-family: var(--font-display); font-weight: 400; font-size: 1.5rem; letter-spacing: .01em; color: var(--ink); }
    .cv-den { font-size: .85rem; font-weight: 600; color: var(--ink-faint); }
    .cv-state { font-size: .7rem; font-weight: 800; letter-spacing: .06em; padding: .18rem .6rem; border-radius: 999px; color: #0a0a0b; background: #8b8b95; }
    .cv-state-clean { background: #4ade80; }
    .cv-state-watch { background: #facc15; }
    .cv-state-needs-attention { background: #fb923c; }
    .cv-state-priority { background: #f87171; }
    .cv-line { color: var(--ink-dim); font-size: .92rem; }
    .cv-clean { list-style: none; padding: 0; margin: .3rem 0 1.1rem; }
    .cv-clean li { border-left: 3px solid #4ade80; background: rgba(74,222,128,.05); border-radius: 0 10px 10px 0; padding: .45rem .85rem; margin: .5rem 0; }
    .cv-clean .working-item { border-radius: 12px; margin: .5rem 0; }
    .cat-view-body .cat-detail { border: none; border-radius: 0; padding: 0; margin: 0; background: transparent; }
    .cat-view-body .cat-detail h3 { display: none; }
    /* --- Responsive: no horizontal overflow, nav intact at 390px --- */
    @media (max-width: 640px) {
      body { padding: 1.2rem .9rem 3rem; }
      .head-donkey { width: 44px; height: 44px; }
      .hero { padding: 2rem .9rem 1.35rem; }
      .cat-grid { grid-template-columns: 1fr; }
      .fc-roast, .fc-why, .fc-fix { max-width: none; }
      .fix-item { padding-left: 2.9rem; }
      .fix-item::before { left: .85rem; }
      .meta { font-size: .8rem; }
      .finding-card { padding: 1rem .95rem .95rem; }
      .fc-receipts summary { flex-wrap: wrap; }
      .rec-count { margin-left: 0; }
    }
    /* --- Print: receipts and the whole report stay legible on paper --- */
    @media print {
      body { background: #fff; color: #111; max-width: none; }
      .report-head { border-color: #d4d4d8; }
      .head-donkey { display: none; }
      h1 { color: #111; }
      .hero { background: #fafafa; border-color: #d4d4d8; }
      .hero .score { color: #111; }
      .cat-card, .finding-card, .cat-detail, .page-panel, .fix-item, .working-item { background: #fff; border-color: #d4d4d8; }
      .fc-receipts ul, .rec-block { background: #f6f6f6; border-color: #d4d4d8; }
      .cat-line, .fc-why, .fc-fix, .cv-line, .meta, .hint, .powered, .head-tag, .working-point, .fix-problem, .final-note { color: #333; }
      .fc-roast .ins-roast { color: #111; }
      .fc-receipts li, .rec-block li, .rec-block em, .working-receipt em, .fix-evidence em { color: #1a1a1e; }
      .working-point strong, .working-item::before { color: #16a34a; }
      .disclaimer { color: #555; border-color: #d4d4d8; }
      a { color: #000; }
    }
</style>
</head>
<body>
  <div id="dashboard">
  <header class="report-head">
    ${logo}
    <div class="head-row">
      <div class="head-text">
      ${header}
      <p class="head-tag">Be brutally honest about your website.</p>
      </div>
      <div class="head-donkey" role="img" aria-label="A.S.S. Score donkey mascot">
    </div>
    </div>
  </header>
  <p class="meta">
    <a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(humanScanDate(scan.created_at))}
  </p>

  <section class="hero" style="--band:${publicVerdict.color}">
    <p class="score"${scoreAccent}>A.S.S. Score: ${pubScore} / 100</p>
    <p class="hero-num" aria-hidden="true">
      <span class="hero-val">${pubScore}</span>
      <span class="hero-den">/ 100</span>
    </p>
    ${verdictLine}
    <div class="hero-gauge" aria-hidden="true">
      <span class="hero-gauge-fill" style="width:${pubScore}%"> </span>
    </div>
    <p class="hero-scale">0 = LEAST ASS / 100 = MAX ASS</p>
    ${pagesLine}
  </section>

  ${verdictSection}
  ${pageSection}
  ${fixSection}
  ${breakdownSection}
  ${workingSection}
  ${findingsSection}
  ${finalSection}
  ${methodologySection}
  ${footerLine}
  <p>Deterministic rule-based analysis — the same URL always produces the same score.</p>
  </div>
  ${categoryViews}
  ${categoryViewScript}
</body>
</html>`;
}