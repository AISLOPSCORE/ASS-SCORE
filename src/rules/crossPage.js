import { shingleJaccard, roundSimilarity } from './similarity.js';

/**
 * Cross-Page Duplication rule.
 *
 * Signal: how much of the site's main content is duplicated across pages.
 * Method (documented): pairwise word 4-gram Jaccard similarity over each page's
 * MAIN content only (extractMainText — shared nav/footer/header never counts).
 *
 * Threshold (documented): pairs with similarity >= DUPLICATION_THRESHOLD (0.80)
 * are flagged as findings ("near-identical page pair" / "duplicated across N
 * pages"). Score mapping (documented):
 *
 *   no flagged pairs                          -> 0
 *   otherwise: maxSim over flagged pairs ->
 *     score = round(clamp((maxSim - 0.80) / 0.20 * 100, 0, 100))
 *
 *   0.80 -> 0, 1.00 -> 100 (a fully duplicated site). Linear in between.
 *
 * Less than 2 discoverable pages: the module is gracefully skipped
 * ({ score: null, findings: [], note: "insufficient pages ..." }) — the scorer
 * renormalizes (see src/scorer.js).
 */

export const DUPLICATION_THRESHOLD = 0.8;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {object} opts
 * @param {Array<{ url: string, main: { words: string[] } }>} opts.pages
 *   every page fetched for the scan (target + up to 4 additional), with its
 *   main-content token array. Deterministic caller order.
 * @returns {{ score: number|null, findings: string[],
 *             pairs?: Array<{pageA:string,pageB:string,similarity:number}>,
 *             pages?: string[], note?: string }}
 */
export function analyzeCrossPage({ pages = [] } = {}) {
  if (pages.length < 2) {
    return { score: null, findings: [], note: 'needs at least 2 pages to compare' };
  }

  const pairs = [];
  // All unordered pairs, i<j in the deterministic page order.
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const wordsA = pages[i].main?.words ?? [];
      const wordsB = pages[j].main?.words ?? [];
      const sim = roundSimilarity(shingleJaccard(wordsA, wordsB));
      pairs.push({ pageA: pages[i].url, pageB: pages[j].url, similarity: sim });
    }
  }
  const flagged = pairs.filter((p) => p.similarity >= DUPLICATION_THRESHOLD);

  const findings = [];
  if (flagged.length > 0) {
    const maxSim = Math.max(...flagged.map((p) => p.similarity));
    findings.push(`same content on multiple pages: ${flagged.length} page pair${flagged.length === 1 ? '' : 's'}, most similar at ${(maxSim * 100).toFixed(1)}%`);
    for (const p of flagged) {
      findings.push(`near-identical page pair: ${p.pageA} ~ ${p.pageB} (${(p.similarity * 100).toFixed(1)}% similar)`);
    }
    // Component wording: if >= 3 pages form a fully-connected cluster, call it
    // "duplicated across N pages".
    const byUrl = new Map(pages.map((p) => [p.url, new Set()]));
    for (const p of flagged) {
      byUrl.get(p.pageA)?.add(p.pageB);
      byUrl.get(p.pageB)?.add(p.pageA);
    }
    const biggest = [...byUrl.entries()].reduce((n, [, s]) => Math.max(n, s.size + 1), 1);
    if (biggest >= 3) {
      findings.push(`the same content appears on ${biggest} pages (they're essentially the same page)`);
    }
    const score = clamp(Math.round(((maxSim - DUPLICATION_THRESHOLD) / (1 - DUPLICATION_THRESHOLD)) * 100), 0, 100);
    return { score, findings, pairs, pages: pages.map((p) => p.url) };
  }

  return {
    score: 0,
    findings: [`no two pages are more than ${(DUPLICATION_THRESHOLD * 100).toFixed(0)}% the same (${pages.length} pages compared)`],
    pairs,
    pages: pages.map((p) => p.url),
  };
}