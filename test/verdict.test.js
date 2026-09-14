import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT_BANDS, clampScore, verdictBand, verdictFor, verdictLabel, scoreColor } from '../src/verdict.js';
import { publicScore, toPublicScan } from '../src/serialize.js';

// ---------------------------------------------------------------------------
// Verdict bands — the single source of truth. Boundaries are INCLUSIVE on max:
//   0-34 cleanest | 35-54 mildly generic | 55-74 very ass | 75-89 extremely
//   ass | 90-100 catastrophically ass  (HIGHER = WORSE)
// ---------------------------------------------------------------------------
test('verdictBand: exact lock-in boundaries (0→cleanest, 35→mildly; 55→very; 75→extremely; 90→catastrophic)', () => {
  const cases = [
    [0, 'CLEANEST', 'Cleanest'],
    [34, 'CLEANEST', 'Cleanest'],
    [35, 'MILDLY GENERIC', 'Mildly generic'],
    [54, 'MILDLY GENERIC', 'Mildly generic'],
    [55, 'VERY ASS', 'Very ass'],
    [74, 'VERY ASS', 'Very ass'],
    [75, 'EXTREMELY ASS', 'Extremely ass'],
    [89, 'EXTREMELY ASS', 'Extremely ass'],
    [90, 'CATASTROPHICALLY ASS', 'Catastrophically ass'],
    [100, 'CATASTROPHICALLY ASS', 'Catastrophically ass'],
  ];
  for (const [score, shortLabel, label] of cases) {
    const band = verdictBand(score);
    assert.equal(band.shortLabel, shortLabel, `score ${score} shortLabel`);
    assert.equal(band.label, label, `score ${score} label`);
  }
});

test('verdictBand: every integer 0-100 lands in exactly one band (no gaps, no overlaps)', () => {
  for (let s = 0; s <= 100; s += 1) {
    const band = verdictBand(s);
    assert.ok(s >= band.min && s <= band.max, `score ${s} inside [${band.min},${band.max}]`);
    assert.ok(
      [0, 35, 55, 75, 90].some((edge) => band.min === edge),
      `band min ${band.min} is a locked boundary edge`
    );
  }
  // Bands tile the full 0-100 range with the locked edges and no duplicates.
  const mins = VERDICT_BANDS.map((b, i) => (i === 0 ? 0 : VERDICT_BANDS[i - 1].max + 1));
  assert.deepEqual(mins, [0, 35, 55, 75, 90]);
  assert.deepEqual(VERDICT_BANDS.map((b) => b.max), [34, 54, 74, 89, 100]);
  assert.equal(VERDICT_BANDS[4].alias, 'certified slop', 'catastrophic band keeps its alias');
  assert.equal(VERDICT_BANDS[4].shortLabel, 'CATASTROPHICALLY ASS', 'catastrophic is the TOP band (90-100)');
  assert.equal(VERDICT_BANDS[0].shortLabel, 'CLEANEST', 'cleanest is the BOTTOM band (0-34)');
});

test('verdictBand: color direction green (low/good) -> red (high/bad)', () => {
  assert.equal(scoreColor(10), '#4ade80', 'low (clean) -> green');
  assert.equal(scoreColor(40), '#a3e635', 'mildly -> lime');
  assert.equal(scoreColor(60), '#facc15', 'very ass -> amber');
  assert.equal(scoreColor(80), '#fb923c', 'extremely -> orange');
  assert.equal(scoreColor(95), '#f87171', 'high (catastrophic) -> red');
  assert.notEqual(scoreColor(34), scoreColor(35), 'band color changes at the boundary');
  assert.notEqual(scoreColor(89), scoreColor(90), 'band color changes at the boundary');
  for (const b of VERDICT_BANDS) assert.match(b.color, /^#[0-9a-f]{6}$/i, `${b.shortLabel} color hex`);
});

test('verdictFor/verdictLabel: prose label vs uppercase display label', () => {
  assert.equal(verdictFor(60), 'Very ass');
  assert.equal(verdictLabel(60), 'VERY ASS');
  assert.equal(verdictFor(90), 'Catastrophically ass');
  assert.equal(verdictLabel(90), 'CATASTROPHICALLY ASS');
  assert.equal(verdictFor(73), 'Very ass'); // hero mockup claim: 73 = VERY ASS
  assert.equal(verdictLabel(73), 'VERY ASS');
});

test('clampScore: deterministic normalization for NaN/out-of-range/non-integer', () => {
  assert.equal(clampScore(0), 0);
  assert.equal(clampScore(100), 100);
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(150), 100);
  assert.equal(clampScore(73.6), 74);
  assert.equal(clampScore('59'), 59);
  assert.equal(clampScore(NaN), 0);
  assert.equal(clampScore(Infinity), 0); // non-finite -> 0 (defined behavior)
  assert.equal(clampScore(undefined), 0);
  assert.equal(verdictBand(-1).shortLabel, 'CLEANEST');
  assert.equal(verdictBand(999).shortLabel, 'CATASTROPHICALLY ASS');
  assert.equal(verdictBand(NaN).shortLabel, 'CLEANEST');
});

// ---------------------------------------------------------------------------
// The serialization boundary (src/serialize.js) — same direction, no inversion
// ---------------------------------------------------------------------------
test('publicScore: identity clamp — engine slop direction == public score, higher = worse', () => {
  assert.equal(publicScore(30), 30, 'example.com internal 30 -> public 30');
  assert.equal(publicScore(75), 75, 'hedge fixture internal 75 -> public 75');
  assert.equal(publicScore(10), 10, 'specifics fixture internal 10 -> public 10');
  assert.equal(publicScore(0), 0, 'zero slop -> clean public score');
  assert.equal(publicScore(100), 100, 'max slop -> catastrophic public score');
  assert.equal(publicScore(NaN), 0, 'unusable score reads as clean (clamped 0)');
  assert.equal(publicScore(-10), 0);
  assert.equal(publicScore(150), 100);
});

test('toPublicScan: runScan payload shape (slopScore) -> public scan', () => {
  const pub = toPublicScan({
    id: 'scan-1',
    url: 'https://example.com/',
    slopScore: 42,
    breakdown: {
      filler: { score: 50, findings: ['filler finding'] },
      boilerplate: { score: 0, findings: [] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      assets: { score: 77, findings: ['asset finding'], evidence: ['evidence stays'] },
    },
    roast: 'A roast line.',
    createdAt: '2026-09-08T00:00:00.000Z',
  });
  assert.equal(pub.score, 42, 'hit the 35-54 MILDLY GENERIC band');
  assert.equal(pub.verdict, 'MILDLY GENERIC');
  assert.ok(!('slopScore' in pub), 'internal field name is replaced');
  assert.equal(pub.breakdown.filler.score, 50, '50 stays 50 (no inversion)');
  assert.deepEqual(pub.breakdown.filler.findings, ['filler finding'], 'findings untouched');
  assert.equal(pub.breakdown.boilerplate.score, 0, '0 stays 0 (no inversion)');
  assert.equal(pub.breakdown.crossPage.score, null, 'null-score module (skipped) passes through');
  assert.equal(pub.breakdown.crossPage.note, 'insufficient pages for cross-page analysis');
  assert.equal(pub.breakdown.assets.score, 77, '77 stays 77 (no inversion)');
  assert.deepEqual(pub.breakdown.assets.evidence, ['evidence stays'], 'evidence untouched');
  assert.equal(pub.breakdown.assets.findings[0], 'asset finding');
  assert.equal(pub.roast, 'A roast line.');
  assert.equal(pub.id, 'scan-1');
});

test('toPublicScan: stored-row shape (score column) -> same public scan (pre-flip rows, no migration)', () => {
  const pub = toPublicScan({
    id: 'old-row',
    url: 'https://example.com/',
    score: 30, // stored slop direction == public direction (0 = clean, 100 = max ass)
    breakdown: { filler: { score: 30, findings: ['f'] } },
    created_at: '2026-08-01T00:00:00.000Z',
    partial: false,
    worstPage: { url: 'https://example.com/blog', score: 71, findings: ['x'] },
  });
  assert.equal(pub.score, 30, 'pre-flip stored 30 reads as public 30 (no inversion)');
  assert.equal(pub.verdict, 'CLEANEST');
  assert.equal(pub.breakdown.filler.score, 30);
  assert.equal(pub.worstPage.score, 71, 'worstPage.score stays in the same direction (higher = worse)');
  assert.equal(pub.created_at, '2026-08-01T00:00:00.000Z', 'row fields pass through');
});

test('toPublicScan: deterministic — same input always yields the identical public scan', () => {
  const input = {
    id: 'x', url: 'https://a.example/', slopScore: 63,
    breakdown: { filler: { score: 20, findings: ['a'] }, crossPage: { score: null, note: 'n' } },
  };
  assert.deepEqual(toPublicScan(input), toPublicScan(input));
});

test('toPublicScan: defensive — no breakdown / no scores -> clean public score, empty breakdown', () => {
  const pub = toPublicScan({ id: 'x', url: 'https://a.example/' });
  assert.equal(pub.score, 0, 'missing score reads as clean (clamped 0)');
  assert.equal(pub.verdict, 'CLEANEST');
  assert.deepEqual(pub.breakdown, {});
});