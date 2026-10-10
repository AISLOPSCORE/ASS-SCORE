/**
 * Shared FULL-report HTML renderers (extracted 2026-10-XX, feat/admin-full-report):
 * the report/result renderers + their helper closure were moved VERBATIM from
 * src/routes/scans.js so BOTH the token'd paid route (GET /api/v1/report/:id ->
 * renderHtmlReport) and the admin tool (GET /admin/report/:scanId ->
 * renderHtmlReport) serve the EXACT same bytes from ONE module — no copy-paste
 * divergence. renderFreeHtmlReport is the free result page; renderHtmlReport is
 * the full three-layer report a $12 buyer gets. roastInfoFor/breakdownFor live
 * here too because the renderers need them; scans.js imports them exactly the
 * way the paid route always did.
 */
import { isHttpUrl } from './branding.js';
import { selectRoastInfo } from './roast.js';
import { withInsights, isCleanEvidence, isMetricFinding, classifyFinding, buildCategoryInsights, parseEvidenceTokens, isBoilerplateAggregateLine } from './threeLayer.js';
import { withinCategoryGroups, groupAcrossCategories } from './groupFindings.js';
import { publicScore } from './serialize.js';
import { verdictBand, verdictLabel, scoreColor } from './verdict.js';
import { CATEGORY_LABELS, CATEGORY_ONE_LINERS } from './categories.js';
import { buildFreePayload, DISCLAIMER } from './paywall.js';

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
export function breakdownFor(scan) {
  return withInsights(scan.breakdown, scan.id);
}
function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Crawl-depth disclosure scope (owner 10-05, decision a): the honest "we
 * evaluated N of M pages" numbers. Returns null UNLESS both counts are stored,
 * finite, and M >= 1 — old rows (nulls) render no scope anywhere. The wording
 * is a dry limitation disclosure, never a roast; it must never claim we
 * reviewed pages we didn't (fetched is always <= discovered by construction:
 * fetched = pages actually analyzed <= 5; discovered = target + deduped
 * candidates the site exposed BEFORE the cap, never sliced).
 */
function crawlScope(fetched, discovered) {
  const n = Number(fetched);
  const m = Number(discovered);
  if (!Number.isFinite(n) || !Number.isFinite(m) || n < 0 || m < 1) return null;
  return { fetched: n, discovered: m, pageWord: m === 1 ? 'page' : 'pages' };
}

/**
 * Per-category classification from the sub-score (0-100, higher = worse).
 * Thresholds (judgment, documented): 0-24 CLEAN, 25-49 WATCH, 50-74 NEEDS
 * ATTENTION, 75-100 PRIORITY — the severity ladder the product uses
 * everywhere (clean -> watch -> needs attention -> priority, mirroring the
 * verdict band ramp), so a category's state and the report's overall verdict
 * read consistently. A category with zero findings always reads CLEAN
 * ("Nothing meaningful to roast here.").
 */
function categoryClass(score, findingsCount) {
  if (!Number.isFinite(Number(score)) || score === null || findingsCount === 0) return 'CLEAN';
  const s = Number(score);
  if (s >= 75) return 'PRIORITY';
  if (s >= 50) return 'NEEDS ATTENTION';
  if (s >= 25) return 'WATCH';
  return 'CLEAN';
}

/**
 * DISPLAY-state classification for a category — the report-contradiction
 * invariant (owner defect 2026-10-07: "6 roasts — see receipts" next to
 * "Nothing meaningful to roast here" on one card; "IMAGERY — CLEAN:" zero
 * lines next to "5 of 53 placeholder filenames"): a category with ≥1 ACTUAL
 * NEGATIVE finding must NEVER render as CLEAN anywhere in the report,
 * regardless of its sub-score band. A CLEAN-band category that also has
 * negative findings promotes to WATCH on every display surface (the card, the
 * What's Working gate, the finding-severity badges, the fix-first pills, the
 * focused-view state line); every other input is byte-identical to
 * categoryClass. DISPLAY-ONLY: categoryClass itself is untouched — its band
 * math stays deterministic for the non-display uses (methods, verdict copy).
 *
 * @param {number} score category sub-score (0-100, higher = worse)
 * @param {number} findingsCount stored findings-array length
 * @param {number} negativesCount count of ACTUAL negative findings (post
 *   classifyFinding split + boilerplate aggregate demotion → the same
 *   `negatives.length` the report's other sections count)
 * @returns {'CLEAN'|'WATCH'|'NEEDS ATTENTION'|'PRIORITY'} the DISPLAY state
 */
function categoryDisplayState(score, findingsCount, negativesCount) {
  const cls = categoryClass(score, findingsCount);
  if (cls === 'CLEAN' && Number(negativesCount) > 0) return 'WATCH';
  return cls;
}

// Word-boundary truncation lives in src/truncate.js (report-trust fix
// 2026-10-07) so the rules modules share ONE implementation; reportHtml
// re-exports it for all its internal call sites and test/fixFirst.test.js.
import { short } from './truncate.js';
export { short };


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
 * Final Verdict next-step kicker (owner reorder 2026-10-10): the closing line
 * is a NEXT-STEP instruction, not a second score sentence — the hero already
 * shows the number, and a repeat is the exact repetition the owner removed.
 * With negative findings it says fix the top items and rescan; a clean scan
 * gets the keep-it-up variant (never "fix the top items" when there is nothing
 * to fix). Never repeats the score and never uses "above"/"below" positionally
 * — the findings live in the category views opened from Your Breakdown, which
 * sit ABOVE this line, so any positional reference would be a lie (report-trust
 * defect class).
 */
function finalVerdictSentence(negativeTotal) {
  return Number(negativeTotal) > 0
    ? 'Fix the top items, then rescan — the score is waiting to drop.'
    : 'Nothing to fix this scan — keep it up, and rescan after any big changes.';
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
      // idx = stored findings index: the deterministic seed position of the
      // insight and the position of `sources[i]` (ONE PROBLEM = ONE FINDING,
      // owner 2026-10-07 — src/groupFindings.js).
      idx: i,
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
 * `extraEvidence` (report-integrity fix 2026-09-28, audit Q3): the demoted
 * boilerplate AGGREGATE lines (the density totals) ride in the FIRST card's
 * receipts drawer — one signal stays ONE card while the legitimate "5.5 per
 * 300 words" measurement remains visible as evidence.
 *
 * Markup constraint (sacred): the classed spans sit inside UNCLASSED
 * containers — a classed parent immediately followed by a child tag would
 * emit a literal `"><` sequence, which the report's blanket no-raw-delimiter
 * assertion (branding hostile test) rejects. Every classed element here is
 * followed by escaped text, never by a tag.
 */
function renderFinding(scanId, categoryKey, categoryLabel, finding, insight, index, state = null, ordinal = index + 1, extraEvidence = [], anchorId = null) {
  const ins = insightFor(scanId, categoryKey, finding, insight, index);
  const roast = ins ? ins.roast : finding;
  const why = ins ? ins.why : '';
  const fix = ins ? ins.fix : '';
  // Phase 2B diagnostic card — each negative finding is ONE clearly separated
  // card with four labeled zones: THE ROAST / WHY IT MATTERS / HOW TO FIX IT /
  // RECEIPTS. The label TEXT stays exactly as Phase 1 emitted it (so every
  // existing assertion still matches); the display case is applied via CSS
  // text-transform. The severity badge comes from the SAME existing category
  // display classification (categoryDisplayState on the stored sub-score) —
  // never invented; CLEAN is never badgeable (a category with negative
  // findings promotes to WATCH at minimum).
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
  const extras = Array.isArray(extraEvidence) ? extraEvidence.map((x) => String(x)).filter((x) => x !== '') : [];
  const evidenceCount = 1 + extras.length;
  const receiptLis = `<li><strong>${esc(finding)}</strong></li>${extras.map((x) => `<li><strong>${esc(x)}</strong></li>`).join('')}`;
  // anchorId: stable per-finding deep-link target (owner 2026-10-07) — the
  // "See the full finding" links in What To Fix First point at the matching
  // card inside its category's focused view (id="finding-<cat>-<n>", n = the
  // within-category ordinal shown on the "Finding n" badge). Presentation
  // only: an id attribute, no visible change.
  const cardId = anchorId ? ` id="${anchorId}"` : '';
  return `\n  <div class="finding-card"${cardId}>
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
          <span class="rec-count">${evidenceCount} line${evidenceCount === 1 ? '' : 's'} of evidence</span>
        </summary>
        <ul>${receiptLis}</ul>
      </details>
    </div>
  </div>`;
}

/**
 * Is a category a legitimate WHAT'S WORKING compliment source? The exact same
 * inputs as the breakdown card DISPLAY classification (categoryDisplayState on
 * the stored sub-score + stored findings count + actual-negative count), used
 * to gate compliments: WHAT'S WORKING only ever compliments truly CLEAN
 * categories (audit Q2, owner-approved 2026-09-28) — a WATCH/45 category with
 * an in-band measurement line must never be advertised as "CLEAN" in the same
 * report that flags it, and (owner defect 2026-10-07) a CLEAN-band category
 * with ≥1 negative finding must never have its zero-sibling clean lines
 * surface as "— CLEAN:" compliments next to the roasts that flag it. Skipped
 * (null score) categories are never CLEAN-band compliment sources.
 */
function isCleanBand(key, rule, negativesCount) {
  if (!(Number.isFinite(Number(rule?.score)) && rule.score !== null)) return false;
  const sub = publicScore(rule.score);
  const nFindings = Array.isArray(rule.findings) ? rule.findings.length : 0;
  return categoryDisplayState(sub, nFindings, negativesCount) === 'CLEAN';
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
 * not page problems — they never count. ONE SIGNAL = ONE FINDING (audit Q3,
 * owner-approved 2026-09-28): a boilerplate AGGREGATE (totals) line counts
 * only when it is the page's only boilerplate line — when detail lines exist,
 * the detail lines carry the signal and the totals line is a measurement, not
 * another finding. Deterministic: the rule modules' own evidence formats
 * identify both the category and the class, so a metric line can never be
 * presented as a page problem.
 */
export function worstPageSummary(findings = []) {
  const per = new Map();
  for (const raw of findings) {
    const f = String(raw ?? '');
    const key = WORST_PAGE_KEYS.find((k) => Object.keys(parseEvidenceTokens(k, f)).length > 0);
    if (!key || isCleanEvidence(key, f) || isMetricFinding(key, f)) continue;
    per.set(key, [...(per.get(key) ?? []), f]);
  }
  const out = [];
  for (const [key, lines] of per) {
    if (key === 'boilerplate' && lines.length > 1) {
      const details = lines.filter((l) => !isBoilerplateAggregateLine(l));
      if (details.length > 0) {
        out.push([key, details.length]);
        continue;
      }
    }
    out.push([key, lines.length]);
  }
  return out;
}

/**
 * Human-short label for a URL (report-trust fix 2026-10-07 style): the
 * pathname + search when parseable, a word-truncated fallback otherwise
 * (never mid-word), and the raw URL when the path is just "/". Shared by the
 * fix-first context line and the dup-pair suffix so both render the same
 * short form.
 */
function humanShortUrl(raw) {
  let label = String(raw ?? '');
  if (!label) return '';
  try {
    const u = new URL(label);
    const path = `${u.pathname}${u.search}`;
    if (path && path !== '/') label = path;
  } catch {
    label = short(label, 60);
  }
  if (label === '/') label = String(raw);
  return label;
}

/**
 * ONE "where the problems live" line for What To Fix First (owner reorder
 * 2026-10-10): the removed "Page That Needs The Most Work" panel's evidence
 * moved here — a single line directly above the fix list, multi-page scans
 * ONLY (multi-page = scan.worstPage is set) and only when there is actually
 * something to fix (negativeTotal > 0 — an empty fix list plus "most issues
 * on X" would contradict; the existing empty sentence stays as-is).
 * Real data only: `worst` and `worst.dupPair` come straight from the stored
 * scan (scan.js). When the worst page belongs to a flagged duplicate pair,
 * the SAME report-trust evidence as the old panel rides this line
 * ("<pct>% identical to <other> — same content, different URL."); the
 * percentage is (similarity * 100) with one decimal, exactly like the
 * crossPage receipts. Returns '' when there is no worst page or nothing to
 * fix.
 */
function mostIssuesLine(worst, negativeTotal) {
  if (!worst || Number(negativeTotal) <= 0) return '';
  const url = String(worst.url ?? '');
  if (!url) return '';
  const label = humanShortUrl(url);
  let line = `Most issues are on <a href="${esc(url)}">${esc(label)}</a>.`;
  const pair = worst?.dupPair;
  if (pair && Number.isFinite(Number(pair.similarity))) {
    const sim = Number(pair.similarity);
    if (sim >= 0 && sim <= 1) {
      const pct = (sim * 100).toFixed(1);
      const otherLabel = humanShortUrl(pair.otherUrl);
      if (otherLabel) {
        line += ` — <strong>${esc(pct)}% identical</strong> to <a href="${esc(pair.otherUrl)}">${esc(otherLabel)}</a> (same content, different URL).`;
      }
    }
  }
  return line;
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
export function renderFreeHtmlReport(scan, shareBase = 'https://ass-score.com') {
  const pub = buildFreePayload(scan);
  const band = verdictBand(pub.score);
  // Crawl-depth disclosure on the free page too (owner 10-05): one dry line,
  // ONLY when the counts are stored. Never lists pages — just the two numbers.
  const scope = pub.crawl ? crawlScope(pub.crawl.fetched, pub.crawl.discovered) : null;
  const scopeLine = scope
    ? `<p class="scope">This scan evaluated ${scope.fetched} of the ${scope.discovered} ${scope.pageWord} found on this site (up to 5 pages are reviewed per scan by design).</p>`
    : '';
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
    .scope { color: #64748b; font-size: .85rem; font-style: italic; }
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
  ${scopeLine}
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
 * Page order (dashboard reorder, owner 2026-10-10 — reorder + tightening:
 * the verdict joke moved into the score card, the worst-page panel and the
 * flat-findings remnant were removed): SCORE CARD (number + pill + roast joke
 * + gauge + scale) → YOUR BREAKDOWN (category cards — the drill-down entry
 * point, first so the numbered sections read 01-05) → WHAT TO FIX FIRST
 * (with the ONE-line worst-page context on multi-page scans) → WHAT'S WORKING
 * → [hidden Phase 2C clone-source] → FINAL VERDICT (next-step kicker) →
 * METHODOLOGY (scope + pages list + mandated DISCLAIMER). Phase 2A is
 * presentation-only: every content string (roast copy, why/fix, receipts,
 * methodology, disclaimer) is emitted verbatim by the sections below.
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
 *   - WHAT TO FIX FIRST lists actual negative findings only, prioritized by
 *     category severity, each as a COMPACT ranked summary (rank/pill,
 *     category + severity, one-line what-to-fix, link to the category view) —
 *     never a repeat of the full Roast/Why/Fix/Receipts (§9, cleanup pass).
 *     ON MULTI-PAGE SCANS WITH FINDINGS a single context line above the list
 *     names where the problems live ("Most issues are on <page>." — §8), with
 *     the report-trust dup-pair evidence riding it when the worst page belongs
 *     to a flagged duplicate pair; the standalone worst-page panel is gone
 *     (owner reorder 2026-10-10).
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
export function renderHtmlReport(scan) {
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
  const verdictClass = { 'BEYOND ASS': 'b-beyond', 'CATASTROPHICALLY ASSY': 'b-catastrophic', 'EXTREMELY ASSY': 'b-extreme', 'HEAVILY ASSY': 'b-heavily-assy', 'VERY ASSY': 'b-very', 'PRETTY ASSY': 'b-pretty-assy', 'ASSY': 'b-assy', 'SLIGHTLY ASSY': 'b-slightly-assy', 'MOSTLY CLEAN': 'b-mostly-clean', 'CLEAN': 'b-clean' }[publicVerdict.shortLabel] ?? 'b-very';
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
  // ONE PROBLEM = ONE FINDING (owner 2026-10-07): each category's negative
  // findings are grouped WITHIN the category (Phase A summary/detail collapse
  // + same-component merges, legacy-safe — src/groupFindings.js), and the
  // FLAT list additionally merges the same component across categories (Phase
  // B, new scans only via stored `sources`). Cross-category merging exists
  // ONLY in the flat list; the category cards and focused views show each
  // category's own grouped view.
  const classified = Object.entries(scan.breakdown ?? {}).map(([key, rule]) => {
    const g = splitCategory(key, rule);
    const groups = withinCategoryGroups(key, g.negatives, rule.sources);
    return { key, rule, ...g, groups, negativeCount: groups.length };
  });
  const flatGroups = groupAcrossCategories(
    classified
      .filter((g) => g.negatives.length > 0)
      .map((g) => ({ key: g.key, groups: g.groups, sources: g.rule.sources })),
  );
  const negativeTotal = flatGroups.length;
  // The worst page (multi-page scans only — scan.js sets it whenever ≥2 pages
  // were analyzed). Its evidence feeds the fix-first context line
  // (mostIssuesLine); the old "Page That Needs The Most Work" panel is gone
  // (owner reorder 2026-10-10).
  const worst = scan.worstPage || null;

  // --- 1. THE VERDICT --------------------------------------------------------
  // REMOVED as its own section (owner reorder 2026-10-10): the verdict joke —
  // `${roastInfo.emoji} ${roastInfo.line}` — moved INTO the score card, the
  // first thing the buyer sees, directly under the badge pill; the conclusion
  // paragraph (a score repeat) is deleted with the section.

  // --- 5. WHAT'S WORKING (clean/positive detector results only; rendered
  // below the breakdown, per the Phase 2A target hierarchy). COMPLIMENT GATE
  // (audit Q2, owner-approved 2026-09-28): a category's clean measurements
  // render here ONLY when the category is CLEAN-band (sub-score 0-24) — a
  // WATCH+ category is never advertised as "CLEAN" in the same report that
  // flags it (ORIGINALITY 45/WATCH + "ORIGINALITY — CLEAN" contradiction).
  // DESIGN now compliments too: the fingerprints rule emits a clean line on a
  // zero-hit scan, so its (previously unreachable) compliments pool fires. ---
  const cleanLis = classified
    .filter((g) => isCleanBand(g.key, g.rule, g.negativeCount))
    .flatMap((g) => g.cleans.map((item) => renderCleanItem(CATEGORY_LABELS[g.key] ?? g.key, item)))
    .join('');
  const workingSection = `
  <h2>What's Working</h2>
  ${cleanLis === ''
    ? '<p class="working-empty">Nothing to compliment this scan — the findings tell the whole story.</p>'
    : `<ul class="working-list">
  ${cleanLis}
  </ul>`}`;

  // --- 4. YOUR BREAKDOWN (7 customer-facing CATEGORY CARDS, Phase 2A shell) ---
  // Each category renders as a CLICKABLE card whose href="#cat-<key>" hash now
  // opens that category's FOCUSED view (Phase 2C) — the inline script shows the
  // matching #view-cat-<key> section. The dashboard's own id="cat-<key>"
  // sections stay in place (Phase 2A anchor contract + the no-JS degraded path
  // still scroll to them). The number + state come from the SAME existing
  // classification as the old list (categoryDisplayState on the stored
  // sub-score + negative count, i.e. categoryClass with the CLEAN->WATCH
  // promotion for flagged categories; stored note for skipped modules) — no
  // recalculation, no reinterpretation of the category's own data.
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
    // Findings-or-not line: counts NEGATIVE findings only (the report-wide
    // convention — compliments and metric measurements are never "findings").
    const grp = classified.find((x) => x.key === key);
    const negs = grp ? grp.groups.length : 0;
    const metr = grp ? grp.metrics.length : 0;
    // DISPLAY state (owner defect 2026-10-07): a CLEAN-band category with
    // actual negative findings promotes to WATCH — "Nothing meaningful to
    // roast here." must never render next to "N roasts — see receipts".
    const cls = categoryDisplayState(sub, nFindings, negs);
    const stateClass = cls === 'NEEDS ATTENTION' ? 'cat-attention' : `cat-${cls.toLowerCase()}`;
    const line = cls === 'CLEAN' ? 'Nothing meaningful to roast here.' : (CATEGORY_ONE_LINERS[key] ?? '');
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

  // --- 6. PER-CATEGORY FINDING SECTIONS (Phase 2C clone-source) -------------
  // Owner 2026-10-07: the dashboard's flat "The Actual Findings" list is
  // REMOVED — the per-category focused views are the canonical homes for
  // findings (each card: roast / why / fix / receipts). What To Fix First
  // deep-links into them (id="finding-<cat>-<n>"). The sections below stay in
  // the document as the hidden Phase 2C clone-source: id="cat-<key>" anchors
  // (breakdown cards + no-JS hash scroll) + the full per-category cards. They
  // must NOT be removed — the focused views clone them client-side and the
  // finding cards carry the deep-link anchors.
  // Groups render for categories with negative findings OR neutral metric
  // measurements — a metric-only category (e.g. low score but only MATTR/
  // stopword/sentence-length measurements) still shows its Measurements block.
  // Phase 2A shell: EVERY category gets an anchor target id="cat-<key>" here
  // (the breakdown cards link to it). Categories with negative findings render
  // their finding cards; metric-only categories render their NEUTRAL
  // Measurements block; clean/skipped categories render ONLY an invisible
  // anchor marker (dashboard final cleanup — no more "Nothing meaningful to
  // roast here" placeholder cards inside THE ACTUAL FINDINGS).
  // ONE PROBLEM = ONE FINDING (owner 2026-10-07): THE ACTUAL FINDINGS render
  // the FLAT GROUPED list (cross-category merges live ONLY here, in the global
  // ordinals and intro). The per-category `#cat-<key>` sections below it are
  // the Phase 2C data-source: each carries its OWN within-category-grouped
  // negatives, hidden in the dashboard so no card is ever shown twice — the
  // focused view clones the section (client-side, unchanged Phase 2C wiring).
  const catState = new Map(classified.map((g) => [g.key, (() => {
    const fgScore = g.rule?.score;
    const fgSub = (Number.isFinite(Number(fgScore)) && fgScore !== null) ? publicScore(fgScore) : null;
    const fgCount = Array.isArray(g.rule?.findings) ? g.rule.findings.length : 0;
    // Phase 2B: severity badges come from the SAME existing category
    // classification (categoryDisplayState on the stored sub-score + finding
    // count + grouped negative count) — never a new/reinterpreted severity.
    // CLEAN is never badgeable here: a category with negative findings is
    // never CLEAN (and a CLEAN-band one promotes to WATCH).
    const state = (g.negativeCount > 0 && fgSub !== null) ? categoryDisplayState(fgSub, fgCount, g.negativeCount) : null;
    return { state, sub: fgSub };
  })()]));
  /** Receipt lines for a grouped card: labeled with the member's category when
   *  the group spans categories (owner rule — receipts are the evidence). */
  const receiptTexts = (receipts) => receipts
    .map((r) => {
      if (!r || typeof r !== 'object' || !('text' in r)) return String(r ?? '');
      const t = String(r.text);
      return r.catKey ? `${CATEGORY_LABELS[r.catKey] ?? r.catKey} — ${t}` : t;
    })
    .filter((x) => x !== '');
    // (The FLAT card list — global ordinals "Finding 1, 2, 3…" — was REMOVED
  // with the dashboard's "The Actual Findings" section, owner 2026-10-07.
  // What remains visible is the h2 + the "N findings across M categories"
  // count line (restored 2026-10-07); the per-category cards below are the
  // canonical findings homes inside the focused category views. `flatGroups`
  // stays the fix-first ranking source + finding totals.)
  const findingGroups = classified.map((g) => {
    const label = CATEGORY_LABELS[g.key] ?? g.key;
    if (!(g.negativeCount > 0 || g.metrics.length > 0)) {
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
    // Phase 2D-1: the section carries a semantic state accent class (watch /
    // needs-attention / priority / neutral) — presentation only, same
    // classification as the cards; never a data change. `cat-detail-empty`
    // stays intact in its own className for the 2C clone check.
    const st = catState.get(g.key);
    const fgAccent = (!st || st.state === null) ? 'neutral' : (st.state === 'NEEDS ATTENTION' ? 'needs-attention' : st.state.toLowerCase());
    const items = g.groups.map((grp, i) => {
      const label = CATEGORY_LABELS[g.key] ?? g.key;
      // Per-category ordinals inside the focused drill-down (the flat list
      // above carries the global ordinals; this section is the clone source).
      // Each card carries its deep-link anchor id="finding-<cat>-<n>" — the
      // fix-first "See the full finding" targets (owner 2026-10-07).
      return renderFinding(scan.id, g.key, label, grp.primary.finding, grp.primary.insight,
        grp.primary.idx, st ? st.state : null, i + 1, receiptTexts(grp.receipts),
        `finding-${g.key.toLowerCase()}-${i + 1}`);
    }).join('');
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
  // The hidden Phase 2C clone-source (owner 2026-10-07, repositioned + unheaded
  // 2026-10-10): the dashboard's "The Actual Findings" h2 and its count line
  // are REMOVED (the flat-findings remnant — the owner calls it leftover) —
  // what stays is the hidden div carrying the id="cat-<key>" anchors
  // (breakdown cards, no-JS hash scroll) and the full per-category finding
  // cards, including the id="finding-<cat>-<n>" deep-link targets the fix-first
  // "See the full finding" links use. It must remain hidden and verbatim; the
  // focused views clone from it on open.
  const catSourcesSection = `
  <div class="cat-sources" hidden>
  ${findingGroups}
  </div>`;

  // --- 2. PAGE THAT NEEDS THE MOST WORK (owner IA §8) ------------------------
  // REMOVED as its own section (owner reorder 2026-10-10): both branches —
  // the multi-page worst-page panel (with its per-category counts and the
  // dup-pair line) and the single-page "Homepage — the only page scanned"
  // panel — are gone. The multi-page evidence now lives in ONE line above the
  // fix list (mostIssuesLine, below); single-page scans render no page line
  // at all. `worstPageSummary` + `WORST_PAGE_KEYS` STAY (exported; the
  // report-quality tests exercise them directly via src/routes/scans.js).

  // --- 3. WHAT TO FIX FIRST (actual negative findings only, prioritized) -----
  // Owner IA §9: only NEGATIVE findings become to-dos (clean results and
  // metric measurements never do). Prioritized by category sub-score
  // descending (impact proxy; stable sort keeps finding order inside a
  // category); capped at 5 for a scannable list. Each item renders as a
  // COMPACT summary (dashboard final cleanup) — see the map below.
  const fixItems = [];
  // ONE PROBLEM = ONE FINDING (owner 2026-10-07): to-dos come from the GROUPED
  // flat set — one ranked item per grouped problem (the merged card's primary
  // finding carries the roast/fix; its member evidence rides in the card's
  // receipts). Prioritized by the PRIMARY category's sub-score descending
  // (impact proxy; stable sort keeps the flat list's order inside a category);
  // capped at 5 for a scannable list.
  for (const fg of flatGroups) {
    const g = classified.find((c) => c.key === fg.key);
    if (!g) continue;
    const label = CATEGORY_LABELS[fg.key] ?? fg.key;
    const sub = (Number.isFinite(Number(g.rule?.score)) && g.rule?.score !== null) ? publicScore(g.rule.score) : 0;
    const nFindings = Array.isArray(g.rule?.findings) ? g.rule.findings.length : 0;
    // DISPLAY state: a CLEAN-band category with negative findings promotes to
    // WATCH so its fix pill never reads "CLEAN" next to a fix task (owner
    // defect 2026-10-07 — same promoted state as the card + badges).
    const cls = categoryDisplayState(sub, nFindings, g.negativeCount);
    const ins = insightFor(scan.id, fg.key, fg.primary.finding, fg.primary.insight, fg.primary.idx);
    fixItems.push({
      key: fg.key,
      score: Number(g.rule?.score),
      label,
      cls,
      problem: ins ? ins.roast : fg.primary.finding,
      action: ins ? ins.fix : '',
      evidence: fg.primary.finding,
      // primary reference — resolves the matching card inside the category's
      // focused view for the deep-link anchor (owner 2026-10-07).
      primary: fg.primary,
    });
  }
  fixItems.sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));
  // OWNER DEFECTS 2026-10-07 (\"the section customers will act on\"):
  // (1) DEDUPE — the per-category insight pool hands every finding in one
  // category the same fix sentence, so a (key, problem, action) triple that
  // already appeared earlier in the sorted list is skipped (with the headline
  // added, word-for-word repeats are worthless). Runs on the FULL sorted
  // candidate list, BEFORE any top-N selection.
  // (2) PER-CATEGORY CAP — one hot category must never fill all five slots:
  // walk the deduped candidates and accept each until 5 are accepted total or
  // that category already contributed 2 (so ≥3 distinct categories surface
  // whenever ≥3 categories have negative findings). Deterministic and stable:
  // the walk preserves the score-desc order and each category's finding order.
  const seenFixTriples = new Set();
  const dedupedFixItems = [];
  for (const it of fixItems) {
    const triple = JSON.stringify([it.key, it.problem, it.action]);
    if (seenFixTriples.has(triple)) continue;
    seenFixTriples.add(triple);
    dedupedFixItems.push(it);
  }
  const fixItemsTop5 = [];
  const fixCatCount = new Map();
  for (const it of dedupedFixItems) {
    if (fixItemsTop5.length >= 5) break;
    const used = fixCatCount.get(it.key) ?? 0;
    if (used >= 2) continue;
    fixCatCount.set(it.key, used + 1);
    fixItemsTop5.push(it);
  }
  // Each fix is a COMPACT RANKED SUMMARY (dashboard final cleanup 2026-09-23):
  // rank (CSS counter) + state pill + category chip + a headline naming the
  // CONCRETE PROBLEM (the finding's own trigger line — owner defect 2026-10-07:
  // items were indistinguishable word-for-word) + ONE-LINE what-to-fix + a
  // link into the category view — never a repeat of the full Roast / Why /
  // How To Fix / Receipts (those live once, in the category's focused view).
  // Rank = real priority order (category severity desc). Links point at the
  // MATCHING finding card inside its category's focused view
  // (id="finding-<cat>-<n>", owner 2026-10-07) — with JS the view opens and
  // scrolls to that card; without JS the hash still resolves to the card's
  // anchor in the hidden clone-source (see script).
  const fixLis = fixItemsTop5
    .map((it) => {
      // Headline = the finding's own title line (the concrete trigger, e.g.
      // '2× repeated block: \"Orbitype: The Go-to-Market Runtime\"'), NOT the
      // joke roast — the roast describes, the trigger identifies. Falls back
      // to the roast only when the finding line is empty. Word-boundary
      // truncated at 160 so the problem reads whole (owner defect: cuts were
      // landing mid-sentence).
      const problem = short(String(it.evidence !== '' ? it.evidence : it.problem), 160);
      const summary = it.action
        ? short(String(it.action), 120)
        : 'See the full finding for the concrete fix.';
      // Deep link into the MATCHING finding inside its category's focused
      // view (owner 2026-10-07): anchor by category + within-category ordinal
      // (the id="finding-<cat>-<n>" on the card in the hidden clone-source,
      // which the view clones verbatim). Resolution via object identity — the
      // flat group's primary IS the category group's primary (same reference,
      // groupAcrossCategories). Fallback to the category anchor if the card
      // can't be resolved (never dead-ends).
      const gCat = classified.find((c) => c.key === it.key);
      const withinIdx = gCat ? gCat.groups.findIndex((grp) => grp.primary === it.primary) : -1;
      const deep = withinIdx >= 0
        ? `finding-${it.key.toLowerCase()}-${withinIdx + 1}`
        : `cat-${it.key.toLowerCase()}`;
      return `\n  <li class="fix-item fix-${it.cls.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">
    <div class="fix-top">
      <span class="fix-cat">${esc(it.label)}</span>
      <span class="fix-pill">${esc(it.cls)}</span>
    </div>
    <p class="fix-problem">${esc(problem)}</p>
    <p class="fix-action">
      <span class="fix-action-label">Fix it:</span> ${esc(summary)}
    </p>
    <a class="fix-link" href="#${deep}">See the full finding →</a>
  </li>`;
    })
    .join('');
  // Where-the-problems-live context (owner reorder 2026-10-10): ONE line above
  // the list, multi-page scans with findings ONLY — the old Page panel's
  // evidence in its new place (mostIssuesLine). The existing empty sentence
  // stays untouched when there is nothing to fix.
  const mostLine = mostIssuesLine(worst, negativeTotal);
  const fixSection = `
  <h2>What To Fix First</h2>
  <p class="hint">Ranked by category severity — the highest A.S.S. score first. Fix these and the number drops.</p>
  ${mostLine === '' ? '' : `<p class="fix-context">${mostLine}</p>`}
  ${fixLis === '' ? '<p>No negative findings to fix this scan — nothing in this report needs fixing.</p>' : `<ol class="fix-list">${fixLis}</ol>`}`;

  // --- 7. FINAL VERDICT ------------------------------------------------------
  // The approved donkey-dashboard cutout appears here as the "analyst" —
  // the authority figure signing off on the verdict (Donkey System spec v3).
  // /assets/donkey-dashboard.png is served by this router on the same origin.
  const finalSection = `
  <h2>Final Verdict</h2>
  <div class="final-analyst">
    <img class="final-donkey" src="/assets/donkey-dashboard.png" alt="The A.S.S. analyst — final verdict" width="384" height="737" loading="lazy" />
    <p class="final-note" style="--band:${publicVerdict.color}">${esc(finalVerdictSentence(negativeTotal))}</p>
  </div>`;

  // --- 8. METHODOLOGY + mandated DISCLAIMER (never cut, never reworded) ------
  const partialNote = scan.partial && scan.note ? ` Some pages could not be scanned this run: ${esc(scan.note)}.` : '';
  // Crawl-depth disclosure (owner 10-05): one dry scope line, ONLY when the
  // counts are stored (old rows render exactly as before — no line).
  const scope = crawlScope(scan.crawlFetched, scan.crawlDiscovered);
  const scopeLine = scope
    ? `<p class="scope">Scope: this report evaluated ${scope.fetched} of the ${scope.discovered} ${scope.pageWord} found on this site (the scanner reviews up to 5 pages per scan by design).</p>`
    : '';
  // The "Pages scanned" list moved here from the hero (owner reorder
  // 2026-10-10): the same links, the same .pages styling, placed directly
  // under the methodology paragraph (fine-print group). This keeps the "same
  // URL always produces the same score" sentence the ONLY such occurrence in
  // the report (the old footer duplicate was removed).
  const methodologySection = `
  <h2>Methodology</h2>
  <p>Every finding in this report comes from a deterministic, rule-based analysis of the pages we fetched — the same URL always produces the same score. The seven categories look for concrete, documented patterns: filler words, generic marketing wording, thin content that pads the page, repeated text, the same content on multiple pages, recognizable website templates, and generic images. Every finding lists the verbatim evidence behind it, and the overall A.S.S. Score is the weighted rollup of the seven category scores.${partialNote}</p>
  ${pagesLine}
  ${scopeLine}
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
  // (categoryDisplayState on the stored sub-score + negative count;
  // CATEGORY_ONE_LINERS) — no reinterpretation. Clean categories show their clean items; a category with
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
      // DISPLAY state: same promotion as the card — a CLEAN-band category with
      // negative findings must not show a CLEAN pill in its focused view.
      const cls = categoryDisplayState(sub, nFindings, g?.groups.length ?? 0);
      stateLine = `\n    <span class="cv-score">${sub}<span class="cv-den">/100</span></span>\n    <span class="cv-state cv-state-${cls.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${esc(cls)}</span>\n    <span class="cv-line">${esc(CATEGORY_ONE_LINERS[key] ?? '')}</span>`;
    }
    // Compliment gate (audit Q2, owner-approved 2026-09-28): a category's
    // clean measurements render in its focused view ONLY when the category is
    // CLEAN-band — a WATCH/45 category must not show a "— CLEAN:" compliment
    // next to its WATCH badge (same rule as the What's Working list; a
    // CLEAN-band category with negative findings is likewise excluded via
    // categoryDisplayState, owner defect 2026-10-07).
    const cleanLis = (g && g.cleans.length > 0 && isCleanBand(key, rule, g?.groups.length ?? 0))
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
   A #finding-<cat>-<n> hash (the fix-first "See the full finding" targets)
   opens that category's view AND scrolls to the matching finding card.
   Unknown or empty hash = dashboard. With JS off, the report is simply the
   dashboard and the cards' native hash anchors scroll as in Phase 2A. */
(function () {
  var KEYS = ['${viewKeys.join("','")}'];
  function currentTarget() {
    var h = (location.hash || '').replace(/^#/, '');
    if (KEYS.indexOf(h) !== -1) return { key: h, finding: null };
    // Deep-link into ONE finding card: #finding-<cat>-<n>. <cat> must be a
    // real category (KEYS gate) — unknown hashes fall through to the
    // dashboard. The <n> is the within-category ordinal, matching the card's
    // id in the clone-source and its "Finding n" badge.
    var m = /^finding-([a-z0-9]+)-(\d+)$/.exec(h);
    if (m) {
      var full = 'cat-' + m[1];
      if (KEYS.indexOf(full) !== -1) return { key: full, finding: h };
    }
    return null;
  }
  function showDashboard() {
    var d = document.getElementById('dashboard');
    if (d) d.hidden = false;
    var views = document.querySelectorAll('.cat-view');
    for (var i = 0; i < views.length; i++) views[i].hidden = true;
    window.scrollTo(0, 0);
  }
  function openView(key, finding) {
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
    // Deep link: scroll to the exact finding card inside the opened view (the
    // clone keeps the card's id). Fall back to the view top otherwise.
    if (finding) {
      var el = view.querySelector('#' + finding);
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, 0);
  }
  function apply() {
    var t = currentTarget();
    if (t) openView(t.key, t.finding); else showDashboard();
  }
  window.addEventListener('hashchange', apply);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  window.addEventListener('load', function () {
    // Category-level hashes keep the previous scroll-to-top on load; deep
    // finding hashes land on the card (no scroll reset needed).
    var t = currentTarget();
    if (t && !t.finding) window.scrollTo(0, 0);
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
      --good:#4ade80;            /* category state: CLEAN (low = best) */
      --warn:#facc15;            /* category state: WATCH */
      --mid:#fb923c;             /* category state: NEEDS ATTENTION */
      --worse:#f87171;           /* category state: PRIORITY (high = worst) */
      --neutral:#8b8b95;         /* skipped / no data */
      --font-display:"Anton","Impact","Arial Black",sans-serif;
      --font-hand:"Caveat","Comic Sans MS",cursive;
      --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      --band:#f87171;            /* overridden inline per scan */
      --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { font-family: var(--font-sans); background: var(--bg); color: var(--ink); max-width: min(1280px, calc(100% - 2.5rem)); margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.6; font-size: .95rem; overflow-x: clip; }
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
    .hero .b-clean { color: #07110a; background: #4ade80; }
    .hero .b-mostly-clean { color: #0f1103; background: #a3e635; }
    .hero .b-slightly-assy { color: #150a0a; background: #facc15; }
    .hero .b-assy { color: #150a0a; background: #eab308; }
    .hero .b-pretty-assy { color: #150a0a; background: #fb923c; }
    .hero .b-very { color: #150a0a; background: #f97316; }
    .hero .b-heavily-assy { color: #150a0a; background: #f87171; }
    .hero .b-extreme { color: #150a0a; background: #ef4444; }
    .hero .b-catastrophic { color: #fff; background: #dc2626; }
    .hero .b-beyond { color: #fff; background: #b91c1c; }
    /* the severity gauge: fill width = score (0 clean -> 100 full+red) */
    .hero-gauge { width: min(430px, 100%); height: 13px; margin: .35rem auto 0; border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid var(--line-strong); overflow: hidden; }
    .hero-gauge-fill { display: block; height: 100%; border-radius: 999px; background: var(--band, #f87171); }
    .hero-scale { color: var(--ink-faint); font-size: .72rem; letter-spacing: .16em; text-transform: uppercase; margin: .9rem 0 0; }
    /* the one-line verdict joke now lives INSIDE the score card, directly
       under the badge pill (owner reorder 2026-10-10); hand font, slightly
       tighter than the old standalone section so the card stays scannable */
    .hero .roast { margin: .8rem auto .25rem; max-width: 62ch; font-size: clamp(1.05rem, 2.6vw, 1.28rem); line-height: 1.4; }
    /* the scanned-pages list — moved from the hero into the bottom fine-print
       group (owner reorder 2026-10-10); muted, link-dotted, same .pages class */
    .pages { color: var(--ink-faint); font-size: .85rem; margin: .45rem 0 0; overflow-wrap: anywhere; }
    .pages a { color: var(--ink-dim); text-decoration: none; border-bottom: 1px dotted var(--line-strong); }
    .pages a:hover { color: var(--ass); border-color: var(--ass); }
    .score { font-size: 2.6rem; font-weight: 700; }
    .verdict { font-size: 1.15rem; font-weight: 700; margin: .25rem 0 .75rem; }
    .b-clean { color: #4ade80; } .b-mostly-clean { color: #a3e635; } .b-slightly-assy { color: #facc15; } .b-assy { color: #eab308; }
    .b-pretty-assy { color: #fb923c; } .b-very { color: #f97316; } .b-heavily-assy { color: #f87171; } .b-extreme { color: #ef4444; }
    .b-catastrophic { color: #dc2626; } .b-beyond { color: #b91c1c; }
    .roast { font-family: var(--font-hand); font-size: 1.38rem; line-height: 1.45; color: var(--ink); margin: .6rem 0 .3rem; }
    .hint { color: var(--ink-faint); font-size: .85rem; margin: -.35rem 0 1rem; }
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
       items; when a scan has no compliments, ONE plain muted line (owner
       reorder 2026-10-10 — the old dashed box is gone). Compliments are never
       invented — only real scan measurements render here. --- */
    .working-list { list-style: none; padding: 0; margin: 1.1rem 0 .4rem; }
    .working-item { position: relative; margin: .7rem 0; padding: .85rem 1rem .8rem 2.6rem; background: rgba(74,222,128,.05); border: 1px solid rgba(74,222,128,.22); border-left: 4px solid var(--good); border-radius: 12px; }
    .working-item::before { content: "✓"; position: absolute; left: .9rem; top: .78rem; color: var(--good); font-weight: 800; font-size: 1.05rem; line-height: 1; }
    .working-point { display: block; color: var(--ink); font-size: .93rem; line-height: 1.55; }
    .working-point strong { color: var(--good); }
    .working-receipt { display: block; margin-top: .4rem; font-size: .8rem; color: var(--ink-dim); }
    .working-receipt em { font-family: var(--mono); font-size: .78rem; color: #c9c9d1; font-style: normal; overflow-wrap: anywhere; }
    .working-empty { margin: 1.1rem 0 .4rem; color: var(--ink-dim); font-size: .92rem; font-style: italic; }
    /* --- Where-the-problems-live line above the fix list (owner reorder
       2026-10-10): the worst-page evidence moved here from the removed panel;
       the dup-pair suffix keeps the report-trust pair evidence. --- */
    .fix-context { margin: 0 0 .85rem; padding: .7rem .9rem; border-left: 3px solid var(--worse); background: rgba(248,113,113,.05); border-radius: 0 10px 10px 0; color: var(--ink-dim); font-size: .92rem; line-height: 1.6; }
    .fix-context a { color: var(--ass); text-decoration: none; border-bottom: 1px dotted rgba(212,240,0,.5); }
    .fix-context a:hover { border-bottom-style: solid; }
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
      .hero .roast { color: #111; }
      .cat-card, .finding-card, .cat-detail, .fix-item, .working-item { background: #fff; border-color: #d4d4d8; }
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
    <p class="roast">${roastInfo.emoji} ${esc(roastInfo.line)}</p>
    <div class="hero-gauge" aria-hidden="true">
      <span class="hero-gauge-fill" style="width:${pubScore}%"> </span>
    </div>
    <p class="hero-scale">0 = LEAST ASS / 100 = MAX ASS</p>
  </section>

  ${breakdownSection}
  ${fixSection}
  ${workingSection}
  ${catSourcesSection}
  ${finalSection}
  ${methodologySection}
  ${footerLine}
  </div>
  ${categoryViews}
  ${categoryViewScript}
</body>
</html>`;
}
