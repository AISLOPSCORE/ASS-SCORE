/**
 * Public scan serialization — the ONLY place internal slop scores become the
 * public A.S.S. Score.
 *
 * Score direction (product-locked): the public A.S.S. Score is 0–100 with
 * HIGHER = BETTER. Engine internals and DB storage are UNCHANGED: the stored
 * `score` column and `breakdown.<cat>.score` values keep the internal slop
 * direction (higher = more slop), and rows written before the flip (pre-flip
 * shape) read correctly with NO migration — this module flips at read time:
 *
 *   public score            = 100 − internal slop score   (clamped 0–100, integer)
 *   breakdown.<cat>.score   = 100 − internal category score (per category, too)
 *   verdict                 = grade label for the public score (see src/verdict.js)
 *
 * Everything else passes through EXACTLY as built: `findings`, `evidence`,
 * `roast`, `partial`, `note`, `pages`, `pairs`, `branding`. `worstPage` also
 * passes through unchanged — `worstPage.score` remains an INTERNAL slop score
 * (higher = worse); that is documented in the README.
 *
 * Same internal input -> identical public output, always (deterministic).
 */
import { clampScore, verdictLabel } from './verdict.js';

/** Flip one internal slop score (0-100, higher = worse) to the public
 *  A.S.S. Score (0-100, higher = better). Integer, clamped. */
export function flipScore(internalScore) {
  return 100 - clampScore(internalScore);
}

/**
 * Map an internal scan object (a stored row from db.getScan or the
 * runScan payload) to the public JSON shape:
 *   - `slopScore` is dropped; `score` (flipped) and `verdict` are added
 *   - every numeric `breakdown.<cat>.score` is flipped (null-score modules
 *     like a skipped crossPage pass through untouched)
 *   - all other fields pass through unchanged
 *
 * Accepts either internal shape: runScan payloads carry `slopScore`, stored
 * rows carry `score` — both are internal-slop-direction values.
 *
 * @param {{ slopScore?: number, score?: number, breakdown?: object }} scan
 * @returns {{ score: number, verdict: string, breakdown: object, ... }}
 */
export function toPublicScan(scan) {
  const internal = Number.isFinite(Number(scan?.slopScore)) ? Number(scan.slopScore) : Number(scan?.score);
  const score = flipScore(internal);

  const breakdown = {};
  for (const [key, rule] of Object.entries(scan?.breakdown ?? {})) {
    breakdown[key] =
      rule && typeof rule === 'object' && Number.isFinite(Number(rule.score)) && rule.score !== null
        ? { ...rule, score: flipScore(rule.score) }
        : rule;
  }

  const out = { ...scan, score, verdict: verdictLabel(score), breakdown };
  delete out.slopScore;
  return out;
}