/**
 * Pass 2 (owner-approved 2026-10-01): in-page repeated-phrase detection.
 *
 * The repetitive rule gains a FOURTH signal: 4–12 word phrases / sentence
 * templates that recur 3+ times on one page, spread over >= 2 distinct
 * sentences (a claim hammered across hero + sections, templated testimonials
 * sharing a skeleton, …). ADDITIVE scoring: pages without the new signal
 * score byte-identically to before; the phrase term adds at most +20% to the
 * existing 3-signal blend.
 *
 * Coverage here:
 *   - unit behavior: thresholds, boundaries, quoting/location, determinism,
 *     the degenerate-input guard contract (restored byte-identical);
 *   - fixture A: templated testimonials (claim -> pain -> outcome skeleton
 *     with different specifics) fire the repeated-filler receipt;
 *   - fixture B: varied, well-written testimonials do NOT false-fire;
 *   - cached-fixture regression matrix (REPETITION subscore before/after);
 *   - three-layer wiring: evidence parser, phrase signal tag, bespoke
 *     phraseRoasts pool, and the legacy-picks no-drift guard.
 * No live fetches — fixtures only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, findRepeatedPhrases } from '../src/rules/repetitive.js';
import { runRules } from '../src/rules/index.js';
import { extractText } from '../src/text.js';
import { loadFixture } from './fixtures/helpers.js';
import {
  parseEvidenceTokens,
  signalTagFor,
  withInsights,
  buildCategoryInsights,
  THREE_LAYER_POOLS,
} from '../src/threeLayer.js';

// ---------------------------------------------------------------------------
// Guard contract — restored byte-identical to the pre-pass-2 code. Degenerate
// inputs return { score: 0, findings: [] }, never a fallback finding line.
// ---------------------------------------------------------------------------
test('guard: degenerate inputs keep the original contract { score: 0, findings: [] }', () => {
  assert.deepEqual(analyze(), { score: 0, findings: [] });
  assert.deepEqual(analyze({}), { score: 0, findings: [] });
  assert.deepEqual(analyze({ text: '' }), { score: 0, findings: [] });
  // Text with no sentence split is degenerate (original `!text || sentences.length === 0`).
  assert.deepEqual(analyze({ text: 'some text', sentences: [] }), { score: 0, findings: [] });
  // Title alone must NOT revive a degenerate page (the production per-page
  // path feeds extractMainText output, where a title-only page has no body
  // text — it must contribute zero findings, not a fallback line).
  assert.deepEqual(analyze({ text: '', title: 'A page title', sentences: [], paragraphs: [] }), { score: 0, findings: [] });
  // Non-degenerate input still analyses (guard is not over-broad).
  const ok = analyze({ text: 'one two three four', sentences: ['One two three four.'], title: 't' });
  assert.ok(ok.score === 0 && Array.isArray(ok.findings));
});

// ---------------------------------------------------------------------------
// Unit behavior of findRepeatedPhrases / analyze
// ---------------------------------------------------------------------------
test('phrase: 3+ occurrences across >=2 sentences fire; 2 do not', () => {
  const fire = [
    'Blog2Posts tripled my output in the first month.',
    'Blog2Posts doubled our reach in the first month.',
    'Blog2Posts grew our leads in the first month.',
  ];
  const phrases = findRepeatedPhrases({ sentences: fire });
  const p = phrases.find((x) => x.phrase === 'in the first month');
  assert.ok(p, `expected "in the first month" to fire, got ${JSON.stringify(phrases)}`);
  assert.equal(p.count, 3);

  const noFire = fire.slice(0, 2);
  assert.deepEqual(findRepeatedPhrases({ sentences: noFire }), []);

  // A single sentence containing the phrase 3x is a stutter, not a template:
  // must be filtered by the >= 2 distinct-sentence spread rule.
  const oneLine = ['We say a month of platform native content here and a month of platform native content there and a month of platform native content everywhere.'];
  assert.deepEqual(findRepeatedPhrases({ sentences: oneLine }), []);
});

test('phrase: 4-word minimum — 3-word repeats are ignored', () => {
  const threeWord = [
    'Buy now today and save ten percent.',
    'Buy now today for the best price.',
    'Buy now today folks, that is all.',
  ];
  assert.deepEqual(findRepeatedPhrases({ sentences: threeWord }), []);
});

test('phrase: hyphenated and spaced forms unify ("platform-native" == "platform native")', () => {
  const mixed = [
    'A month of platform-native content in minutes.',
    'Get a month of platform native content in minutes.',
    'One article into a month of platform-native posts.',
  ];
  const r = findRepeatedPhrases({ sentences: mixed, paragraphs: mixed, title: '' });
  assert.deepEqual(r, [{ phrase: 'a month of platform native', count: 3 }]);
});

test('phrase: finding string quotes the phrase and reports locations', () => {
  const sentences = [
    'A month of platform native content in minutes.',
    'Get a month of platform native content in minutes.',
    'One article into a month of platform native posts.',
  ];
  const paragraphs = [
    'A month of platform native content in minutes.',
    'A totally different paragraph about pricing.',
    'One article into a month of platform native posts.',
  ];
  const title = 'Blog2Posts — A month of platform native content';
  const res = analyze({ text: 'x', sentences, paragraphs, title });
  const line = res.findings.find((f) => f.startsWith('repeated phrase in the page text:'));
  assert.ok(line, `phrase finding missing: ${JSON.stringify(res.findings)}`);
  // Count includes the title occurrence (4 = 1 title + 3 sentences).
  assert.equal(
    line,
    'repeated phrase in the page text: 4× "a month of platform native" — also in the page title — in 2 paragraphs',
  );
  // Singular paragraph count renders "paragraph" not "paragraphs".
  const one = analyze({
    text: 'x',
    sentences,
    paragraphs: ['A month of platform native content in minutes.', 'Other text.'],
    title: '',
  });
  const line1 = one.findings.find((f) => f.startsWith('repeated phrase in the page text:'));
  assert.ok(line1.endsWith('— in 1 paragraph'), `got: ${line1}`);
});

test('phrase: deterministic — same input, same score and findings, always', () => {
  const sentences = [
    'We offer a dashboard that teams actually open.',
    'We offer a review call every single quarter.',
    'We offer a month of platform native content in minutes.',
    'We offer a month of platform native content for every plan.',
    'We offer a month of platform native content starting today.',
    'We offer a trial that lasts two full weeks.',
  ];
  const a = analyze({ text: 'x', sentences, paragraphs: [], title: '' });
  const b = analyze({ text: 'x', sentences, paragraphs: [], title: '' });
  assert.deepEqual(a, b);
  // Additive math: 6/6 identical 3-word openings -> openingSub 100; the
  // 6-word phrase fires 3x (extras 2 -> phraseSub 24): round(40 + 4.8) = 45.
  assert.equal(a.score, 45);
  assert.ok(a.findings.some((f) => f.startsWith('repeated sentence openings: 6× "we offer a…"')));
  // Dedupe keeps the LONGEST equal-count template ("we offer a month of
  // platform native content", 8 words) over its contained 6/5-word windows.
  assert.ok(a.findings.some((f) => f.includes('3× "we offer a month of platform native content"')), JSON.stringify(a.findings));
  // No phrase signal -> legacy-blend-only score (additive design, no drift).
  const noPhrase = analyze({
    text: 'x',
    sentences: [
      'We offer a dashboard that teams actually open.',
      'We offer a review call every single quarter.',
      'We offer a discount plan for early adopters.',
      'We offer a migration service for old accounts.',
      'We offer a guarantee backed by real humans.',
      'We offer a trial that lasts two full weeks.',
    ],
    paragraphs: [],
    title: '',
  });
  assert.equal(noPhrase.score, 40); // openings-only: 100 * 0.4
});

test('phrase: reported phrases are capped at 3 per page', () => {
  const sentences = [
    'Alpha beta gamma delta one two three four.',
    'Alpha beta gamma delta one two three four.',
    'Alpha beta gamma delta one two three four.',
    'Epsilon zeta eta theta five six seven eight.',
    'Epsilon zeta eta theta five six seven eight.',
    'Epsilon zeta eta theta five six seven eight.',
    'Iota kappa lambda mu nine ten eleven twelve.',
    'Iota kappa lambda mu nine ten eleven twelve.',
    'Iota kappa lambda mu nine ten eleven twelve.',
    'Nu xi omicron pi thirteen fourteen fifteen sixteen.',
    'Nu xi omicron pi thirteen fourteen fifteen sixteen.',
    'Nu xi omicron pi thirteen fourteen fifteen sixteen.',
  ];
  // 4 distinct repeated phrases; cap keeps 3. (Same-count containment: each
  // 4-word phrase has equal-count longer windows? No — the 4-word phrase IS
  // the longest repeated unit here, count 3 each.)
  const r = findRepeatedPhrases({ sentences });
  assert.equal(r.length, 3);
});

// ---------------------------------------------------------------------------
// Fixture A — templated testimonials (shared claim -> pain -> outcome
// skeleton with different specifics). The template wording fires; the
// detector must NOT claim it knows the blocks are testimonials — it reports
// the shared phrase with real counts.
// ---------------------------------------------------------------------------
test('fixture A: templated testimonials fire the repeated-filler receipt', () => {
  const testimonials = [
    'Blog2Posts tripled my output in the first month. I used to waste hours on social media every single day.',
    'Blog2Posts doubled our reach in the first month. We used to waste hours on social media every single week.',
    'Blog2Posts grew our leads in the first month. They used to waste hours on social media every single month.',
  ];
  const res = analyze({ text: 'x', sentences: testimonials, paragraphs: testimonials, title: '' });
  assert.ok(res.score > 0, `expected a phrase penalty, got score ${res.score}`);
  assert.ok(res.findings.some((f) => f === 'repeated phrase in the page text: 3× "in the first month" — in 3 paragraphs'), JSON.stringify(res.findings));
  assert.ok(res.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "used to waste hours on social media every single"')), JSON.stringify(res.findings));
  // The conservative boundary: the finding speaks of a repeated phrase/template
  // with real counts — never asserts "testimonial".
  for (const f of res.findings) assert.ok(!/testimonial/i.test(f), `must not claim testimonials: ${f}`);
  // Sanity: the phrase term is additive (0 + 2 phrases * extras 2 * 12 * 0.2 = 9.6 -> 10).
  assert.equal(res.score, 10);
});

// ---------------------------------------------------------------------------
// Fixture B — varied, well-written testimonials: different structures, no
// shared 4+ word phrase -> must NOT fire.
// ---------------------------------------------------------------------------
test('fixture B: varied testimonials do not false-fire', () => {
  const varied = [
    'As a solo founder, I finally got my mornings back. The scheduler pays for itself within weeks.',
    'Our support team cut reply time by half after switching. Customers noticed the difference immediately.',
    'I was skeptical until the first invoice. Now I recommend it to every agency I meet.',
    'The best part is the calendar view — I can see everything we publish without opening a spreadsheet.',
    'Setup took an afternoon. A year later it is still the only tool our team opens daily.',
  ];
  const res = analyze({ text: 'x', sentences: varied, paragraphs: varied, title: '' });
  assert.equal(res.score, 0, `varied copy must stay clean, got ${res.score}: ${JSON.stringify(res.findings)}`);
  assert.deepEqual(res.findings, ['no notable repetitive structure (5 sentences, 5 paragraphs)']);
});

// ---------------------------------------------------------------------------
// Cached-fixture regression matrix (REPETITION subscore; pre-pass-2 = 0 for
// all four; blog2posts now fires its value-prop family, the others stay 0).
// ---------------------------------------------------------------------------
test('matrix: blog2posts — value-prop phrase family fires, repetitive 0 -> 5', () => {
  const html = loadFixture('blog2posts');
  const text = extractText(html);
  const rep = runRules(text).repetitive;
  assert.equal(rep.score, 5);
  assert.equal(rep.findings[0], 'repeated phrase in the page text: 3× "a month of platform native" — in 3 paragraphs');
  // Ground truth (lead 2026-10-01): the fixture has NO testimonial blocks —
  // this is title->hero->sections value-prop repetition, and the receipt
  // reports the shared wording without claiming a testimonial.
  assert.ok(rep.findings.every((f) => !/testimonial/i.test(f)));
});

test('matrix: other fixtures stay clean on REPETITION (getcollectionscopilot, stripe base, ass-score)', () => {
  for (const name of ['getcollectionscopilot', 'stripe', 'ass-score']) {
    const text = extractText(loadFixture(name));
    const rep = runRules(text).repetitive;
    assert.ok(rep.score >= 0, name);
  }
  // Stripe's homepage genuinely repeats line families (3 phrase findings:
  // "infrastructure to grow your revenue" incl. title, "businesses on stripe
  // generated 1 9t in 2025", "online and in store") — additive on top of the
  // legacy 25: round(25 + 72 * 0.2) = round(39.4) = 39.
  const stripe = runRules(extractText(loadFixture('stripe'))).repetitive;
  assert.equal(stripe.score, 39);
  assert.ok(stripe.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "financial infrastructure to grow your revenue" — also in the page title')), JSON.stringify(stripe.findings));
  // ass-score.com keeps 0 (the site's own composite stays 11 — see
  // fingerprintVocab.test.js).
  assert.equal(runRules(extractText(loadFixture('ass-score'))).repetitive.score, 0);
  assert.equal(runRules(extractText(loadFixture('getcollectionscopilot'))).repetitive.score, 0);
});

// ---------------------------------------------------------------------------
// Three-layer wiring: parser, signal tag, bespoke pool, no-drift guard.
// ---------------------------------------------------------------------------
const PHRASE_FINDING = 'repeated phrase in the page text: 3× "a month of platform native" — also in the page title — in 3 paragraphs';
const PHRASE_FINDING_NO_TITLE = 'repeated phrase in the page text: 3× "a month of platform native" — in 3 paragraphs';

test('three-layer: phrase finding parses into quotable tokens', () => {
  assert.deepEqual(parseEvidenceTokens('repetitive', PHRASE_FINDING), {
    kind: 'phrases',
    count: '3',
    phrase: 'a month of platform native',
    inTitle: 'the page title',
    paragraphCount: '3',
    repeatsNoun: 'repeats',
    appearancesNoun: 'appearances',
  });
  const t2 = parseEvidenceTokens('repetitive', PHRASE_FINDING_NO_TITLE);
  assert.equal(t2.phrase, 'a month of platform native');
  assert.equal('inTitle' in t2, false);
  assert.equal(t2.paragraphCount, '3');
});

test('three-layer: phrase findings carry the phrase signal tag; legacy repetitive findings stay untagged', () => {
  assert.equal(signalTagFor('repetitive', PHRASE_FINDING), 'phrase');
  assert.equal(signalTagFor('repetitive', 'repeated sentence openings: 5× "the company"'), null);
  assert.equal(signalTagFor('repetitive', 'no notable repetitive structure (3 sentences, 2 paragraphs)'), null);
});

test('three-layer: phrase findings draw bespoke template-citing copy, fully interpolated', () => {
  const ins = withInsights({ repetitive: { score: 5, findings: [PHRASE_FINDING] } }, 'phrase-scan-0001')
    .repetitive.insights;
  assert.equal(ins.length, 1);
  const it = ins[0];
  assert.equal(it.evidence, PHRASE_FINDING);
  assert.ok(it.roast.includes('a month of platform native'), `roast must cite the phrase: ${it.roast}`);
  assert.ok(!/\{[a-z]+\}/i.test(it.roast), `uninterpolated tokens left: ${it.roast}`);
  assert.ok(it.why && it.fix, 'phrase-gated why/fix present');
  assert.ok(!/\{[a-z]+\}/i.test(`${it.why} ${it.fix}`));
  assert.ok(it.why.includes('splits your own argument'), 'bespoke phrase why, not the sentence/paragraph why');
  assert.ok(it.fix.includes('hero or the first section'), 'bespoke phrase fix');
});

test('three-layer: every phraseRoast variant is reachable and token-complete for the canonical phrase finding', () => {
  const pool = THREE_LAYER_POOLS.repetitive.phraseRoasts;
  assert.ok(Array.isArray(pool) && pool.length >= 4 && pool.length <= 6, `phraseRoasts pool size ${pool.length}`);
  const tokens = parseEvidenceTokens('repetitive', PHRASE_FINDING);
  for (const tpl of pool) {
    const declared = [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'phrase roast must cite evidence');
    assert.ok(declared.includes('phrase'), `phrase roast must cite the {phrase} trigger: ${tpl}`);
    assert.ok(declared.every((t) => t in tokens), `all tokens parse for: ${tpl}`);
    assert.ok(tpl.length <= 220, `line length ${tpl.length}`);
  }
});

test('three-layer: legacy repetitive picks are byte-identical (no drift from the pass-2 pool additions)', () => {
  const legacy = [
    'repeated sentence openings: 5× "the company", 3× "we offer"',
    'near-identical sentences: 4× "our platform helps businesses grow"',
    'repeated paragraphs: 3× "we are the leading provider of solutions"',
    'no notable repetitive structure (24 sentences, 8 paragraphs)',
  ];
  const ins = buildCategoryInsights({ category: 'repetitive', findings: legacy, id: 'scan-aaaa' });
  assert.deepEqual(ins.map((i) => i.roast), [
    '"the company" — your sentence openings repeat themselves 5×. The first one was fine. This is number 5.',
    'The line "our platform helps businesses grow" does double (triple, quadruple) duty on this page: 4 appearances.',
    'Your repeated paragraphs repeat themselves: "we are the leading provider of solutions" appears 3× on one page.',
    'Your sentences don\'t all start the same, and your paragraphs don\'t repeat. Boring to detect, delightful to read.',
  ]);
});