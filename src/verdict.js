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
 * Bands (locked table — OWNER 10-POINT BAND SCALE, directed 2026-10-05;
 * `max` inclusive; array is ascending-max so the tiles cover 0–100 with no
 * gaps and no overlaps). The old 6-band table (CLEANEST / CLEAN / GETTING
 * ASSY / VERY ASS / EXTREMELY ASS / CATASTROPHICALLY ASS) is superseded and
 * gone; every old label maps onto the new band that contains the same score
 * — numeric scores themselves NEVER change (no rescaling):
 *    90-100  beyond ass              (BEYOND ASS)                        dark red #b91c1c
 *    80-89   catastrophically assy   (CATASTROPHICALLY ASSY)             dark red #dc2626
 *    70-79   extremely assy          (EXTREMELY ASSY)                    red #ef4444
 *    60-69   heavily assy            (HEAVILY ASSY)                      red #f87171
 *    50-59   very assy               (VERY ASSY)                         deep orange #f97316
 *    40-49   pretty assy             (PRETTY ASSY)                       orange #fb923c
 *    30-39   assy                    (ASSY)                              yellow #eab308
 *    20-29   slightly assy           (SLIGHTLY ASSY)                     yellow #facc15
 *    10-19   mostly clean            (MOSTLY CLEAN)                      lime #a3e635
 *    0-9     clean                   (CLEAN)                             green #4ade80
 * Semantics (owner 2026-10-05): 50 is the hinge — below it the site is
 * still defensible, at 50 and above it is not; 90-100 (BEYOND ASS) is only
 * for total collapse (broken copy, fake trust signals, unusable page).
 * Color families by severity: green (CLEAN/MOSTLY CLEAN), yellow (SLIGHTLY
 * ASSY/ASSY), orange (PRETTY ASSY/VERY ASSY), red (HEAVILY
 * ASSY/EXTREMELY ASSY), dark red (CATASTROPHICALLY ASSY/BEYOND ASS) — the
 * dial reads monotonic green -> dark red as the score rises. Names only:
 * no emoji/logos are rendered anywhere for these bands.
 *
 * `color` is the display accent per band: red for the high (bad) bands, green
 * for the low (good) bands — so a dial that fills with the score turns
 * red as it approaches 100. `min` is derived (previous band's max + 1).
 */
export const VERDICT_BANDS = [
  { max: 9, label: 'Clean', shortLabel: 'CLEAN', color: '#4ade80', line1: 'GOOD JOB.', line2: '(RARE THESE DAYS)', treat: 'celebrate' },
  { max: 19, label: 'Mostly clean', shortLabel: 'MOSTLY CLEAN', color: '#a3e635', line1: 'NOT BAD.', line2: '(BARELY ANY ASS HERE.)', treat: 'positive' },
  { max: 29, label: 'Slightly assy', shortLabel: 'SLIGHTLY ASSY', color: '#facc15', line1: 'HMM.', line2: "(IT'S STARTING TO SMELL.)", treat: 'mixed' },
  { max: 39, label: 'Assy', shortLabel: 'ASSY', color: '#eab308', line1: 'WELL, WELL.', line2: '(SOME ASS HAS BEEN DETECTED.)', treat: 'mixed' },
  { max: 49, label: 'Pretty assy', shortLabel: 'PRETTY ASSY', color: '#fb923c', line1: 'WE NEED TO TALK.', line2: '(SERIOUSLY.)', treat: 'warn' },
  { max: 59, label: 'Very assy', shortLabel: 'VERY ASSY', color: '#f97316', line1: 'OK, THIS IS A LOT.', line2: '(OF ASS.)', treat: 'warn' },
  { max: 69, label: 'Heavily assy', shortLabel: 'HEAVILY ASSY', color: '#f87171', line1: 'STOP. BREATHE.', line2: "(THE SCORE ISN'T DONE GOING UP.)", treat: 'warn' },
  { max: 79, label: 'Extremely assy', shortLabel: 'EXTREMELY ASSY', color: '#ef4444', line1: 'YIKES.', line2: '(GET THE FIRE EXTINGUISHER.)', treat: 'chaos' },
  { max: 89, label: 'Catastrophically assy', shortLabel: 'CATASTROPHICALLY ASSY', color: '#dc2626', line1: 'YIKES.', line2: '(THIS IS BAD.)', treat: 'alarm' },
  { max: 100, label: 'Beyond ass', shortLabel: 'BEYOND ASS', color: '#b91c1c', line1: 'ABANDON HOPE.', line2: '(EVERYTHING IS ASS.)', treat: 'alarm' },
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
 * @returns {{ label: string, shortLabel: string, color: string, min: number, max: number }}
 *   - label      - sentence-case long form, e.g. "Catastrophically assy"
 *   - shortLabel - uppercase display form (the grade label in the API), e.g. "CATASTROPHICALLY ASSY"
 *   - color      - band display accent (green low/good -> dark red high/bad)
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