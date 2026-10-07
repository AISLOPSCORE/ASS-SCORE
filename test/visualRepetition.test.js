import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeIconRepetition,
  analyzeClassSeqRepetition,
  visualRepetitionHits,
  VISUAL_REPETITION_RULES,
  VISUAL_REPETITION_MAX_WEIGHT,
  KNOWN_ICON_PATHS,
} from '../src/rules/visualRepetition.js';
import { analyzeFingerprints, FINGERPRINTS, TOTAL_FINGERPRINT_WEIGHT } from '../src/rules/fingerprints.js';
import { parseEvidenceTokens, signalTagFor } from '../src/threeLayer.js';
import {
  loadFixture,
  analyzeFixtureFingerprints,
  fixtureBreakdown,
} from './fixtures/helpers.js';

// ---------------------------------------------------------------------------
// Round-1 DESIGN signals #1 + #2 (owner-approved 2026-10-05; ROUND1-SPEC.md).
// Signal #1: repeated stock-icon rendering (lucide/feather/FA/bi/ti/md
// libraries; identities at >=5 elements). Signal #2: repeated identical class
// sequences (E1–E6 gating; evidence >=5 elements). Both slot ADDITIVELY into
// the fingerprints (DESIGN) category as count-tiered rules (denominator
// 49 -> 55), receipts via the existing count-token frame.
// ---------------------------------------------------------------------------

const B2P_ICON_RECEIPT =
  'recognizable template sign in the page html: repeated stock-icon rendering — 75 token usages (lucide-check ×33, lucide-star ×30, lucide-quote ×6, lucide-chevron-down ×6) (high confidence)';
const B2P_SEQ_RECEIPT =
  'recognizable template sign in the page html: repeated identical class sequences — 224 token usages ("flex gap-2" ×34, "lucide lucide-check mt-0.5 size-4 shrink-0 text-primary" ×33, "lucide lucide-star size-4 fill-primary" ×30, "flex items-center justify-between" ×10, "mt-1 text-sm text-muted-foreground" ×9, "text-sm text-muted-foreground" ×9) (high confidence)';

// --- 1. stripe fixture: both signals quiet, DESIGN dilution only ------------

test('visual: stripe fixture — icon + seq analyzers both null (custom arrows, hds-*/BEM gated)', () => {
  const html = loadFixture('stripe');
  assert.equal(analyzeIconRepetition(html), null, '59x custom carousel-arrow path is not allowlisted; hds-* matches no library');
  assert.equal(analyzeClassSeqRepetition(html), null, '86x hds-link footer-links-block__item -> E2 link-list; every hds-*/BEM seq -> E6 custom-system; section-row* -> E3');
});

test('visual: stripe fixture — DESIGN 14 -> 13 (pure denominator dilution), composite 17 -> 16', () => {
  const r = analyzeFixtureFingerprints('stripe');
  assert.equal(r.score, 13, '7 low boolean hits / 55 (the 10-01 49 + the two round-1 rules 3+3) = round(100*7/55)');
  const { breakdown, composite } = fixtureBreakdown('stripe', 0);
  assert.equal(breakdown.fingerprints.score, 13);
  // 17 -> 16 (report-trust fix 2026-10-07): the boundary-spaced sentence
  // corpus drops infoDensity 51 -> 31 (glued 222-word pseudo-run-ons -> 107
  // real sentences, mean 16.6) and lifts repetitive 25 -> 44 (the honest
  // corpus exposes the real 4x/3x/2x receipts); DESIGN stays 13.
  assert.equal(composite, 16, 'composite moves on the honest sentence corpus (i 51->31, r 25->44)');
});

// --- 2. clean fixtures: both signals null, nothing moves --------------------

test('visual: getcollectionscopilot + ass-score fixtures — both analyzers null, DESIGN stays 0; composites 7/11 -> 5/13', () => {
  for (const name of ['getcollectionscopilot', 'ass-score']) {
    const html = loadFixture(name);
    assert.equal(analyzeIconRepetition(html), null, `${name} icon quiet`);
    assert.equal(analyzeClassSeqRepetition(html), null, `${name} seq quiet (flex items-start gap-2 x11 etc. all E4-excluded; transition hover:text-white/80 x4 -> E2)`);
    const r = analyzeFixtureFingerprints(name);
    assert.equal(r.score, 0, `${name} DESIGN stays 0`);
    assert.deepEqual(r.findings, ['no recognizable template signs detected']);
  }
  // DESIGN is 0 for both; the composites move ONLY on the report-trust fix
  // 2026-10-07 sentence corpus (infoDensity 49 -> 31 for cc, 45 -> 55 for
  // ass-score — boundary-spaced sentences: cc's 11 fake 39.6-word run-ons
  // became 38 real 11.5-word sentences; ass-score's UI labels split into
  // 5.0-word staccato fragments). Not a DESIGN effect.
  assert.equal(fixtureBreakdown('getcollectionscopilot', 0).composite, 5);
  assert.equal(fixtureBreakdown('ass-score', 0).composite, 13);
});

// --- 3. blog2posts fixture: the target receipts + DESIGN/composite pins ----

test('visual: blog2posts fixture — icon hit exact counts + high tier', () => {
  const html = loadFixture('blog2posts');
  const hit = analyzeIconRepetition(html);
  assert.ok(hit, 'icon signal fires');
  assert.equal(hit.id, 'stock-icon-repetition');
  assert.equal(hit.label, 'repeated stock-icon rendering');
  assert.equal(hit.scope, 'html');
  assert.equal(hit.confidence, 'high');
  assert.deepEqual(hit.counts, [
    { token: 'lucide-check', count: 33 },
    { token: 'lucide-star', count: 30 },
    { token: 'lucide-quote', count: 6 },
    { token: 'lucide-chevron-down', count: 6 },
  ]);
  // Live-parity pin: fixture == live measurement to the digit (75 / 33).
  assert.equal(hit.counts.reduce((s, c) => s + c.count, 0), 75);
});

test('visual: blog2posts fixture — seq hit: quoted top entry "flex gap-2" x34, 224 total, high', () => {
  const html = loadFixture('blog2posts');
  const hit = analyzeClassSeqRepetition(html);
  assert.ok(hit, 'class-sequence signal fires');
  assert.equal(hit.id, 'class-sequence-repetition');
  assert.equal(hit.label, 'repeated identical class sequences');
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.counts[0].token, '"flex gap-2"', 'top sequence is string-quoted');
  assert.equal(hit.counts[0].count, 34);
  // Live-parity pins: fixture reproduces live to the digit (224 total, 33
  // for the 6-token check row, 34 for flex gap-2).
  assert.equal(hit.counts.reduce((s, c) => s + c.count, 0), 224);
  const checkRow = hit.counts.find((c) => c.token.includes('lucide-check'));
  assert.equal(checkRow.count, 33);
  const firstSix = hit.counts.slice(0, 6).map((c) => c.token);
  assert.deepEqual(firstSix, [
    '"flex gap-2"',
    '"lucide lucide-check mt-0.5 size-4 shrink-0 text-primary"',
    '"lucide lucide-star size-4 fill-primary"',
    '"flex items-center justify-between"',
    '"mt-1 text-sm text-muted-foreground"',
    '"text-sm text-muted-foreground"',
  ]);
});

test('visual: blog2posts fixture — exact receipt strings byte-for-byte', () => {
  const r = analyzeFixtureFingerprints('blog2posts');
  assert.ok(r.findings.includes(B2P_ICON_RECEIPT), 'icon receipt matches the spec template exactly');
  assert.ok(r.findings.includes(B2P_SEQ_RECEIPT), 'seq receipt matches the spec template exactly');
});

test('visual: blog2posts fixture — DESIGN 10 -> 20, composite 14 -> 7 (honest sentences switch C1 off)', () => {
  const r = analyzeFixtureFingerprints('blog2posts');
  assert.equal(r.score, 20, 'hitWeight 11 (5 existing + 3 icon + 3 seq) / 55');
  const { breakdown, composite } = fixtureBreakdown('blog2posts', 0);
  assert.equal(breakdown.fingerprints.score, 20);
  // 14 -> 7 (report-trust fix 2026-10-07): boundary-spaced sentences drop
  // infoDensity 50 -> 30 (mean sentence length 40.0 -> 18.8 words, into the
  // healthy 12–26 band), which switches OFF the phase-2 C1 credit (needs
  // infoDensity >= 45) that had lifted 10.1 -> 14.1; +repetitive 1 (honest
  // 2× opening receipt) lands at 7. DESIGN stays 20.
  assert.equal(composite, 7, '+10 DESIGN at weight 0.10, no C1 credit (i 30 < 45)');
});

test('visual: known-path allowlist ships the measured pins (check path + FA glyph)', () => {
  assert.ok(KNOWN_ICON_PATHS.includes('M20 6 9 17l-5-5'), 'blog2posts lucide check path is pinned (33x)');
  assert.ok(KNOWN_ICON_PATHS.includes('M3 6L8 11L13 6'), 'seoloupe FA-family check glyph is pinned (12x unclassed)');
  // 53 distinct lucide paths observed on the blog2posts fixture + 1 pinned FA
  // glyph. (The spec described 50 on the live page; the fixture bytes yield
  // 53 under the identical collection rule — no pinned count depends on it.)
  assert.equal(KNOWN_ICON_PATHS.length, 54);
});

// --- 4. three-layer wiring: count-token parse + signal tag, unchanged ------

test('visual: three-layer parses the new receipts as count-token evidence', () => {
  const tokens = parseEvidenceTokens('fingerprints', B2P_SEQ_RECEIPT);
  assert.equal(tokens.label, 'repeated identical class sequences');
  assert.equal(tokens.scope, 'html');
  assert.equal(tokens.confidence, 'high');
  assert.equal(tokens.count, '224');
  assert.equal(tokens.topToken, '"flex gap-2"', 'top token keeps its quotes for copy');
  assert.equal(tokens.topCount, '34');
  assert.equal(signalTagFor('fingerprints', B2P_SEQ_RECEIPT), 'count-token');
  assert.equal(signalTagFor('fingerprints', B2P_ICON_RECEIPT), 'count-token');
  const icon = parseEvidenceTokens('fingerprints', B2P_ICON_RECEIPT);
  assert.equal(icon.count, '75');
  assert.equal(icon.topToken, 'lucide-check');
  assert.equal(icon.topCount, '33');
});

// --- 5. controls: minimal HTML snippets, every gate proven ----------------

const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

test('visual: E1 — single-token classes never enter the pool (acko "image" x85)', () => {
  const html = page('<div class="image">x</div>'.repeat(85));
  assert.equal(analyzeClassSeqRepetition(html), null);
  assert.equal(analyzeIconRepetition(html), null);
});

test('visual: E5 — specificity floor (acko "g6 ge4 re" x5 collapses to 0)', () => {
  const html = page('<div class="g6 ge4 re">x</div>'.repeat(5));
  assert.equal(analyzeClassSeqRepetition(html), null);
});

test('visual: E2/E3 — hemingway-style link-list rows and structural <ul> rows stay null', () => {
  // Reading-list title rows: <a> inside <ul> (E2 link-list).
  const linkRows = page('<ul><li><a class="text-lg font-semibold text-gray-900 hover:text-gray-600">t</a></li></ul>'.repeat(4));
  assert.equal(analyzeClassSeqRepetition(linkRows), null, 'title rows -> E2 link-list');
  // Identical <ul> rows: structural container tag (E3).
  const ulRows = page('<ul class="list-none p-0 m-0 space-y-4"><li>t</li></ul>'.repeat(4));
  assert.equal(analyzeClassSeqRepetition(ulRows), null, '<ul> rows -> E3 structural-tag');
  // Footer/nav link rows (fGCC "transition-colors hover:text-white" x7): <a> with a nav ancestor.
  const navRows = page('<nav>' + '<a class="transition-colors hover:text-white">t</a>'.repeat(7) + '</nav>');
  assert.equal(analyzeClassSeqRepetition(navRows), null, 'nav link rows -> E2 link-list');
});

test('visual: E6 — Stripe-style bounded in-house system (hds-icon hds-icon-hover-arrow x55) stays null', () => {
  const html = page('<span class="hds-icon hds-icon-hover-arrow">x</span>'.repeat(55));
  assert.equal(analyzeClassSeqRepetition(html), null);
});

test('visual: E4 — utility-only with semantic ancestor is the carve-out (b2p "flex gap-2" rows)', () => {
  // With a semantic ancestor: eligible via the carve-out.
  const withAncestor = page('<section class="bg-card">' + '<div class="flex gap-2">x</div>'.repeat(34) + '</section>');
  const hit = analyzeClassSeqRepetition(withAncestor);
  assert.ok(hit, 'utility-with-context is eligible');
  assert.deepEqual(hit.counts, [{ token: '"flex gap-2"', count: 34 }]);
  assert.equal(hit.confidence, 'high', '34 >= 20');
  // Without any semantic ancestor: full exclusion.
  const noAncestor = page('<main>' + '<div class="flex gap-2">x</div>'.repeat(34) + '</main>');
  assert.equal(analyzeClassSeqRepetition(noAncestor), null, 'utility-no-context -> E4 excluded');
});

test('visual: Stripe custom-arrow svgs (59x) trip nothing — no library class, path not allowlisted', () => {
  const arrow = '<svg class="hds-icon" aria-hidden="true"><path d="M4.84766 3.63379L5.45898 4.25L4.84766 3.63379"/></svg>';
  const html = page(arrow.repeat(59));
  assert.equal(analyzeIconRepetition(html), null, 'custom path is absent from the allowlist; hds-* matches no library');
  assert.equal(analyzeClassSeqRepetition(html), null, 'single-token svg class -> E1');
});

test('visual: evidence floor — 1-4 identical icons/sequences never report', () => {
  const four = page('<svg class="lucide lucide-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'.repeat(4));
  assert.equal(analyzeIconRepetition(four), null, '4 identical icons is ordinary use (floor is 5)');
  const fourSeq = page('<div class="card card-body">x</div>'.repeat(4));
  assert.equal(analyzeClassSeqRepetition(fourSeq), null, '4 identical sequences is below the report band');
  const fiveSeq = page('<div class="card card-body">x</div>'.repeat(5));
  const hit = analyzeClassSeqRepetition(fiveSeq);
  assert.ok(hit && hit.confidence === 'medium', '5 identical sequences -> medium');
  const fiveIcon = page('<svg class="lucide lucide-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'.repeat(5));
  const ihit = analyzeIconRepetition(fiveIcon);
  assert.ok(ihit && ihit.confidence === 'medium', '5 identical icons -> medium');
  const twentyIcon = page('<svg class="lucide lucide-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'.repeat(20));
  const ihit20 = analyzeIconRepetition(twentyIcon);
  assert.ok(ihit20 && ihit20.confidence === 'high', '20 identical icons -> high');
});

test('visual: unclassed svg counts only via the allowlist (seoloupe check glyph)', () => {
  // The pinned FA-family check glyph: 12 unclassed duplicates are evidence.
  const check = '<svg aria-hidden="true"><path d="M3 6L8 11L13 6"/></svg>';
  const html = page(check.repeat(12));
  const hit = analyzeIconRepetition(html);
  assert.ok(hit, 'unclassed svg with a KNOWN path counts');
  assert.deepEqual(hit.counts, [{ token: 'stock path "M3 6L8 11L13 6"', count: 12 }]);
  // The same glyph unclassed at 4 elements is below the floor.
  assert.equal(analyzeIconRepetition(page(check.repeat(4))), null);
  // An unclassed svg with a NON-allowlisted path never counts.
  const custom = '<svg aria-hidden="true"><path d="M4.84766 3.63379L5.45898 4.25L4.84766 3.63379"/></svg>';
  assert.equal(analyzeIconRepetition(page(custom.repeat(59))), null);
});

// --- 6. spec-parity guard: JSON untouched, denominator 55, clean pins ------

test('visual: spec parity — fingerprints.json stays 29 rules; the two new rules are module-level, not JSON literals', () => {
  const jsonCountRules = FINGERPRINTS.filter((fp) => Array.isArray(fp.countTokens) && fp.countTokens.length > 0);
  assert.equal(FINGERPRINTS.length, 29);
  assert.equal(jsonCountRules.length, 4);
  assert.deepEqual(VISUAL_REPETITION_RULES.map((r) => r.id), ['stock-icon-repetition', 'class-sequence-repetition']);
  assert.equal(VISUAL_REPETITION_MAX_WEIGHT, 6, 'two rules at max tier high=3 each');
  assert.equal(TOTAL_FINGERPRINT_WEIGHT, 55, '49 (JSON) + 6 (visual repetition)');
  assert.equal(49 + VISUAL_REPETITION_MAX_WEIGHT, TOTAL_FINGERPRINT_WEIGHT);
});

test('visual: ass-score-home scorer/verdict output unchanged (DESIGN 0, composite 11 -> 13)', () => {
  const { breakdown, composite } = fixtureBreakdown('ass-score', 0);
  assert.equal(breakdown.fingerprints.score, 0);
  // 11 -> 13 (report-trust fix 2026-10-07 — boundary-spaced sentence corpus:
  // mean sentence length 9.2 -> 5.0 words -> infoDensity 45 -> 55). Still
  // MOSTLY CLEAN on the owner 10-band scale.
  assert.equal(composite, 13);
  const r = analyzeFixtureFingerprints('ass-score');
  assert.equal(r.score, 0);
  assert.deepEqual(r.findings, ['no recognizable template signs detected']);
});

test('visual: determinism — same bytes -> identical analyzer results, repeated scans stay isolated', () => {
  const b2p = loadFixture('blog2posts');
  const first = { icon: analyzeIconRepetition(b2p), seq: analyzeClassSeqRepetition(b2p) };
  // A dirty scan (icons + sequences) must NOT leak into the next scan's
  // known-path table or any shared state (per-scan allowlist).
  const dirty = loadFixture('blog2posts');
  void analyzeIconRepetition(dirty);
  void analyzeClassSeqRepetition(dirty);
  const second = { icon: analyzeIconRepetition(b2p), seq: analyzeClassSeqRepetition(b2p) };
  assert.deepEqual(second, first, 'repeat scan is byte-identical');
  assert.deepEqual(visualRepetitionHits(b2p), [first.icon, first.seq], 'composition order: [icon, seq], nulls dropped');
  const clean = loadFixture('ass-score');
  assert.deepEqual(analyzeIconRepetition(clean), null);
  assert.deepEqual(analyzeClassSeqRepetition(clean), null);
});