/**
 * Overall Slop Score: weighted combination of the four rule scores, clamped and
 * rounded to an integer in 0–100. Weights are documented and fixed:
 *
 *   filler       25%  — slop/AI-buzz phrasing
 *   boilerplate  20%  — generic template content
 *   infoDensity  30%  — low information density (highest signal for "thin" content)
 *   repetitive   25%  — repetitive structure
 *
 * Deterministic: identical rule scores always produce an identical overall score.
 */
export const RULE_WEIGHTS = Object.freeze({
  filler: 0.25,
  boilerplate: 0.20,
  infoDensity: 0.30,
  repetitive: 0.25,
});

/**
 * @param {{ filler?: {score?:number}, boilerplate?: {score?:number},
 *            infoDensity?: {score?:number}, repetitive?: {score?:number} }} ruleResults
 * @returns {{ slopScore: number, components: Record<string,{score:number,weight:number,weighted:number}> }}
 */
export function computeSlopScore(ruleResults = {}) {
  const components = {};
  let total = 0;
  for (const [key, weight] of Object.entries(RULE_WEIGHTS)) {
    const score = Number.isFinite(ruleResults[key]?.score) ? Number(ruleResults[key].score) : 0;
    const weighted = score * weight;
    components[key] = { score, weight, weighted };
    total += weighted;
  }
  const slopScore = Math.max(0, Math.min(100, Math.round(total)));
  return { slopScore, components };
}