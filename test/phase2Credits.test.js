import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlopScore } from '../src/scorer.js';
import { fixtureBreakdown } from './fixtures/helpers.js';

/**
 * Phase-2 additive credits — owner-approved 2026-10-05 (EXACT spec:
 * phase1-discovery-2026-10-05.md Part C + stacked-trigger-test-2026-10-05.md).
 *
 * C1 template-stack corroboration:  +4 when infoDensity >= 45 AND fingerprints >= 15.
 * C2 corroborated duplication:      +3*(k-1) when crossPage >= 80, k = number of
 *   the 7 categories with score >= 10 (crossPage's own score included), max +18.
 * Both additive; credit applies to the PRE-ROUND composite total, then a single
 * Math.round + clamp 0-100. No detector/weight/threshold/band changes.
 *
 * Anchor vectors below are pinned from the on-disk live scans
 * (/tmp/after-{b2p,gcc,sl,tb25}.json) and the validation-burst JSONs
 * (/tmp/burst/out/*.json) through the REAL computeSlopScore; the fixture-based
 * anchors (gcc, stripe, blog2posts) round-trip through fixtureBreakdown() so
 * the fixture HTML stays the source of truth.
 */

const cat = (scores) =>
  Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Number.isFinite(v) ? { score: v } : { score: null, findings: [], note: 'insufficient pages for cross-page analysis' }]),
  );

const composite = (scores) => computeSlopScore(cat(scores)).slopScore;

/** Pre-round weighted total (the number the credits are added to). */
const preRound = (scores) =>
  Object.values(computeSlopScore(cat(scores)).components).reduce((s, c) => s + c.weighted, 0);

// ---------------------------------------------------------------------------
// ANCHOR REGRESSION TABLE (owner-approved exact outputs)
// ---------------------------------------------------------------------------

test('anchors: known-good fixtures are bit-identical — gcc 7 -> 5, stripe 17 -> 16', () => {
  // gcc {f0,b0,i31,r0,c0,fp0,a0}: i 49 -> 31 (report-trust fix 2026-10-07: the
  // sentence metric reads BOUNDARY-SPACED sentences — cc's 11 glued pseudo-run-ons
  // (mean 39.6 words) became 38 real sentences (mean 11.5); the run-on subscore
  // collapse drops infoDensity 49 -> 31) -> composite 7 -> 5. C1 still no (fp=0).
  assert.equal(fixtureBreakdown('getcollectionscopilot', 0).composite, 5);
  // stripe {f4,b18,i31,r44,c0,fp13,a22}: i 51 -> 31 (glued corpus was EIGHT
  // 222-word fake run-ons; the boundary-spaced corpus is 107 real sentences,
  // mean 16.6 in the 12–26 band -> the run-on subscore collapses) AND r 25 -> 44
  // (the now-honest sentences expose the real 4x/3x/2x opening/near-identical/
  // paragraph repetition). Composite 17 -> 16. C1 still no (fp=13).
  assert.equal(fixtureBreakdown('stripe', 0).composite, 16);
  const stripe = fixtureBreakdown('stripe', 0);
  assert.equal(stripe.breakdown.fingerprints.score, 13, 'gate-relevant sub-score pinned (13 < 15)');
});

test('anchors: blog2posts 16 -> 9 (report-trust fix: honest sentences switch C1 OFF)', () => {
  // 16 -> 9 (report-trust fix 2026-10-07): infoDensity 50 -> 30 because the
  // sentence metric now reads BOUNDARY-SPACED sentences (blog2posts mean
  // sentence length 40.0 -> 18.8 words, inside the 12–26 band — the glued
  // corpus's 31 pseudo-run-ons were not real sentences). infoDensity 30 < 45
  // so the phase-2 C1 credit (+4) no longer fires; repetitive 0 -> 1 (the
  // honest corpus exposes a real 2× opening receipt). Pre-round 11.6 -> 8.725.
  const { breakdown, composite: c } = fixtureBreakdown('blog2posts', 5);
  assert.equal(breakdown.infoDensity.score, 30);
  assert.equal(breakdown.fingerprints.score, 20);
  assert.equal(breakdown.crossPage.score, 5);
  assert.ok(Math.abs(preRound({
    filler: 0, boilerplate: 6, infoDensity: 30, repetitive: 1, crossPage: 5, fingerprints: 20, assets: 0,
  }) - 8.725) < 1e-9, 'pre-round total is 8.725');
  assert.equal(c, 9, '8.725 rounds to 9 — no C1 credit (i 30 < 45)');
});

test('anchors: seoloupe 36 -> 45 (C2 +9: k=4, crossPage 100)', () => {
  // {f0,b11,i18,r7,c100,fp16,a0}: C1 no (i 18 < 45); C2 fires, k=4 (b,i,c,fp)
  // -> 3*(4-1) = +9 on pre-round 36.275 -> 45.275 -> 45.
  const scores = { filler: 0, boilerplate: 11, infoDensity: 18, repetitive: 7, crossPage: 100, fingerprints: 16, assets: 0 };
  assert.ok(Math.abs(preRound(scores) - 36.275) < 1e-9, 'pre-round 36.275');
  assert.equal(composite(scores), 45);
});

test('anchors: techbullion 13 -> 17 (C1 +4: i50 /\ fp15, c=0)', () => {
  const scores = { filler: 0, boilerplate: 32, infoDensity: 50, repetitive: 7, crossPage: 0, fingerprints: 15, assets: 3 };
  assert.ok(Math.abs(preRound(scores) - 13.375) < 1e-9, 'pre-round 13.375');
  assert.equal(composite(scores), 17, '17.375 rounds to 17');
});

test('anchors: burst C1 mover pins — ghost 16->20, awwwards 24->28, katzs 30->34, linear 20->20', () => {
  // ghost {f0,b60,i50,r5,c0,fp16,a6}: C1 (50 /\ 16), C2 no -> +4 -> 20.
  assert.equal(composite({ filler: 0, boilerplate: 60, infoDensity: 50, repetitive: 5, crossPage: 0, fingerprints: 16, assets: 6 }), 20);
  // awwwards {f0,b100,i58,r17,c5,fp15,a6}: C1 (58 /\ 15) -> +4 -> 28.
  assert.equal(composite({ filler: 0, boilerplate: 100, infoDensity: 58, repetitive: 17, crossPage: 5, fingerprints: 15, assets: 6 }), 28);
  // katzs {f0,b86,i69,r22,c20,fp15,a8}: C1 (69 /\ 15) -> +4 -> 34.
  assert.equal(composite({ filler: 0, boilerplate: 86, infoDensity: 69, repetitive: 22, crossPage: 20, fingerprints: 15, assets: 8 }), 34);
  // linear {f6,b38,i50,r15,c10,fp11,a18}: fp 11 < 15 -> C1 no; c 10 < 80 -> C2 no.
  assert.equal(composite({ filler: 6, boilerplate: 38, infoDensity: 50, repetitive: 15, crossPage: 10, fingerprints: 11, assets: 18 }), 20);
});

// ---------------------------------------------------------------------------
// C1 boundaries
// ---------------------------------------------------------------------------

test('C1: fires at exactly infoDensity 45 /\ fingerprints 15 (+4), not a hair below', () => {
  const base = { filler: 0, boilerplate: 0, infoDensity: 45, repetitive: 0, crossPage: 0, fingerprints: 15, assets: 0 };
  const pre = preRound(base);
  assert.equal(composite(base), Math.round(pre) + 4, '+4 at the exact bars');
  assert.equal(composite({ ...base, infoDensity: 44 }), Math.round(preRound({ ...base, infoDensity: 44 })), 'infoDensity 44 -> no credit');
  assert.equal(composite({ ...base, fingerprints: 14 }), Math.round(preRound({ ...base, fingerprints: 14 })), 'fingerprints 14 -> no credit');
  // Guardrail: C1 must NOT move a site that only misses by one on EITHER bar.
  assert.equal(composite({ ...base, infoDensity: 45, fingerprints: 14, crossPage: null }), Math.round(preRound({ ...base, infoDensity: 45, fingerprints: 14, crossPage: null })));
});

test('C1: no credit when either bar is unmet even with the other category maxed', () => {
  assert.equal(composite({ filler: 0, boilerplate: 0, infoDensity: 100, repetitive: 0, crossPage: 0, fingerprints: 14, assets: 0 }), Math.round(preRound({ filler: 0, boilerplate: 0, infoDensity: 100, repetitive: 0, crossPage: 0, fingerprints: 14, assets: 0 })));
  assert.equal(composite({ filler: 0, boilerplate: 0, infoDensity: 44, repetitive: 0, crossPage: 0, fingerprints: 100, assets: 0 }), Math.round(preRound({ filler: 0, boilerplate: 0, infoDensity: 44, repetitive: 0, crossPage: 0, fingerprints: 100, assets: 0 })));
});

// ---------------------------------------------------------------------------
// C2 boundaries (k counting, gate, cap)
// ---------------------------------------------------------------------------

test('C2: fires at exactly crossPage 80, not at 79', () => {
  const base = { filler: 0, boilerplate: 10, infoDensity: 0, repetitive: 0, crossPage: 80, fingerprints: 0, assets: 0 };
  // k = 2 (boilerplate 10, crossPage 80) -> +3*(2-1) = +3.
  assert.equal(composite(base), Math.round(preRound(base)) + 3);
  assert.equal(composite({ ...base, crossPage: 79 }), Math.round(preRound({ ...base, crossPage: 79 })), 'crossPage 79 -> no credit');
});

test('C2: k counts every category >= 10 INCLUDING crossPage itself; credit scales 3*(k-1)', () => {
  const elev = { filler: 0, boilerplate: 0, infoDensity: 0, repetitive: 0, crossPage: 80, fingerprints: 0, assets: 0 };
  // Only crossPage >= 10 -> k=1 -> +0 (duplication alone must never be credited).
  assert.equal(composite(elev), Math.round(preRound(elev)), 'k=1 -> +0');
  assert.equal(composite({ ...elev, boilerplate: 10 }), Math.round(preRound({ ...elev, boilerplate: 10 })) + 3, 'k=2 -> +3');
  assert.equal(composite({ ...elev, boilerplate: 10, infoDensity: 10, fingerprints: 12, assets: 10 }), Math.round(preRound({ ...elev, boilerplate: 10, infoDensity: 10, fingerprints: 12, assets: 10 })) + 12, 'k=5 -> +12');
  // The +18 cap: k=7 -> 3*6 = 18 (not 3*6-something higher — 7 is the max count).
  const maxk = { filler: 70, boilerplate: 10, infoDensity: 10, repetitive: 10, crossPage: 80, fingerprints: 10, assets: 10 };
  assert.equal(composite(maxk), Math.round(preRound(maxk)) + 18, 'k=7 -> capped +18');
});

test('C2: categories at exactly 9 (below the >=10 bar) do not count toward k', () => {
  const nine = { filler: 9, boilerplate: 9, infoDensity: 9, repetitive: 9, crossPage: 80, fingerprints: 9, assets: 9 };
  assert.equal(composite(nine), Math.round(preRound(nine)), 'k=1 (crossPage alone) -> +0 even with six categories at 9');
});

// ---------------------------------------------------------------------------
// Branch behavior: pre-round total is whichever branch is active
// ---------------------------------------------------------------------------

test('fallback branch: C1 FIRES on a synthetic single-page scan with i>=45 /\ fp>=15; C2 never fires (crossPage null)', () => {
  const fallback = { filler: 0, boilerplate: 0, infoDensity: 50, repetitive: 0, crossPage: null, fingerprints: 20, assets: 0 };
  const pre = preRound(fallback); // v1 four-rule weights: 0.30*50 = 15.0
  assert.equal(pre, 15, 'fallback pre-round uses the v1 4-rule weights (fp/assets weight 0)');
  assert.equal(composite(fallback), 19, '15 + 4 (C1) -> 19: fingerprint evidence now moves a single-page score ONLY through the approved corroboration credit');
  // C2 gate is unreachable: crossPage score null -> 0 < 80 even with huge elevation elsewhere.
  const fallbackBig = { filler: 90, boilerplate: 90, infoDensity: 90, repetitive: 90, crossPage: null, fingerprints: 90, assets: 90 };
  const expected = Math.round(preRound(fallbackBig)) + 4; // C1 only — no C2 term exists on this branch
  assert.equal(composite(fallbackBig), expected);
  assert.ok(expected < Math.round(preRound(fallbackBig)) + 18, 'C2 credit (max +18) is NOT applied in the fallback');
});

test('fallback branch: clean single-page scans reproduce v1 bit-identically when C1 does not fire', () => {
  // i >= 45 but fp < 15 -> no credit -> composite == pure v1 weighted sum.
  const fallback = { filler: 0, boilerplate: 0, infoDensity: 50, repetitive: 0, crossPage: null, fingerprints: 10, assets: 0 };
  assert.equal(composite(fallback), Math.round(preRound(fallback)), 'v1 parity when fp < 15');
  assert.equal(composite({ ...fallback, infoDensity: 44 }), Math.round(preRound({ ...fallback, infoDensity: 44 })));
  assert.equal(composite({ ...fallback, infoDensity: 0 }), 0);
  // Ass-score.com fixture (real clean-ish single-page scan): fingerprints 0 ->
  // composite 11 -> 13 (report-trust fix 2026-10-07: boundary-spaced sentences
  // make ass-score.com's UI-label fragments visible as staccato, mean sentence
  // length 9.2 -> 5.0 words -> infoDensity 45 -> 55 -> 12.75 -> 13).
  assert.equal(fixtureBreakdown('ass-score', 0).composite, 13);
});

test('multi-page branch: pre-round uses the FULL 7-rule weights; credit still lands on the pre-round total', () => {
  const b2p = { filler: 0, boilerplate: 6, infoDensity: 50, repetitive: 0, crossPage: 5, fingerprints: 20, assets: 0 };
  const comps = computeSlopScore(cat(b2p)).components;
  assert.equal(comps.filler.weight, 0.125);
  assert.equal(comps.crossPage.weight, 0.3);
  assert.equal(comps.fingerprints.weight, 0.1);
  assert.ok(Math.abs(preRound(b2p) - 11.6) < 1e-9);
  assert.equal(composite(b2p), 16);
});

// ---------------------------------------------------------------------------
// Combined stack (stacked-trigger-test-2026-10-05.md §2(b) minimal altitudes)
// ---------------------------------------------------------------------------

test('stack: both credits additive — the minimal max-stack (k=7) crosses the hinge at 59/62/65', () => {
  // Every category at its lowest value that keeps k=7 and both triggers.
  const min = { filler: 10, boilerplate: 10, infoDensity: 45, repetitive: 10, crossPage: 80, fingerprints: 15, assets: 10 };
  assert.ok(Math.abs(preRound(min) - 36.75) < 1e-9);
  assert.equal(composite(min), 59, '36.75 + 4 + 18 = 58.75 -> 59 VERY ASSY');
  assert.equal(composite({ ...min, crossPage: 90 }), 62, '39.75 + 22 = 61.75 -> 62');
  assert.equal(composite({ ...min, crossPage: 100 }), 65, '42.75 + 22 = 64.75 -> 65');
});

test('stack: absolute ceiling clamps to exactly 100 — all categories at 100', () => {
  const allMax = { filler: 100, boilerplate: 100, infoDensity: 100, repetitive: 100, crossPage: 100, fingerprints: 100, assets: 100 };
  assert.equal(composite(allMax), 100);
  // Any pre-round >= 77.5 with both triggers maxed prints 100 (77.5+22 = 99.5).
  const nearMax = { filler: 77.5, boilerplate: 100, infoDensity: 100, repetitive: 100, crossPage: 100, fingerprints: 100, assets: 100 };
  assert.equal(composite(nearMax), 100);
});

// ---------------------------------------------------------------------------
// Return-shape and determinism guards
// ---------------------------------------------------------------------------

test('scorer: return shape unchanged ({slopScore, components}); deterministic across calls', () => {
  const input = { filler: 0, boilerplate: 32, infoDensity: 50, repetitive: 7, crossPage: 0, fingerprints: 15, assets: 3 };
  const a = computeSlopScore(cat(input));
  const b = computeSlopScore(cat(input));
  assert.deepEqual(a, b, 'same input -> identical output');
  assert.deepEqual(Object.keys(a).sort(), ['components', 'slopScore']);
  assert.ok(Number.isInteger(a.slopScore) && a.slopScore >= 0 && a.slopScore <= 100);
  for (const [k, c] of Object.entries(a.components)) {
    assert.ok(Number.isFinite(c.score) && Number.isFinite(c.weight) && Number.isFinite(c.weighted), `${k} component shape`);
  }
});