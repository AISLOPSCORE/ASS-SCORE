/**
 * Verdict bands — the SINGLE source of truth for grade labels + band colors.
 *
 * Score direction (product-locked): the PUBLIC A.S.S. Score is 0–100 with
 * HIGHER = BETTER (0 = catastrophic ass, 100 = excellent). Every surface that
 * displays a grade label or band color — JSON API, HTML report, share card,
 * emails — must read these bands from HERE and nowhere else. There is no
 * band-threshold logic duplicated anywhere in the codebase.
 *
 * The internal engine score (the stored slop score) is the OPPOSITE direction
 * (higher = more slop); it is flipped to the public direction at the
 * serialization boundary (src/serialize.js), and ONLY the public score is ever
 * passed into verdictBand(). Keep it that way: bands are defined on the
 * PUBLIC scale.
 *
 * Bands (lowest-first, `max` inclusive):
 *   0-34   catastrophically ass   (CATASTROPHICALLY ASS, alias "certified slop")
 *   35-54  extremely ass          (EXTREMELY ASS)
 *   55-74  very ass               (VERY ASS)
 *   75-89  mildly generic         (MILDLY GENERIC)
 *   90-100 cleanest               (CLEANEST)
 *
 * `color` is the display accent per band: red/rose for the low (bad) bands,
 * amber for the middle, green/lime for the high (good) bands — on the black /
 * ass-yellow brand palette. `min` is derived (previous band's max + 1) so the
 * bands tile the whole 0–100 range with no gaps and no overlaps.
 */

export const VERDICT_BANDS = [
  { max: 34, label: 'Catastrophically ass', shortLabel: 'CATASTROPHICALLY ASS', alias: 'certified slop', color: '#f87171' },
  { max: 54, label: 'Extremely ass', shortLabel: 'EXTREMELY ASS', color: '#fb923c' },
  { max: 74, label: 'Very ass', shortLabel: 'VERY ASS', color: '#facc15' },
  { max: 89, label: 'Mildly generic', shortLabel: 'MILDLY GENERIC', color: '#a3e635' },
  { max: 100, label: 'Cleanest', shortLabel: 'CLEANEST', color: '#4ade80' },
];

/** Normalize any input to a valid 0-100 integer (defined for NaN/Infinity too). */
export function clampScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The verdict band for a PUBLIC score (0-100, higher = better).
 * @param {number} score public A.S.S. Score
 * @returns {{ label: string, shortLabel: string, alias?: string, color: string, min: number, max: number }}
 *   - label      - sentence-case long form, e.g. "Cleanest / most original"-style prose
 *   - shortLabel - uppercase display form (the grade label in the API), e.g. "CLEANEST"
 *   - color      - band display accent (red low -> green high)
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

/** Grade label (uppercase display form) for a public score. */
export function verdictLabel(score) {
  return verdictBand(score).shortLabel;
}

/** Score accent color by band (deterministic; used for the big number/verdict). */
export function scoreColor(score) {
  return verdictBand(score).color;
}