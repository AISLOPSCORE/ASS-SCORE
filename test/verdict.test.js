import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT_BANDS, clampScore, verdictBand, verdictFor, verdictLabel, scoreColor } from '../src/verdict.js';
import { publicScore, toPublicScan } from '../src/serialize.js';

// ---------------------------------------------------------------------------
// Verdict bands — the single source of truth. Boundaries are INCLUSIVE on max:
//   0-9 clean | 10-19 mostly clean | 20-29 slightly assy | 30-39 assy |
//   40-49 pretty assy | 50-59 very assy | 60-69 heavily assy | 70-79 extremely
//   assy | 80-89 catastrophically assy | 90-100 beyond ass (HIGHER = WORSE).
// Owner 10-point scale (2026-10-05): 50 is the hinge; 90-100 = total collapse.
// ---------------------------------------------------------------------------
test('verdictBand: exact lock-in boundaries for all 10 bands (20 boundary pins)', () => {
  const cases = [
    [0, 'CLEAN', 'Clean'],
    [9, 'CLEAN', 'Clean'],
    [10, 'MOSTLY CLEAN', 'Mostly clean'],
    [19, 'MOSTLY CLEAN', 'Mostly clean'],
    [20, 'SLIGHTLY ASSY', 'Slightly assy'],
    [29, 'SLIGHTLY ASSY', 'Slightly assy'],
    [30, 'ASSY', 'Assy'],
    [39, 'ASSY', 'Assy'],
    [40, 'PRETTY ASSY', 'Pretty assy'],
    [49, 'PRETTY ASSY', 'Pretty assy'],
    [50, 'VERY ASSY', 'Very assy'],
    [59, 'VERY ASSY', 'Very assy'],
    [60, 'HEAVILY ASSY', 'Heavily assy'],
    [69, 'HEAVILY ASSY', 'Heavily assy'],
    [70, 'EXTREMELY ASSY', 'Extremely assy'],
    [79, 'EXTREMELY ASSY', 'Extremely assy'],
    [80, 'CATASTROPHICALLY ASSY', 'Catastrophically assy'],
    [89, 'CATASTROPHICALLY ASSY', 'Catastrophically assy'],
    [90, 'BEYOND ASS', 'Beyond ass'],
    [100, 'BEYOND ASS', 'Beyond ass'],
  ];
  for (const [score, shortLabel, label] of cases) {
    const band = verdictBand(score);
    assert.equal(band.shortLabel, shortLabel, `score ${score} shortLabel`);
    assert.equal(band.label, label, `score ${score} label`);
  }
});

test('verdictBand: owner QA anchors — 7 -> CLEAN, 50 -> VERY ASSY (the hinge), 93 -> BEYOND ASS', () => {
  assert.equal(verdictLabel(7), 'CLEAN', '7 -> CLEAN');
  assert.equal(verdictLabel(50), 'VERY ASSY', '50 -> VERY ASSY (hinge)');
  assert.equal(verdictLabel(93), 'BEYOND ASS', '93 -> BEYOND ASS');
});

test('verdictBand: every integer 0-100 lands in exactly one band (no gaps, no overlaps)', () => {
  for (let s = 0; s <= 100; s += 1) {
    const band = verdictBand(s);
    assert.ok(s >= band.min && s <= band.max, `score ${s} inside [${band.min},${band.max}]`);
    assert.ok(
      [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].some((edge) => band.min === edge),
      `band min ${band.min} is a locked boundary edge`
    );
  }
  // Bands tile the full 0-100 range with the locked edges and no duplicates.
  const mins = VERDICT_BANDS.map((b, i) => (i === 0 ? 0 : VERDICT_BANDS[i - 1].max + 1));
  assert.deepEqual(mins, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.deepEqual(VERDICT_BANDS.map((b) => b.max), [9, 19, 29, 39, 49, 59, 69, 79, 89, 100]);
  assert.equal(VERDICT_BANDS.length, 10, 'ten bands on the owner 10-point scale');
  assert.equal(VERDICT_BANDS[9].shortLabel, 'BEYOND ASS', 'beyond ass is the TOP band (90-100)');
  assert.equal(VERDICT_BANDS[0].shortLabel, 'CLEAN', 'clean is the BOTTOM band (0-9)');
});

test('verdictBand: color direction green (low/good) -> dark red (high/bad)', () => {
  assert.equal(scoreColor(5), '#4ade80', '0-9 clean -> green');
  assert.equal(scoreColor(15), '#a3e635', '10-19 mostly clean -> lime');
  assert.equal(scoreColor(25), '#facc15', '20-29 slightly assy -> yellow');
  assert.equal(scoreColor(35), '#eab308', '30-39 assy -> dark yellow');
  assert.equal(scoreColor(45), '#fb923c', '40-49 pretty assy -> orange');
  assert.equal(scoreColor(55), '#f97316', '50-59 very assy -> deep orange');
  assert.equal(scoreColor(65), '#f87171', '60-69 heavily assy -> red');
  assert.equal(scoreColor(75), '#ef4444', '70-79 extremely assy -> deeper red');
  assert.equal(scoreColor(85), '#dc2626', '80-89 catastrophically assy -> dark red');
  assert.equal(scoreColor(95), '#b91c1c', '90-100 beyond ass -> darkest red');
  for (const [low, high] of [[9, 10], [19, 20], [29, 30], [39, 40], [49, 50], [59, 60], [69, 70], [79, 80], [89, 90]]) {
    assert.notEqual(scoreColor(low), scoreColor(high), `band color changes at the ${low}/${high} boundary`);
  }
  for (const b of VERDICT_BANDS) assert.match(b.color, /^#[0-9a-f]{6}$/i, `${b.shortLabel} color hex`);
});

test('verdictFor/verdictLabel: prose label vs uppercase display label', () => {
  assert.equal(verdictFor(60), 'Heavily assy');
  assert.equal(verdictLabel(60), 'HEAVILY ASSY');
  assert.equal(verdictFor(90), 'Beyond ass');
  assert.equal(verdictLabel(90), 'BEYOND ASS');
  assert.equal(verdictFor(50), 'Very assy'); // the 50 hinge
  assert.equal(verdictLabel(73), 'EXTREMELY ASSY');
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
  assert.equal(verdictBand(-1).shortLabel, 'CLEAN');
  assert.equal(verdictBand(999).shortLabel, 'BEYOND ASS');
  assert.equal(verdictBand(NaN).shortLabel, 'CLEAN');
});

// ---------------------------------------------------------------------------
// The serialization boundary (src/serialize.js) — same direction, no inversion
// ---------------------------------------------------------------------------
test('publicScore: identity clamp — engine slop direction == public score, higher = worse', () => {
  assert.equal(publicScore(30), 30, 'example.com internal 30 -> public 30');
  assert.equal(publicScore(75), 75, 'hedge fixture internal 75 -> public 75');
  assert.equal(publicScore(10), 10, 'specifics fixture internal 10 -> public 10');
  assert.equal(publicScore(0), 0, 'zero slop -> clean public score');
  assert.equal(publicScore(100), 100, 'max slop -> beyond-ass public score');
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
  assert.equal(pub.score, 42, 'hit the 40-49 PRETTY ASSY band');
  assert.equal(pub.verdict, 'PRETTY ASSY');
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
  assert.equal(pub.verdict, 'ASSY');
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
  assert.equal(pub.verdict, 'CLEAN');
  assert.deepEqual(pub.breakdown, {});
});