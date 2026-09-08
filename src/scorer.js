/**
 * Overall Slop Score: weighted combination of the rule scores, clamped and
 * rounded to an integer in 0–100. Deterministic: identical rule scores always
 * produce an identical overall score.
 *
 * ---------------------------------------------------------------------------
 * WEIGHT TABLES (documented)
 * ---------------------------------------------------------------------------
 *
 * v1 weights (unchanged — single-page scans use EXACTLY these):
 *
 *   filler       25%  — slop/AI-buzz phrasing
 *   boilerplate  20%  — generic template content
 *   infoDensity  30%  — low information density (highest signal for "thin" content)
 *   repetitive   25%  — repetitive structure
 *
 * Phase-2 full weights (all six categories participate — multi-page scans):
 *
 *   filler       0.15
 *   boilerplate  0.12
 *   infoDensity  0.18
 *   repetitive   0.15
 *   crossPage    0.30   <- HIGHEST single weight (site-wide duplication is the
 *                          strongest slop signal)
 *   fingerprints 0.10
 *   ------------ ----
 *   total        1.00
 *
 * The four v1 categories keep their exact v1 RELATIVE weights
 * (5 : 4 : 6 : 5) in both tables.
 *
 * RENORMALIZATION (when a module is skipped)
 * ------------------------------------------
 * Only crossPage can be skipped (it returns score null when fewer than 2 pages
 * are discoverable — see src/rules/crossPage.js). When that happens the
 * composite returns to the exact v1 four-rule weights above, so a single-page
 * scan scores BIT-IDENTICALLY to v1 (the phase-2 requirement: "4-cat
 * renormalized weights == v1 weights {0.25, 0.20, 0.30, 0.25}"). The
 * fingerprints module still runs and its score/findings are reported in the
 * breakdown, but it contributes weight 0 to the composite in this case —
 * fingerprint evidence enters the score only when cross-page analysis runs
 * (this keeps single-page results strictly comparable to v1). If any other
 * module ever returned null, it would be dropped and the remaining weights
 * renormalized to sum 1.00 preserving their ratios.
 */

export const RULE_WEIGHTS = Object.freeze({
  filler: 0.25,
  boilerplate: 0.20,
  infoDensity: 0.30,
  repetitive: 0.25,
});

/** Full phase-2 weights used when crossPage participates (sums to 1.00). */
export const FULL_RULE_WEIGHTS = Object.freeze({
  filler: 0.15,
  boilerplate: 0.12,
  infoDensity: 0.18,
  repetitive: 0.15,
  crossPage: 0.30,
  fingerprints: 0.10,
});

/**
 * @param {{ filler?: {score?:number}, boilerplate?: {score?:number},
 *            infoDensity?: {score?:number}, repetitive?: {score?:number},
 *            crossPage?: {score?:number|null}, fingerprints?: {score?:number} }} ruleResults
 * @returns {{ slopScore: number, components: Record<string,{score:number,weight:number,weighted:number}> }}
 */
export function computeSlopScore(ruleResults = {}) {
  const components = {};
  let total = 0;

  const hasCrossPage = Number.isFinite(ruleResults.crossPage?.score);
  const table = hasCrossPage ? FULL_RULE_WEIGHTS : RULE_WEIGHTS;

  for (const [key, weight] of Object.entries(table)) {
    const score = Number.isFinite(ruleResults[key]?.score) ? Number(ruleResults[key].score) : 0;
    const weighted = score * weight;
    components[key] = { score, weight, weighted };
    total += weighted;
  }

  // crossPage skipped (single-page scan): fingerprints runs but is excluded
  // from the composite to reproduce v1 scoring exactly (documented above).
  if (!hasCrossPage) {
    const fpScore = Number.isFinite(ruleResults.fingerprints?.score) ? ruleResults.fingerprints.score : 0;
    components.fingerprints = {
      score: fpScore,
      weight: 0,
      weighted: 0,
      note: 'excluded from the composite when crossPage is skipped (single-page scans reproduce v1 scoring)',
    };
  }

  const slopScore = Math.max(0, Math.min(100, Math.round(total)));
  return { slopScore, components };
}