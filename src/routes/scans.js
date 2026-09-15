import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { isHttpUrl } from '../branding.js';
import { selectRoast, selectRoastInfo } from '../roast.js';
import { withInsights } from '../threeLayer.js';
import { toPublicScan, publicScore } from '../serialize.js';
import { verdictBand, verdictLabel, scoreColor } from '../verdict.js';

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
 * Returns JSON by default; renders a simple HTML report when the client
 * prefers text/html (the report view).
 *
 * GET /api/v1/scans/:id/card — the shareable result card: a deterministic
 * 1200x630 PNG (A.S.S. Score + scanned URL + one-line verdict + branding +
 * disclaimer), composed as SVG and rasterized with sharp (no headless
 * browser). Same scan id -> byte-identical PNG, always.
 *
 * GET /api/v1/scans/:id/share — pre-filled social share text + public result
 * URL (publicBaseUrl, default env PUBLIC_BASE_URL || https://ass-score.com).
 */
export function scansRouter({ db, publicBaseUrl }) {
  const r = Router();
  const shareBase = publicBaseUrl || process.env.PUBLIC_BASE_URL || 'https://ass-score.com';

  r.get('/api/v1/scans/:id', (req, res) => {
    const scan = db.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    // Render the HTML report only when the client explicitly asks for text/html;
    // JSON is the default for API clients (curl sends */* and gets JSON).
    const accept = req.get('accept') || '';
    const wantsHtml = /text\/html/.test(accept) && !/application\/json/.test(accept);
    if (wantsHtml) {
      return res.type('html').send(renderHtmlReport({ ...scan, breakdown: breakdownFor(scan) }));
    }
    // PUBLIC shape: the stored internal slop score IS the public score
    // (score 0-100, higher = worse — same direction, no inversion; verdict
    // added). Pre-flip rows read correctly with NO migration: the DB column
    // keeps the slop direction, which is exactly the public direction.
    // Three-layer insights are guaranteed on the breakdown (stored, or derived
    // for legacy rows).
    const pub = toPublicScan({ ...scan, breakdown: breakdownFor(scan) });
    const json = {
      id: pub.id,
      url: pub.url,
      score: pub.score,
      verdict: pub.verdict,
      breakdown: pub.breakdown,
      roast: roastFor(scan), // stored line, or derived for pre-roast legacy rows
      createdAt: pub.created_at ?? pub.createdAt,
    };
    if (Array.isArray(pub.breakdown?.crossPage?.pages) && pub.breakdown.crossPage.pages.length >= 2) {
      json.pages = pub.breakdown.crossPage.pages;
    }
    if (pub.breakdown?.crossPage?.pairs?.length) {
      json.pairs = pub.breakdown.crossPage.pairs;
    }
    if (typeof pub.partial === 'boolean') json.partial = pub.partial;
    if (typeof pub.note === 'string') json.note = pub.note;
    if (pub.worstPage) json.worstPage = pub.worstPage; // worstPage.score stays INTERNAL slop direction (see README)
    if (pub.branding) json.branding = pub.branding; // white-label branding used
    res.json(json);
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
 * Customer-facing category names — the ONLY display-label table for the
 * breakdown (owner 2026-09-15 "plain names" mapping). The internal JSON API
 * keys (filler/boilerplate/infoDensity/repetitive/crossPage/fingerprints/
 * assets) NEVER change — edit the visible names HERE and nowhere else.
 * Mapping: filler→COPY, boilerplate→MESSAGING, infoDensity→ORIGINALITY,
 * repetitive→STRUCTURE, crossPage→REPETITION, fingerprints→DESIGN,
 * assets→IMAGERY. (Lead's best-semantic derivation; adjust in place if the
 * owner renames after review.)
 */
const CATEGORY_LABELS = {
  filler: 'COPY',
  boilerplate: 'MESSAGING',
  infoDensity: 'ORIGINALITY',
  repetitive: 'STRUCTURE',
  crossPage: 'REPETITION',
  fingerprints: 'DESIGN',
  assets: 'IMAGERY',
};

/** Plain-English one-liner per category (Your Breakdown section). */
const CATEGORY_ONE_LINERS = {
  filler: 'How much of your copy is filler phrasing — words that sound confident but say nothing.',
  boilerplate: 'Generic marketing boilerplate that could describe any business in any industry.',
  infoDensity: 'Whether your content actually says something specific, or just fills the page.',
  repetitive: 'How often your page repeats itself — same sentence openings, same sentences, same paragraphs.',
  crossPage: 'How much of your site is the same text repeated across different pages.',
  fingerprints: 'Telltale template-built design and code fingerprints (AI-looking patterns, build-tool traces).',
  assets: 'Stock and placeholder imagery where real, specific visuals would say more.',
};

/**
 * Mandated user-facing disclaimer. Appears on every HTML report, verbatim —
 * never cut, never reworded (owner law).
 */
const DISCLAIMER =
  'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';

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
  const roast = hasInsight ? insight.roast : finding;
  const why = hasInsight ? insight.why : '';
  const fix = hasInsight ? insight.fix : '';
  const layers = hasInsight
    ? `<div><span class="ins-why">Why it matters:</span> ${esc(why)}</div>
    <div><span class="ins-fix">How to fix it:</span> ${esc(fix)}</div>`
    : '<p class="rec-note">No deeper insight was stored for this finding — the receipts below are the evidence.</p>';
  return `
  <div>
    <h3>${esc(title)}</h3>
    <p class="ins-roast">${esc(roast)}</p>
    ${layers}
    <div><span class="rec-label">Show the receipts:</span>
      <ul><li><strong>${esc(finding)}</strong></li></ul>
    </div>
  </div>`;
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
 * Everything is deterministic: same scan id -> byte-identical HTML.
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
  <p>${findingsTotal === 0
    ? 'No findings this scan — nothing to roast, and nothing to hide.'
    : `${findingsTotal} finding${findingsTotal === 1 ? '' : 's'} across ${withFindings.length} categor${withFindings.length === 1 ? 'y' : 'ies'} — every roast points at the receipts below.`}</p>
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
  // not things to fix). Order by category sub-score descending (impact proxy;
  // stable sort keeps finding order inside a category). Effort is treated as
  // roughly equal — each item is one concrete, scoped fix, and the "How to fix
  // it" layer gives the effort detail. Cap at 5 for a scannable list.
  const fixItems = [];
  for (const [key, rule] of problemCats) {
    const label = CATEGORY_LABELS[key] ?? key;
    const insights = Array.isArray(rule.insights) ? rule.insights : [];
    rule.findings.forEach((f, i) => {
      const ins = insights[i];
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