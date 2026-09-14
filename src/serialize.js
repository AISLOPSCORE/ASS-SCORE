/**
 * Public scan serialization — the ONLY place internal scores become the
 * public A.S.S. Score.
 *
 * Score direction (product-locked, owner 2026-09-14): the public A.S.S. Score
 * is 0–100 with HIGHER = WORSE (0 = clean/actually good, 100 = maximum ass).
 * Engine internals and DB storage are the SAME direction (higher = more slop),
 * so NO inversion happens here: the stored `score` column and
 * `breakdown.<cat>.score` values ARE the public scores. Rows written before
 * the earlier flip experiment (which stored exactly this direction) read
 * correctly with NO migration — this module only relabels:
 *
 *   public score          = internal slop score      (clamped 0–100, integer)
 *   breakdown.<cat>.score = internal category score   (per category, too)
 *   verdict               = grade label for the score (see src/verdict.js)
 *
 * Everything else passes through EXACTLY as built: `findings`, `evidence`,
 * `insights` (three-layer findings, attached at scan time), `roast`, `partial`,
 * `note`, `pages`, `pairs`, `branding`. `worstPage` also passes through
 * unchanged — `worstPage.score` is in the same direction (higher = worse);
 * that is documented in the README.
 *
 * Same internal input -> identical public output, always (deterministic).
 */
import { clampScore, verdictLabel } from './verdict.js';

/** Normalize one internal slop score (0-100, higher = worse) to the public
 *  A.S.S. Score — SAME direction (higher = worse), integer, clamped. */
export function publicScore(internalScore) {
  return clampScore(internalScore);
}
/**
 * Map an internal scan object (a stored row from db.getScan or the
 * runScan payload) to the public JSON shape:
 *   - `slopScore` is dropped; `score` (same direction) and `verdict` are added
 *   - every numeric `breakdown.<cat>.score` is normalized the same way
 *     (null-score modules like a skipped crossPage pass through untouched)
 *   - all other fields pass through unchanged
 *
 * Accepts either internal shape: runScan payloads carry `slopScore`, stored
 * rows carry `score` — both are slop-direction values and both are emitted
 * unchanged as the public score.
 *
 * @param {{ slopScore?: number, score?: number, breakdown?: object }} scan
 * @returns {{ score: number, verdict: string, breakdown: object, ... }}
 */
export function toPublicScan(scan) {
  const internal = Number.isFinite(Number(scan?.slopScore)) ? Number(scan.slopScore) : Number(scan?.score);
  const score = publicScore(internal);
  const breakdown = {};
  for (const [key, rule] of Object.entries(scan?.breakdown ?? {})) {
    breakdown[key] =
      rule && typeof rule === 'object' && Number.isFinite(Number(rule.score)) && rule.score !== null
        ? { ...rule, score: publicScore(rule.score) }
        : rule;
  }
  const out = { ...scan, score, verdict: verdictLabel(score), breakdown };
  delete out.slopScore;
  return out;
}