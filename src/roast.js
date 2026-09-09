import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSlopScore } from './scorer.js';

/**
 * A.S.S. Score "Slop Roast" — the personality layer.
 *
 * Every scan gets a punchy, on-brand roast line, chosen DETERMINISTICALLY:
 * seeded by the scan id (the same scan id always yields the same line; a
 * different scan id gets a different line — but the choice is never random).
 *
 * Pool selection mirrors how the score itself is built: a category "contributed
 * most to the slop" when its WEIGHTED contribution (rule score × rule weight,
 * exactly what `computeSlopScore` puts into the composite) is the highest of
 * the active categories. Rules:
 *
 *   1. Overall score < CLEAN_SCORE_THRESHOLD (20) -> the site is mostly good
 *      -> "clean" pool.
 *   2. The top contributor must be a real driver: its weighted contribution
 *      must exceed DOMINANCE_MIN_WEIGHTED (4.0 weighted points). Below that the
 *      slop is diffuse (no category meaningfully dominated) -> "clean" pool.
 *   3. Otherwise roast the top category. Ties break on a fixed category order
 *      (filler > boilerplate > infoDensity > repetitive > crossPage >
 *      fingerprints) — always deterministic.
 *
 * `infoDensity` note: in this rule set a HIGH infoDensity score means MORE
 * slop (thin, low-information content — low vocabulary diversity, high
 * stopword ratio, staccato/run-on sentences, short paragraphs). The rule's own
 * doc block says "higher score = more slop". So infoDensity is treated as an
 * ordinary slop category: when thin content is genuinely the biggest driver,
 * the site gets an infoDensity roast; the "clean" fallback above is what
 * guards genuinely good sites. The copy for that pool stays pattern-based
 * ("thin", "says a lot, means nothing") — never an authorship claim.
 *
 * Copy lives in src/roasts.json (one pool per breakdown key + `clean`),
 * mirroring the config-driven fingerprints.json style: edit copy in the file,
 * NO code changes needed. The line is stored on the scan record at scan time
 * (db.roast column) so every surface — JSON, HTML report, share card, webhook,
 * future emails — reads the same string.
 */

const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'roasts.json');
const ROAST_DATA = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

/** Raw pools (key -> { emoji, label, lines[] }). Exposed for tests/tooling. */
export const ROAST_POOLS = Object.freeze(
  Object.fromEntries(Object.entries(ROAST_DATA.pools).map(([k, v]) => [k, Object.freeze({ ...v, lines: Object.freeze([...v.lines]) })])),
);

/** Valid pool keys: the six breakdown categories + `clean`. */
export const ROAST_POOL_KEYS = Object.freeze(Object.keys(ROAST_POOLS));

/** Deterministic tie-break order for category pools (weight-table order). */
export const CATEGORY_ORDER = Object.freeze(['filler', 'boilerplate', 'infoDensity', 'repetitive', 'crossPage', 'fingerprints']);

/** Overall-score floor below which the "clean" pool always wins. */
export const CLEAN_SCORE_THRESHOLD = 20;

/**
 * Minimum weighted contribution for a category to count as "the slop driver".
 * Below this the slop is diffuse (no single category meaningfully dominated)
 * and the "clean" pool wins. Weighted points mirror the composite: a rule
 * scoring 26 at 0.15 weight contributes 3.9 points, etc.
 */
export const DOMINANCE_MIN_WEIGHTED = 4;

/**
 * Deterministic 32-bit string hash (FNV-1a). Seeding the roast by the scan id
 * with this hash means: same id -> same index -> same line, forever; two
 * different ids usually land on different lines. Pure, no randomness.
 */
export function hashScanId(id) {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const s = String(id);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime 16777619, keep uint32
  }
  return h >>> 0;
}

/**
 * Pick the pool key for a scan, deterministically.
 * @param {{ slopScore: number, breakdown: object }} scan
 * @returns {string} one of ROAST_POOL_KEYS
 */
export function pickSlopPool({ slopScore, breakdown }) {
  const score = Number.isFinite(slopScore) ? Math.round(slopScore) : 0;

  // Mostly-good site -> always the clean pool.
  if (score < CLEAN_SCORE_THRESHOLD) return 'clean';

  // Recompute the weighted contributions with the exact same math as scoring;
  // deterministic from the stored breakdown.
  const { components } = computeSlopScore(breakdown ?? {});

  // Winner = highest weighted contribution; CATEGORY_ORDER breaks ties
  // (strictly-greater comparison keeps the first-in-order on equality).
  let winner = null;
  let best = -1;
  for (const key of CATEGORY_ORDER) {
    const weighted = components[key]?.weighted ?? 0;
    if (weighted > best) {
      best = weighted;
      winner = key;
    }
  }

  // Nothing dominates (no category contributed more than a token amount of
  // the score; the slop is diffuse) -> clean pool.
  if (winner === null || best <= DOMINANCE_MIN_WEIGHTED) return 'clean';

  return winner;
}

/**
 * Full roast info for a scan: pool key, emoji, display label and the chosen
 * line. Deterministic for a given (id, slopScore, breakdown).
 * @returns {{ pool: string, emoji: string, label: string, line: string }}
 */
export function selectRoastInfo({ id, slopScore, breakdown }) {
  const pool = pickSlopPool({ slopScore, breakdown });
  const meta = ROAST_POOLS[pool] ?? ROAST_POOLS.clean;
  const lines = meta.lines;
  const idx = hashScanId(id) % lines.length;
  return { pool, emoji: meta.emoji, label: meta.label, line: lines[idx] };
}

/** Just the roast line (1–2 sentences) for a scan. See selectRoastInfo. */
export function selectRoast({ id, slopScore, breakdown }) {
  return selectRoastInfo({ id, slopScore, breakdown }).line;
}