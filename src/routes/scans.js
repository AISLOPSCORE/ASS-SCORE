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
function renderFinding(scanId, categoryKey, categoryLabel, finding, insight, index) {
  const title = `Finding ${index + 1} · ${categoryLabel}`;
  const ins = insightFor(scanId, categoryKey, finding, insight, index);
  const roast = ins ? ins.roast : finding;
  const why = ins ? ins.why : '';
  const fix = ins ? ins.fix : '';
  const layers = ins
    ? `<p class="ins-roast">${esc(roast)}</p>
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
 * Render ONE clean/positive measurement for WHAT'S WORKING (owner IA §1-2): a
 * short "LABEL — CLEAN:" observation with its evidence receipt. Never a roast,
 * never a fix task, never counted as a finding.
 */
function renderCleanItem(categoryLabel, item) {
  const roast = item.insight && typeof item.insight.roast === 'string' && item.insight.roast !== ''
    ? item.insight.roast
    : 'No meaningful signal detected here.';
  return `<li><strong>${esc(categoryLabel)} — CLEAN:</strong> ${esc(roast)} <span class="rec-label">Receipt:</span> <em>${esc(short(item.finding, 140))}</em></li>`;
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
 * rebuild 2026-09-17, Phase 1). Section order: THE VERDICT → WHAT'S WORKING →
 * YOUR BREAKDOWN → THE ACTUAL FINDINGS → PAGE THAT NEEDS THE MOST WORK → WHAT
 * TO FIX FIRST → FINAL VERDICT → METHODOLOGY + mandated DISCLAIMER.
 *
 * Finding semantics (owner IA §1–4, §7–9):
 *   - WHAT'S WORKING holds CLEAN/positive detector results ONLY (compliments
 *     + their receipts; "COPY — CLEAN: …").
 *   - THE ACTUAL FINDINGS holds NEGATIVE findings ONLY, each in the four-part
 *     form THE ROAST / WHY IT MATTERS / HOW TO FIX IT / THE RECEIPTS.
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
 *     category severity, each as problem + specific action + evidence (§9).
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
    ? `<p>Pages scanned: ${cross.pages.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(', ')}${scan.partial && scan.note ? ` · ${esc(scan.note)}` : ''}</p>`
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
  <p>${esc(verdictConclusion(scan, pubScore, publicVerdict, negativeTotal))}</p>`;

  // --- 2. WHAT'S WORKING (clean/positive detector results only) --------------
  const cleanLis = classified
    .flatMap((g) => g.cleans.map((item) => renderCleanItem(CATEGORY_LABELS[g.key] ?? g.key, item)))
    .join('');
  const workingSection = `
  <h2>What's Working</h2>
  <ul>${cleanLis === ''
    ? '<li>Nothing to compliment this scan — the findings and measurements below are the whole story.</li>'
    : cleanLis}</ul>`;

  // --- 3. YOUR BREAKDOWN (7 customer-facing categories + classification) -----
  const breakdownLis = Object.entries(scan.breakdown ?? {}).map(([key, rule]) => {
    const label = CATEGORY_LABELS[key] ?? key;
    if (!(Number.isFinite(Number(rule?.score)) && rule.score !== null)) {
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

  // --- 4. THE ACTUAL FINDINGS (negative findings only, four concepts) --------
  const findingsIntro = negativeTotal === 0
    ? 'No findings this scan — nothing to roast, and nothing to hide.'
    : `${negativeTotal} finding${negativeTotal === 1 ? '' : 's'} across ${negativeCats.length} categor${negativeCats.length === 1 ? 'y' : 'ies'} — every roast points at the receipts below.`;
  // Groups render for categories with negative findings OR neutral metric
  // measurements — a metric-only category (e.g. low score but only MATTR/
  // stopword/sentence-length measurements) still shows its Measurements block.
  // negativeCats above stays strictly negative-only for the intro count, the
  // page summary, and What To Fix First (owner IA §4/§5/§8).
  const findingGroups = classified
    .filter((g) => g.negatives.length > 0 || g.metrics.length > 0)
    .map((g) => {
    const label = CATEGORY_LABELS[g.key] ?? g.key;
    const items = g.negatives
      .map((x, i) => renderFinding(scan.id, g.key, label, x.finding, x.insight, i))
      .join('');
    // Cross-page duplication pairs -> REPETITION receipts (real evidence,
    // replaces the old "Templated Content" section).
    const pairs = g.key === 'crossPage' && Array.isArray(cross.pairs)
      ? cross.pairs.filter((p) => p.similarity >= 0.8)
      : [];
    const pairsBlock = pairs.length > 0
      ? `<div><span class="rec-label">Duplicated page pairs (receipts):</span>
    <ul>${pairs.map((p) => `<li><a href="${esc(p.pageA)}">${esc(p.pageA)}</a> ~ <a href="${esc(p.pageB)}">${esc(p.pageB)}</a> — ${(p.similarity * 100).toFixed(1)}% similar</li>`).join('')}</ul>
  </div>`
      : '';
    // Out-of-band metric measurements render as NEUTRAL evidence (owner IA
    // §4): never a finding/roast, never counted — just the numbers, labelled
    // as measurements.
    const metricsBlock = g.metrics.length > 0
      ? `<div><span class="rec-label">Measurements:</span> <em>${g.metrics.map((m) => esc(m.finding)).join(' · ')}</em></div>`
      : '';
    return `
  <div>
    <h3>${esc(label)}</h3>
    ${items}
    ${pairsBlock}
    ${metricsBlock}
  </div>`;
  }).join('');
  const findingsSection = `
  <h2>The Actual Findings</h2>
  <p>${findingsIntro}</p>
  ${findingGroups}`;

  // --- 5. PAGE THAT NEEDS THE MOST WORK (owner IA §8) ------------------------
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
  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined score ${Number(worst.score)} / 100 (higher = worse).</p>
  <ul>${lis}</ul>`;
  } else {
    const lis = negativeCats.length > 0
      ? negativeCats.map((g) => `<li><strong>${esc(CATEGORY_LABELS[g.key] ?? g.key)}</strong> — ${g.negatives.length} actual finding${g.negatives.length === 1 ? '' : 's'} to fix.</li>`).join('')
      : '<li>Nothing to fix here this scan.</li>';
    pageSection = `
  <h2>Page That Needs The Most Work</h2>
  <p><strong>Homepage</strong> — this is the only page scanned.</p>
  <ul>${lis}</ul>`;
  }

  // --- 6. WHAT TO FIX FIRST (actual negative findings only, prioritized) -----
  // Owner IA §9: only NEGATIVE findings become to-dos (clean results and
  // metric measurements never do). Prioritized by category sub-score
  // descending (impact proxy; stable sort keeps finding order inside a
  // category); each item = problem + specific action + supporting evidence.
  // Cap at 5 for a scannable list.
  const fixItems = [];
  for (const g of classified) {
    if (g.negatives.length === 0) continue;
    const label = CATEGORY_LABELS[g.key] ?? g.key;
    g.negatives.forEach((x, i) => {
      const ins = insightFor(scan.id, g.key, x.finding, x.insight, i);
      fixItems.push({
        score: Number(g.rule?.score),
        label,
        problem: ins ? ins.roast : x.finding,
        action: ins ? ins.fix : '',
        evidence: x.finding,
      });
    });
  }
  fixItems.sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));
  const fixLis = fixItems.slice(0, 5)
    .map((it) => `<li><strong>${esc(it.label)}</strong> — ${esc(it.problem)} ${it.action ? `${esc(it.action)} ` : ''}<em>(receipt: ${esc(short(it.evidence, 90))})</em></li>`)
    .join('');
  const fixSection = `
  <h2>What To Fix First</h2>
  ${fixLis === '' ? '<p>No negative findings to fix this scan — nothing in this report needs fixing.</p>' : `<ol>${fixLis}</ol>`}`;

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
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(humanScanDate(scan.created_at))}</p>
  <p class="score"${scoreAccent}>A.S.S. Score: ${pubScore} / 100</p>
  ${verdictLine}
  ${pagesLine}
  ${verdictSection}
  ${workingSection}
  ${breakdownSection}
  ${findingsSection}
  ${pageSection}
  ${fixSection}
  ${finalSection}
  ${methodologySection}
  ${footerLine}
  <p>Deterministic rule-based analysis — the same URL always produces the same score.</p>
</body>
</html>`;
}