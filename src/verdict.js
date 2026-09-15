/**
 * Verdict bands — the SINGLE source of truth for grade labels + band colors.
 *
 * Score direction (product-locked, owner 2026-09-14): the PUBLIC A.S.S. Score
 * is 0–100 with HIGHER = WORSE (0 = clean/actually good, 100 = maximum ass).
 * Every surface that displays a grade label or band color — JSON API, HTML
 * report, share card, emails — must read these bands from HERE and nowhere
 * else. There is no band-threshold logic duplicated anywhere in the codebase.
 *
 * The internal engine score and the stored DB rows are the SAME direction
 * (higher = more slop), so the serialization boundary (src/serialize.js)
 * does NOT invert: the public score equals the stored score, and bands are
 * defined directly on that scale.
 *
 * Bands (locked table — OWNER-UNIFIED 6-BAND SYSTEM, ratified 2026-09-15;
 * `max` inclusive; array is ascending-max so the tiles cover 0–100 with no
 * gaps and no overlaps):
 *   90-100  catastrophically ass   (CATASTROPHICALLY ASS, alias "certified slop")  red #f87171
 *   75-89   extremely ass          (EXTREMELY ASS)                                deep orange #f97316
 *   50-74   very ass               (VERY ASS)                                     orange #fb923c
 *   25-49   getting assy           (GETTING ASSY)                                 yellow #facc15
 *   10-24   clean                  (CLEAN)                                        lime #a3e635
 *   0-9     cleanest               (CLEANEST)                                     green #4ade80
 * The old 5-band table (MILDLY GENERIC 35-54) is superseded and gone.
 *
 * `color` is the display accent per band: red for the high (bad) bands, green
 * for the low (good) bands — so a dial that fills with the score turns
 * red as it approaches 100. `min` is derived (previous band's max + 1).
 */
export const VERDICT_BANDS = [
  { max: 9, label: 'Cleanest', shortLabel: 'CLEANEST', color: '#4ade80' },
  { max: 24, label: 'Clean', shortLabel: 'CLEAN', color: '#a3e635' },
  { max: 49, label: 'Getting assy', shortLabel: 'GETTING ASSY', color: '#facc15' },
  { max: 74, label: 'Very ass', shortLabel: 'VERY ASS', color: '#fb923c' },
  { max: 89, label: 'Extremely ass', shortLabel: 'EXTREMELY ASS', color: '#f97316' },
  { max: 100, label: 'Catastrophically ass', shortLabel: 'CATASTROPHICALLY ASS', alias: 'certified slop', color: '#f87171' },
];
/** Normalize any input to a valid 0-100 integer (defined for NaN/Infinity too). */
export function clampScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
/**
 * The verdict band for a score (0-100, higher = worse).
 * @param {number} score A.S.S. Score
 * @returns {{ label: string, shortLabel: string, alias?: string, color: string, min: number, max: number }}
 *   - label      - sentence-case long form, e.g. "Catastrophically ass"
 *   - shortLabel - uppercase display form (the grade label in the API), e.g. "CATASTROPHICALLY ASS"
 *   - color      - band display accent (green low/good -> red high/bad)
 */
export function verdictBand(score) {
  const s = clampScore(score);
  const bands = VERDICT_BANDS;
  let min = 0;
  for (const band of bands) {
    if (s <= band.max) return { ...band, min };
    min = band.max + 1;
  }
  return { ...bands[bands.length - 1], min };
}
/** Sentence-case verdict label for prose contexts (e.g. the email body). */
export function verdictFor(score) {
  return verdictBand(score).label;
}
/** Grade label (uppercase display form) for a score. */
export function verdictLabel(score) {
  return verdictBand(score).shortLabel;
}
/** Score accent color by band (deterministic; used for the big number/verdict). */
export function scoreColor(score) {
  return verdictBand(score).color;
}