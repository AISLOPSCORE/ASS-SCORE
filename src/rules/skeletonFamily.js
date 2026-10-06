import { load } from 'cheerio';
import { shingleJaccard, roundSimilarity } from './similarity.js';
import { isUtility, FRAMEWORK_VARIANT_RE, isHashToken } from './visualRepetition.js';
/**
 * Round-2 DOM skeleton / template-family signal (owner-approved 2026-10-06 —
 * ROUND2-SPEC.md, recommended parameters). A second component of the
 * crossPage (REPETITION) category: if >= SKEL_COVERAGE_BAR of the scanned
 * pages are clones of ONE DOM template (same tag/class skeleton, different
 * text), the site's repetition score rises by up to +80 (SKEL_SUB_WEIGHT).
 *
 * Why this shape (spec §1.1): `extractMainText` deliberately strips the
 * chrome (nav/header/footer) before the existing main-text comparison, so
 * template sharing is invisible to the pairwise body-copy term by
 * construction. This detector measures the structure the text signal cannot
 * see — a repeated DOM skeleton — using the SAME machinery
 * (`wordShingles`/`shingleJaccard` over 4-gram item shingles).
 *
 * Determinism: cheerio document-order traversal, lowercase, stable sort, no
 * randomness — same input always yields the same skeleton, the same j4, the
 * same score (spec §1.3). No AI, no external calls, no live fetches.
 *
 * Gates (spec §3, E-style):
 *   E1 minimum pages      — < 2 scanned pages: the signal is null (contributes 0)
 *                           and single-page scans keep v1 parity.
 *   E2 pair similarity    — a pair must reach j4 >= SKEL_PAIR_T (0.75) to be
 *                           graph-connected.
 *   E3 family coverage    — the largest clique of E2-connected pages must cover
 *                           >= SKEL_COVERAGE_BAR (0.75) of the scanned set.
 *   E4 chrome-only floor  — a shared nav+footer alone cannot reach 0.75 j4
 *                           (measured: pair floor + coverage bar jointly gate it).
 *   E5 specificity floor  — class items are filtered through the round-1
 *                           utility/variant tables + the CSS-in-JS hash filter
 *                           (imported from visualRepetition.js — reused, not
 *                           duplicated); tag-only generic shapes need 4/5
 *                           same-shape pages to fire (spec §8 risk #4).
 *   E6 identity guard     — the detector skips same-URL pairs belt-and-braces;
 *                           scan.js already dedupes by final fetched URL
 *                           upstream (PR #15), so a 1.0 self-comparison is
 *                           structurally impossible.
 *   E7 single-page fallback — crossPage null -> skeleton null -> v1+C1 parity.
 *   E8 C2 interplay       — C2's gate reads the NEW crossPage' (see
 *                           src/rules/crossPage.js): fires when crossPage' >= 80
 *                           exactly when skeletonScore >= (80 - cxp) / 0.8.
 *
 * Tunable knobs (single-line constants, like the other rule data — spec §8):
 *   SKEL_PAIR_T       0.75  (0.70–0.80)
 *   SKEL_COVERAGE_BAR 0.75  (0.60–0.85)
 *   SKEL_SUB_WEIGHT   0.8   (0.5–1.0)
 */

export const SKEL_PAIR_T = 0.75;        // pair gate: j4 >= 0.75
export const SKEL_COVERAGE_BAR = 0.75;  // largest skeleton family must cover >=75% of scanned pages
export const SKEL_SUB_WEIGHT = 0.8;     // crossPage internal sub-weight

/** DOM-visibility exclusions (spec §1.3): same set as text.js's NON_TEXT_TAGS
 *  minus `form` (a repeated contact/search form IS structure — kept). svg is
 *  round-1 icon territory, measured separately by visualRepetition. */
const NON_TEXT_SELECTOR = 'script, style, noscript, template, svg, canvas, iframe, object, embed, textarea, select, option';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Round-1 specificity floor + variant/hash filters (imported, not forked). */
const isSkeletonFilteredToken = (t) => isUtility(t) || FRAMEWORK_VARIANT_RE.test(t) || isHashToken(t);

/**
 * Build the C2 skeleton item array for one page (spec §1.3 — exact).
 * Scope: the <body> subtree only (head is fingerprints' territory via
 * extractHead). Pre-order traversal; each element emits its tag name and,
 * when its class attribute survives the token filter, ONE class item
 * (the joined surviving tokens, '.'-prefixed). Text is NEVER emitted (that
 * is the main-text signal's job); id/href/src/style/data-star/aria-star
 * attribute VALUES are never emitted. Excluded elements are removed before
 * traversal.
 *
 * @param {string} html raw page HTML
 * @returns {string[]} item array (tag + filtered class items, document order)
 */
export function buildSkeletonC2(html) {
  const $ = load(html);
  $(NON_TEXT_SELECTOR).remove();
  const items = [];
  const walk = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    if (!tag || tag === '') return;
    items.push(tag);
    const cls = ($(el).attr('class') ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (cls) {
      const kept = cls.split(' ').filter((t) => !isSkeletonFilteredToken(t));
      if (kept.length > 0) items.push(`.${kept.join('.')}`);
    }
    $(el).children().each((_, c) => walk(c));
  };
  $('body').children().each((_, c) => walk(c));
  return items;
}

/**
 * The site-level skeleton detector (spec §4 — exact formulas).
 *
 * @param {Array<{url: string, html: string}>} pages scanned pages, deduped by
 *   final URL upstream (scan.js); deterministic caller order. pages[0] is the
 *   target the customer asked about.
 * @returns {null | {
 *     fired: boolean,
 *     reason?: string,
 *     familySize?: number,
 *     coverage?: number,
 *     maxJ4?: number,
 *     skeletonScore: number,
 *     pairUrlA?: string,
 *     pairUrlB?: string,
 *     receipts: string[],
 *   }}
 *   null when E1 fails (< 2 pages) — the signal contributes 0 and single-page
 *   scans keep v1 parity. Non-null results always expose `skeletonScore`
 *   (0 when not fired) and `receipts`.
 */
export function detectSkeleton(pages = []) {
  // E6 identity-first: drop duplicate URLs (first occurrence wins, mirroring
  // scan.js's PR #15 dedup) so the scaffolding, family math and coverage all
  // operate on DISTINCT documents — the detector result is always identical
  // to the deduped set, and a self-comparison is structurally impossible even
  // if a caller ever passes a duplicated page list.
  const seenUrls = new Set();
  const deduped = [];
  for (const p of pages) {
    if (seenUrls.has(p.url)) continue;
    seenUrls.add(p.url);
    deduped.push(p);
  }
  const n = deduped.length;
  if (n < 2) return null; // E1: needs >= 2 scanned pages

  const skels = deduped.map((p) => buildSkeletonC2(p.html));
  // All unordered pairs (i<j), deterministic page order; E6 belt-and-braces
  // pair skip (same-URL pairs can never reach here after the dedup above).
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (deduped[i].url === deduped[j].url) continue; // never compare a document to itself
      const j4 = roundSimilarity(shingleJaccard(skels[i], skels[j], 4));
      pairs.push({ i, j, j4 });
    }
  }
  const eligible = pairs.filter((p) => p.j4 >= SKEL_PAIR_T); // E2
  if (eligible.length === 0) {
    return {
      fired: false,
      reason: `no pair >= ${SKEL_PAIR_T}`,
      skeletonScore: 0,
      receipts: [`no two scanned pages share more than ${Math.round(SKEL_PAIR_T * 100)}% of their DOM skeleton`],
    };
  }
  // Largest clique in the E2-connected graph (Bron–Kerbosch; n <= 5 -> trivial).
  const adj = Array.from({ length: n }, () => new Set());
  for (const p of eligible) {
    adj[p.i].add(p.j);
    adj[p.j].add(p.i);
  }
  let best = [];
  const bronKerbosch = (R, P, X) => {
    if (P.size === 0 && X.size === 0) {
      if (R.size > best.length) best = [...R];
      return;
    }
    for (const v of [...P]) {
      const Rp = new Set(R); Rp.add(v);
      const Pp = new Set([...P].filter((u) => adj[v].has(u)));
      const Xp = new Set([...X].filter((u) => adj[v].has(u)));
      bronKerbosch(Rp, Pp, Xp);
      P.delete(v); X.add(v);
    }
  };
  bronKerbosch(new Set(), new Set([...Array(n).keys()]), new Set());
  const family = best;
  const coverage = family.length / n;
  if (coverage < SKEL_COVERAGE_BAR) { // E3
    return {
      fired: false,
      reason: `family ${family.length}/${n} < ${SKEL_COVERAGE_BAR}`,
      familySize: family.length,
      coverage,
      skeletonScore: 0,
      receipts: [`${family.length} of the ${n} scanned pages share one DOM skeleton (below the ${Math.round(SKEL_COVERAGE_BAR * 100)}% coverage bar)`],
    };
  }
  // maxJ4 = strongest eligible pair with BOTH endpoints inside the family.
  let maxJ4 = 0;
  let bestPair = null;
  for (const p of eligible) {
    if (family.includes(p.i) && family.includes(p.j) && p.j4 > maxJ4) {
      maxJ4 = p.j4;
      bestPair = p;
    }
  }
  // Linear score slope: 0 at j4 = 0.75, 100 at j4 = 1.0 (spec §4).
  const skeletonScore = clamp(Math.round(((maxJ4 - SKEL_PAIR_T) / (1 - SKEL_PAIR_T)) * 100), 0, 100);
  const receipts = [
    `${family.length} of the ${n} scanned pages share one DOM skeleton (${Math.round(coverage * 100)}% of the scan)`,
    `${deduped[bestPair.i].url} and ${deduped[bestPair.j].url} share ${Math.round(maxJ4 * 1000) / 10}% of their page skeleton`,
  ];
  return {
    fired: true,
    familySize: family.length,
    coverage,
    maxJ4,
    skeletonScore,
    pairUrlA: deduped[bestPair.i].url,
    pairUrlB: deduped[bestPair.j].url,
    receipts,
  };
}

/**
 * crossPage' = clamp(round(crossPage_score + SKEL_SUB_WEIGHT * skeletonScore),
 * 0, 100) — the integration formula from ROUND2-SPEC §2/§4, kept here so the
 * sub-weight constant lives with the other rule data. crossPage.js applies it
 * to its pairwise+phrase total exactly like the existing phrase sub-term.
 */
export function applySkeletonTerm(crossPageScore, skeletonScore = 0, subWeight = SKEL_SUB_WEIGHT) {
  const skel = Number.isFinite(skeletonScore) ? skeletonScore : 0;
  return clamp(Math.round((crossPageScore ?? 0) + subWeight * skel), 0, 100);
}