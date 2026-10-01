import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeFingerprints,
  FINGERPRINTS,
  CONFIDENCE_WEIGHT,
  TOTAL_FINGERPRINT_WEIGHT,
  resolveTierConfidence,
} from '../src/rules/fingerprints.js';
import { parseEvidenceTokens, signalTagFor, withInsights, THREE_LAYER_POOLS } from '../src/threeLayer.js';
import {
  loadFixture,
  analyzeFixtureFingerprints,
  fixtureBreakdown,
} from './fixtures/helpers.js';

// ---------------------------------------------------------------------------
// Fingerprint count-tiered vocabulary rules (owner-approved 2026-10-01).
// Four new rules added to fingerprints.json — shadcn/ui, MUI, Bootstrap and
// the stock Tailwind palette — all count-token + tiers. Deterministic: JSON
// order, literal token matching, count-tiered confidence.
// ---------------------------------------------------------------------------

const NEW_RULE_IDS = ['shadcn-ui-vocabulary', 'mui-vocabulary', 'bootstrap-vocabulary', 'tailwind-stock-palette'];

// Synthetic pages use data-u attributes (NO 'class=' substring), so none of
// the boolean layout rules can fire; only the shadcn count rule engages.
// Each div carries ONE token occurrence, so shadcnPage(n) == exactly n tokens.
const shadcnPage = (n) => `<!doctype html><html><head><title>t</title></head><body>${'<div data-u="bg-primary"></div>'.repeat(n)}</body></html>`;

test('vocab: TOTAL_FINGERPRINT_WEIGHT recomputes 35 -> 49 (4 count rules at max tier high=3 + tenweb medium=2)', () => {
  const countRules = FINGERPRINTS.filter((fp) => Array.isArray(fp.countTokens) && fp.countTokens.length > 0);
  assert.equal(countRules.length, 4);
  assert.deepEqual(countRules.map((fp) => fp.id), NEW_RULE_IDS);
  assert.equal(TOTAL_FINGERPRINT_WEIGHT, 35 + 4 * CONFIDENCE_WEIGHT.high + CONFIDENCE_WEIGHT.medium);
  assert.equal(TOTAL_FINGERPRINT_WEIGHT, 49);
});

test('vocab: tier boundaries — 0 = no hit; 1-4 = base low; 5-19 = medium; 20+ = high', () => {
  // 0 tokens -> no hit at all
  const zero = analyzeFingerprints({ html: shadcnPage(0) });
  assert.equal(zero.score, 0);
  assert.equal(zero.hits.length, 0);
  assert.deepEqual(zero.findings, ['no recognizable template signs detected']);

  // 2 tokens (incidental page, exactly two occurrences) -> no tier matches
  // -> base confidence 'low'
  const two = analyzeFingerprints({ html: '<div data-u="bg-primary"></div><div data-u="bg-card"></div>' });
  const twoHit = two.hits.find((h) => h.id === 'shadcn-ui-vocabulary');
  assert.ok(twoHit, '2-token incidental page still produces a low hit');
  assert.equal(twoHit.confidence, 'low');
  assert.equal(CONFIDENCE_WEIGHT[twoHit.confidence], 1);
  assert.equal(twoHit.counts.reduce((s, c) => s + c.count, 0), 2);
  assert.equal(two.score, Math.round((100 * 1) / TOTAL_FINGERPRINT_WEIGHT)); // low weight 1

  // 5 tokens -> medium (weight 2)
  const five = analyzeFingerprints({ html: shadcnPage(5) });
  const fiveHit = five.hits.find((h) => h.id === 'shadcn-ui-vocabulary');
  assert.equal(fiveHit.confidence, 'medium');
  assert.equal(CONFIDENCE_WEIGHT[fiveHit.confidence], 2);
  assert.equal(fiveHit.counts.reduce((s, c) => s + c.count, 0), 5);
  assert.equal(five.score, Math.round((100 * 2) / TOTAL_FINGERPRINT_WEIGHT));

  // 19 tokens -> still medium; 20 tokens -> high (weight 3)
  assert.equal(analyzeFingerprints({ html: shadcnPage(19) }).hits[0].confidence, 'medium');
  const twenty = analyzeFingerprints({ html: shadcnPage(20) });
  const twentyHit = twenty.hits.find((h) => h.id === 'shadcn-ui-vocabulary');
  assert.equal(twentyHit.confidence, 'high');
  assert.equal(twentyHit.counts.reduce((s, c) => s + c.count, 0), 20);
  assert.equal(twenty.score, Math.round((100 * 3) / TOTAL_FINGERPRINT_WEIGHT));
});

test('vocab: resolveTierConfidence — highest tier whose min <= total, else null', () => {
  const fp = FINGERPRINTS.find((r) => r.id === 'shadcn-ui-vocabulary');
  assert.equal(resolveTierConfidence(fp, 0), null);
  assert.equal(resolveTierConfidence(fp, 1), null);
  assert.equal(resolveTierConfidence(fp, 4), null);
  assert.equal(resolveTierConfidence(fp, 5), 'medium');
  assert.equal(resolveTierConfidence(fp, 19), 'medium');
  assert.equal(resolveTierConfidence(fp, 20), 'high');
  assert.equal(resolveTierConfidence(fp, 999), 'high');
});

test('vocab: tokens are matched LITERALLY, not as regex (escaping)', () => {
  // "bg-slate-" has a trailing dash — must only match the literal string
  // (a regex would treat "-" as range punctuation or match prefixes).
  const hit = analyzeFingerprints({ html: '<div data-u="bg-slate-500">' });
  const tw = hit.hits.find((h) => h.id === 'tailwind-stock-palette');
  assert.ok(tw, 'literal bg-slate-500 triggers the tailwind rule');
  assert.equal(tw.confidence, 'low', '1 token -> base low');
  assert.deepEqual(tw.counts, [{ token: 'bg-slate-', count: 1 }]);
  // A class that merely CONTAINS the token text must NOT match: "bg-slate900"
  // lacks the literal trailing dash.
  const miss = analyzeFingerprints({ html: '<div data-u="bg-slate900">' });
  assert.equal(miss.hits.find((h) => h.id === 'tailwind-stock-palette'), undefined);
});

test('vocab: boolean rules keep first-match behavior and are untouched by count rules', () => {
  const r = analyzeFingerprints({
    html: '<!doctype html><html><head><meta name="generator" content="Framer" /></head><body><script src="https://v0.dev/chat.js"></script></body></html>',
    head: '<meta name="generator" content="Framer" />',
    text: '',
  });
  const ids = r.hits.map((h) => h.id);
  assert.ok(ids.includes('v0.dev'));
  assert.ok(ids.includes('named-builder-generator'));
  for (const h of r.hits) {
    if (!NEW_RULE_IDS.includes(h.id)) {
      assert.ok(!Array.isArray(h.counts), 'boolean hits carry no counts');
      assert.equal(typeof h.pattern, 'string');
    }
  }
});

test('vocab: count-token hit record carries counts + resolved confidence; finding embeds real numbers', () => {
  const r = analyzeFingerprints({ html: shadcnPage(20) });
  const hit = r.hits.find((h) => h.id === 'shadcn-ui-vocabulary');
  assert.equal(hit.confidence, 'high');
  assert.deepEqual(hit.counts, [{ token: 'bg-primary', count: 20 }]); // deterministic JSON order, count>0 only
  const finding = r.findings[0];
  assert.equal(
    finding,
    'recognizable template sign in the page html: shadcn/ui component-library token vocabulary — 20 token usages (bg-primary ×20) (high confidence)',
  );
});

// ---------------------------------------------------------------------------
// Cached-fixture regression matrix (raw saved HTML; no live fetches).
// ---------------------------------------------------------------------------

test('matrix: blog2posts — shadcn receipt + recomputed fingerprints score', () => {
  const r = analyzeFixtureFingerprints('blog2posts');
  const byId = new Map(r.hits.map((h) => [h.id, h]));
  assert.equal(r.score, 10, 'hitWeight 5 (gradient-utility low + card-grid low + shadcn high) / 49 (tenweb medium raised the denominator 47 -> 49)');
  assert.ok(byId.has('gradient-utility-layout'));
  assert.ok(byId.has('card-grid-layout'));
  const shadcn = byId.get('shadcn-ui-vocabulary');
  assert.ok(shadcn, 'shadcn receipt present on the blog2posts fixture');
  assert.equal(shadcn.confidence, 'high', '223 token usages >= tier min 20');
  const total = shadcn.counts.reduce((s, c) => s + c.count, 0);
  assert.equal(total, 223);
  // Top-by-count order, cap at 6, deterministic: bg-destructive (3) is the
  // 7th token and must be cut from the receipt.
  const receipt = r.findings.find((f) => f.includes('shadcn/ui component-library'));
  assert.ok(receipt.includes('— 223 token usages ('));
  assert.ok(receipt.includes('text-muted-foreground ×81'));
  assert.ok(receipt.includes('text-foreground ×34'));
  assert.ok(receipt.includes('bg-primary ×33'));
  assert.ok(receipt.includes('bg-card ×29'));
  assert.ok(receipt.includes('--radix- ×24'));
  assert.ok(receipt.includes('bg-background ×19'));
  assert.ok(!receipt.includes('bg-destructive'), 'receipt caps listed tokens at 6');
  assert.ok(receipt.endsWith('(high confidence)'));
  // The other three new rules find nothing on blog2posts.
  for (const id of ['mui-vocabulary', 'bootstrap-vocabulary', 'tailwind-stock-palette']) {
    assert.equal(byId.has(id), false, `${id} has 0 hits on blog2posts`);
  }
  // Fixture-computed "headline" proxy: full-weight composite with crossPage
  // EXPLICITLY injected as 0. The in-page repeated-phrase signal moved to the
  // crossPage rule (REPETITION card — pass 2, 2026-10-01), so this proxy,
  // which injects crossPage=0, cannot see it: 9 is the main-equivalent value
  // (tenweb denominator shift dropped DESIGN 11 -> 10, -0.1). The REAL fixture
  // scan scores crossPage 5 (+1.5 at weight 0.30) -> composite 11; the
  // repetitivePhrases matrix asserts that directly.
  assert.equal(fixtureBreakdown('blog2posts', 0).composite, 9);
});

test('matrix: getcollectionscopilot — fingerprints stays 0, all 4 new rules 0 hits', () => {
  const r = analyzeFixtureFingerprints('getcollectionscopilot');
  assert.equal(r.score, 0);
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.findings, ['no recognizable template signs detected']);
  for (const id of NEW_RULE_IDS) {
    assert.ok(!r.hits.some((h) => h.id === id), `${id} must have 0 hits (white tokens excluded)`);
  }
});

test('matrix: stripe — same 7 boolean hits, zero new vocab hits, recomputed score 15', () => {
  const r = analyzeFixtureFingerprints('stripe');
  const ids = r.hits.map((h) => h.id);
  assert.deepEqual(ids.slice(0, 7).sort(), [
    'bento-layout',
    'card-grid-layout',
    'cta-layout',
    'gradient-utility-layout',
    'hero-section-layout',
    'stats-band-layout',
    'testimonial-layout',
  ].sort());
  assert.equal(ids.length, 7, 'no additional hits');
  for (const id of NEW_RULE_IDS) {
    assert.ok(!ids.includes(id), `${id} must have 0 hits on stripe`);
  }
  // Denominator 35 -> 47 -> 49 (tenweb medium) recomputes the score for the
  // UNCHANGED hit set (7 low hits): round(100*7/49) = 14.
  assert.equal(r.score, 14);
});

test('matrix: ass-score.com — fingerprints unchanged (0), overall composite STAYS 11, no new false positives', () => {
  const r = analyzeFixtureFingerprints('ass-score');
  assert.equal(r.score, 0);
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.findings, ['no recognizable template signs detected']);
  for (const id of NEW_RULE_IDS) {
    assert.ok(!r.hits.some((h) => h.id === id), `${id} must not false-positive on ass-score.com`);
  }
  // Full target-page reproduction (crossPage=0, as in the live scan):
  // boilerplate 45 + infoDensity 45 drive the composite; fingerprints 0 keeps
  // it at exactly 11 — the site's own score is preserved, not lowered.
  const { breakdown, composite } = fixtureBreakdown('ass-score', 0);
  assert.equal(breakdown.filler.score, 0);
  assert.equal(breakdown.boilerplate.score, 45);
  assert.equal(breakdown.infoDensity.score, 45);
  assert.equal(breakdown.repetitive.score, 0);
  assert.equal(breakdown.fingerprints.score, 0);
  assert.equal(breakdown.assets.score, 0);
  assert.equal(composite, 11);
});

test('matrix: fixtures are deterministic (same bytes -> identical results)', () => {
  for (const name of ['blog2posts', 'getcollectionscopilot', 'stripe', 'ass-score']) {
    assert.deepEqual(analyzeFixtureFingerprints(name), analyzeFixtureFingerprints(name));
  }
});

// ---------------------------------------------------------------------------
// Three-layer wiring: the new count-token receipts must reach the bespoke
// copy (roasts citing real counts; gated whys/fixes).
// ---------------------------------------------------------------------------

const BLOG2POSTS_RECEIPT =
  'recognizable template sign in the page html: shadcn/ui component-library token vocabulary — 223 token usages (text-muted-foreground ×81, text-foreground ×34, bg-primary ×33, bg-card ×29, --radix- ×24, bg-background ×19) (high confidence)';

test('three-layer: count-token receipts parse into measurable tokens', () => {
  const tokens = parseEvidenceTokens('fingerprints', BLOG2POSTS_RECEIPT);
  assert.equal(tokens.label, 'shadcn/ui component-library token vocabulary');
  assert.equal(tokens.scope, 'html');
  assert.equal(tokens.confidence, 'high');
  assert.equal(tokens.count, '223');
  assert.equal(tokens.topToken, 'text-muted-foreground');
  assert.equal(tokens.topCount, '81');
  assert.equal(tokens.tokenList, 'text-muted-foreground ×81, text-foreground ×34, bg-primary ×33, bg-card ×29, --radix- ×24, bg-background ×19');
});

test('three-layer: count-token evidence carries the count-token signal tag; boolean findings stay untagged', () => {
  assert.equal(signalTagFor('fingerprints', BLOG2POSTS_RECEIPT), 'count-token');
  assert.equal(signalTagFor('fingerprints', 'pattern evidence in html: v0.dev builder assets (high confidence, template-like signal)'), null);
  assert.equal(signalTagFor('fingerprints', 'recognizable template sign in the page html: generic card/grid layout classes (template card-grid) (low confidence)'), null);
  assert.equal(signalTagFor('fingerprints', 'no recognizable template signs detected'), null);
});

test('three-layer: bespoke count roasts are eligible for count-token findings (tokens all present + cite {label})', () => {
  const tokens = parseEvidenceTokens('fingerprints', BLOG2POSTS_RECEIPT);
  const eligible = THREE_LAYER_POOLS.fingerprints.roasts.filter((tpl) => {
    const declared = [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return declared.length > 0 && declared.every((t) => t in tokens);
  });
  const newRoasts = eligible.filter((t) => t.includes('{count}'));
  assert.equal(newRoasts.length, 4, 'all four count-token roast templates are eligible');
  for (const tpl of newRoasts) {
    assert.ok(tpl.includes('{label}'), 'every eligible roast must cite the {label} trigger');
  }
});

test('three-layer: insights for a count-token receipt interpolate fully (no leftover braces)', () => {
  const insights = withInsights(
    { fingerprints: { score: 11, findings: [BLOG2POSTS_RECEIPT], hits: [] } },
    'vocab-test-scan-id',
  ).fingerprints.insights;
  assert.equal(insights.length, 1);
  const insight = insights[0];
  assert.equal(insight.evidence, BLOG2POSTS_RECEIPT);
  assert.ok(!/\{[a-z]+\}/i.test(insight.roast), `roast not fully interpolated: ${insight.roast}`);
  assert.ok(insight.why && insight.fix, 'why/fix layers present (untagged + count-token gated pool)');
  assert.ok(!/\{[a-z]+\}/i.test(`${insight.why} ${insight.fix}`));
});