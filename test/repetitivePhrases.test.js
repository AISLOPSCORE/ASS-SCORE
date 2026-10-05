/**
 * Pass 2 (owner-approved 2026-10-01): in-page repeated-phrase detection —
 * corrected category attribution (lead review 2026-10-01, PR #11 revision).
 *
 * The owner's REPETITION category is the internal crossPage rule
 * (src/categories.js: crossPage->REPETITION is the ONLY display-label table);
 * the STRUCTURE category is internal repetitive. The in-page phrase detector
 * therefore lives in src/rules/crossPage.js and feeds crossPage's score AND
 * findings — the REPETITION card performs exactly what its new description
 * claims. src/rules/repetitive.js is byte-identical to main (three legacy
 * signals only; no phrase term).
 *
 * Coverage here:
 *   - unit behavior of findRepeatedPhrases (thresholds, hyphen unification,
 *     quoting/location, determinism, cap);
 *   - crossPage single-page semantics: phrase signal fires on 1-page scans,
 *     null only when there is genuinely nothing to measure; the scorer's
 *     crossPage 0.30 weight then applies (flagged consequence);
 *   - repetitive.js restore pin: export surface = exactly { analyze }, legacy
 *     signals word-for-word, guard contract intact;
 *   - fixture matrix with HONEST internal-rule labels (crossPage = REPETITION,
 *     repetitive = STRUCTURE) — blog2posts crossPage 0->5, repetitive 0->0;
 *   - no-drift assertions: ass-score composite stays 11, cc unchanged,
 *     byte-identical repetitive for no-phrase pages;
 *   - three-layer wiring on the crossPage path: evidence parser, 'phrase'
 *     signal tag, bespoke phraseRoasts pool, legacy-picks no-drift guard.
 * No live fetches — fixtures only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repetitive from '../src/rules/repetitive.js';
import * as crossPage from '../src/rules/crossPage.js';
import { analyzeCrossPage, findRepeatedPhrases } from '../src/rules/crossPage.js';
import { runRules } from '../src/rules/index.js';
import { extractText } from '../src/text.js';
import { loadFixture, fixtureBreakdown } from './fixtures/helpers.js';
import { computeSlopScore } from '../src/scorer.js';
import {
  parseEvidenceTokens,
  signalTagFor,
  withInsights,
  buildCategoryInsights,
  THREE_LAYER_POOLS,
} from '../src/threeLayer.js';

/** Single-page analyzeCrossPage helper (fixture text -> rule input). */
function singlePage(htmlOrCtx) {
  if (typeof htmlOrCtx === 'string') {
    const text = extractText(htmlOrCtx);
    return analyzeCrossPage({
      pages: [{ url: 'https://x/', main: { words: text.words }, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title }],
    });
  }
  return analyzeCrossPage({ pages: [htmlOrCtx] });
}

// ---------------------------------------------------------------------------
// Restore pin — src/rules/repetitive.js is byte-identical in BEHAVIOR to main
// (the actual file was restored byte-for-byte; this pins the export surface
// and legacy behavior so a future pass cannot revive the phrase term there).
// ---------------------------------------------------------------------------
test('restore: repetitive.js exposes ONLY analyze (phrase detector left the module)', () => {
  assert.deepEqual(Object.keys(repetitive), ['analyze'], 'no findRepeatedPhrases export may return to repetitive.js');
});

test('restore: legacy repetitive guard contract { score: 0, findings: [] } for degenerate inputs', () => {
  assert.deepEqual(repetitive.analyze(), { score: 0, findings: [] });
  assert.deepEqual(repetitive.analyze({}), { score: 0, findings: [] });
  assert.deepEqual(repetitive.analyze({ text: '' }), { score: 0, findings: [] });
  // Text with no sentence split is degenerate (original `!text || sentences.length === 0`).
  assert.deepEqual(repetitive.analyze({ text: 'some text', sentences: [] }), { score: 0, findings: [] });
  // Title alone must NOT revive a degenerate page.
  assert.deepEqual(repetitive.analyze({ text: '', title: 'A page title', sentences: [], paragraphs: [] }), { score: 0, findings: [] });
  const ok = repetitive.analyze({ text: 'one two three four', sentences: ['One two three four.'], title: 't' });
  assert.ok(ok.score === 0 && Array.isArray(ok.findings));
});

test('restore: legacy signals + fallback line word-for-word (no phrase receipts under STRUCTURE)', () => {
  const sentences = [
    'We offer a dashboard that teams actually open.',
    'We offer a review call every single quarter.',
    'We offer a month of platform native content in minutes.',
    'We offer a month of platform native content for every plan.',
    'We offer a month of platform native content starting today.',
    'We offer a trial that lasts two full weeks.',
  ];
  const res = repetitive.analyze({ text: 'x', sentences, paragraphs: [], title: '' });
  // Openings-only: 100 * 0.4 = 40. No phrase term, no paragraph signal.
  assert.equal(res.score, 40);
  assert.ok(res.findings[0].startsWith('repeated sentence openings: 6× "we offer a…"'));
  assert.equal(res.findings.some((f) => f.startsWith('repeated phrase in the page text:')), false);
  const clean = repetitive.analyze({ text: 'x', sentences: ['One two three four.', 'Five six seven eight.'], paragraphs: ['One two three four.', 'Five six seven eight.'], title: '' });
  assert.deepEqual(clean.findings, ['no notable repetitive structure (2 sentences, 2 paragraphs)']);
});

// ---------------------------------------------------------------------------
// Unit behavior of findRepeatedPhrases (now exported by crossPage.js)
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

// ---------------------------------------------------------------------------
// Single-page crossPage semantics (REPETITION card)
// ---------------------------------------------------------------------------
test('crossPage: phrase finding quotes the phrase and reports locations', () => {
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
  const res = singlePage({ url: 'https://x/', main: { words: [] }, sentences, paragraphs, title });
  const line = res.findings.find((f) => f.startsWith('repeated phrase in the page text:'));
  assert.ok(line, `phrase finding missing: ${JSON.stringify(res.findings)}`);
  // Count includes the title occurrence (4 = 1 title + 3 sentences).
  assert.equal(
    line,
    'repeated phrase in the page text: 4× "a month of platform native" — also in the page title — in 2 paragraphs',
  );
  // Singular paragraph count renders "paragraph" not "paragraphs".
  const one = singlePage({ url: 'https://x/', main: { words: [] }, sentences, paragraphs: ['A month of platform native content in minutes.', 'Other text.'], title: '' });
  const line1 = one.findings.find((f) => f.startsWith('repeated phrase in the page text:'));
  assert.ok(line1.endsWith('— in 1 paragraph'), `got: ${line1}`);
});

test('crossPage: deterministic — same input, same score and findings, always', () => {
  const sentences = [
    'We offer a dashboard that teams actually open.',
    'We offer a review call every single quarter.',
    'We offer a month of platform native content in minutes.',
    'We offer a month of platform native content for every plan.',
    'We offer a month of platform native content starting today.',
    'We offer a trial that lasts two full weeks.',
  ];
  const ctx = { url: 'https://x/', main: { words: [] }, sentences, paragraphs: [], title: '' };
  const a = analyzeCrossPage({ pages: [ctx] });
  const b = analyzeCrossPage({ pages: [ctx] });
  assert.deepEqual(a, b);
  // The 8-word template fires 3x (extras 2 -> phraseSub 24 -> *0.2 = 4.8).
  assert.equal(a.score, 5);
  assert.equal(a.note, 'single-page scan: in-page repeated-phrase check only (no cross-page comparison possible)');
  assert.ok(a.findings.some((f) => f.includes('3× "we offer a month of platform native content"')), JSON.stringify(a.findings));
});

test('crossPage: reported phrases are capped at 3 per page', () => {
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
  const r = findRepeatedPhrases({ sentences });
  assert.equal(r.length, 3);
});

// ---------------------------------------------------------------------------
// Fixture A — templated testimonials (shared skeleton, different specifics).
// The template wording fires; the detector reports the shared phrase with real
// counts, never asserting "testimonial".
// ---------------------------------------------------------------------------
const TESTIMONIALS = [
  'Blog2Posts tripled my output in the first month. I used to waste hours on social media every single day.',
  'Blog2Posts doubled our reach in the first month. We used to waste hours on social media every single week.',
  'Blog2Posts grew our leads in the first month. They used to waste hours on social media every single month.',
];

test('fixture A: templated testimonials fire the repeated-phrase receipt under crossPage (REPETITION)', () => {
  const res = singlePage({ url: 'https://x/', main: { words: [] }, sentences: TESTIMONIALS, paragraphs: TESTIMONIALS, title: '' });
  assert.ok(res.score > 0, `expected a phrase penalty, got score ${res.score}`);
  assert.ok(res.findings.some((f) => f === 'repeated phrase in the page text: 3× "in the first month" — in 3 paragraphs'), JSON.stringify(res.findings));
  assert.ok(res.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "used to waste hours on social media every single"')), JSON.stringify(res.findings));
  // The conservative boundary: never asserts "testimonial".
  for (const f of res.findings) assert.ok(!/testimonial/i.test(f), `must not claim testimonials: ${f}`);
  // Sanity: 2 phrases * extras 2 * 12 * 0.2 = 9.6 -> 10 (pairwise 0 on 1 page).
  assert.equal(res.score, 10);
});

test('fixture A as HTML: the phrase signal fires on a REAL single-page scan under REPETITION', () => {
  const html = `<!doctype html><html><head><title>Blog2Posts — love</title></head><body>
    <main>
      <blockquote>${TESTIMONIALS[0]}</blockquote>
      <blockquote>${TESTIMONIALS[1]}</blockquote>
      <blockquote>${TESTIMONIALS[2]}</blockquote>
    </main>
  </body></html>`;
  const text = extractText(html);
  const res = analyzeCrossPage({
    pages: [{ url: 'https://x/', main: { words: text.words }, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title }],
  });
  assert.equal(res.score, 10, JSON.stringify(res));
  assert.ok(res.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "in the first month" — in 3 paragraphs')));
  // STRUCTURE (repetitive) on the same page stays legacy-clean (0): the
  // phrase signal does NOT live there anymore.
  const rep = runRules(text).repetitive;
  assert.equal(rep.score, 0);
  assert.equal(rep.findings.some((f) => f.startsWith('repeated phrase in the page text:')), false);
  // FLAGGED SCORING CONSEQUENCE: the single-page scan's composite now applies
  // crossPage's 0.30 weight (previously renormalized away on <2-page scans) —
  // this test doubles as the headline one-page-landing case: composite with
  // the phrase signal = round(10 * 0.30) = 3 where a clean 1-page scan = 0.
  const withPhrase = computeSlopScore({
    filler: { score: 0 }, boilerplate: { score: 0 }, infoDensity: { score: 0 },
    repetitive: { score: 0 }, crossPage: { score: 10 }, fingerprints: { score: 0 }, assets: { score: 0 },
  });
  assert.equal(withPhrase.slopScore, 3);
  assert.equal(withPhrase.components.crossPage.weight, 0.3);
  const withoutPhrase = computeSlopScore({
    filler: { score: 0 }, boilerplate: { score: 0 }, infoDensity: { score: 0 },
    repetitive: { score: 0 }, crossPage: { score: null, findings: [], note: 'needs at least 2 pages to compare' },
    fingerprints: { score: 0 }, assets: { score: 0 },
  });
  assert.equal(withoutPhrase.slopScore, 0);
  assert.equal('crossPage' in withoutPhrase.components, false); // skipped: not in the v1 renorm table
});

// ---------------------------------------------------------------------------
// Fixture B — varied, well-written testimonials: no shared 4+ word phrase ->
// must NOT fire (single-page: nothing to measure -> score null).
// ---------------------------------------------------------------------------
test('fixture B: varied testimonials do not false-fire (single-page -> null skip)', () => {
  const varied = [
    'As a solo founder, I finally got my mornings back. The scheduler pays for itself within weeks.',
    'Our support team cut reply time by half after switching. Customers noticed the difference immediately.',
    'I was skeptical until the first invoice. Now I recommend it to every agency I meet.',
    'The best part is the calendar view — I can see everything we publish without opening a spreadsheet.',
    'Setup took an afternoon. A year later it is still the only tool our team opens daily.',
  ];
  const res = singlePage({ url: 'https://x/', main: { words: [] }, sentences: varied, paragraphs: varied, title: '' });
  assert.equal(res.score, null, `varied copy must be skipped (nothing to measure), got ${JSON.stringify(res)}`);
  assert.equal(res.note, 'needs at least 2 pages to compare');
  // STRUCTURE stays clean through the legacy path.
  const rep = repetitive.analyze({ text: 'x', sentences: varied, paragraphs: varied, title: '' });
  assert.deepEqual(rep.findings, ['no notable repetitive structure (5 sentences, 5 paragraphs)']);
});

// ---------------------------------------------------------------------------
// Cached-fixture matrix with HONEST internal-rule labels: crossPage is the
// display REPETITION card; repetitive is the display STRUCTURE card.
// ---------------------------------------------------------------------------
test('matrix: blog2posts — REPETITION (crossPage) 0 -> 5, STRUCTURE (repetitive) 0 unchanged', () => {
  const html = loadFixture('blog2posts');
  const text = extractText(html);
  // REPETITION card = internal crossPage. The fixture is its target page.
  const cp = analyzeCrossPage({
    pages: [{ url: 'https://blog2posts.com/', main: { words: text.words }, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title }],
  });
  assert.equal(cp.score, 5, JSON.stringify(cp));
  assert.equal(cp.findings[0], 'repeated phrase in the page text: 3× "a month of platform native" — in 3 paragraphs');
  // STRUCTURE card = internal repetitive: UNCHANGED (0; legacy fallback line).
  const rep = runRules(text).repetitive;
  assert.equal(rep.score, 0);
  assert.equal(rep.findings[0], 'no notable repetitive structure (31 sentences, 148 paragraphs)');
  assert.equal(rep.findings.some((f) => f.startsWith('repeated phrase in the page text:')), false);
  // Overall composite: 10 (crossPage=0 proxy — main-equivalent) -> 12 (real
  // crossPage=5: +1.5 at weight 0.30). Round-1 DESIGN signals (2026-10-05)
  // raised DESIGN 10 -> 20 (+1.0 at weight 0.10), so both pins moved by +1 vs
  // the pre-round-1 suite (9 -> 10, 11 -> 12), matching the spec's live
  // prediction 11 -> 12 (raw 10.6 -> 11.6). Flagged consequence, owner-aware.
  assert.equal(fixtureBreakdown('blog2posts', 0).composite, 10);
  assert.equal(fixtureBreakdown('blog2posts', 5).composite, 12);
});

test('matrix: stripe — REPETITION (crossPage) fires 3 phrase receipts; STRUCTURE (repetitive) back to legacy 25', () => {
  const text = extractText(loadFixture('stripe'));
  const cp = analyzeCrossPage({
    pages: [{ url: 'https://stripe.com/', main: { words: text.words }, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title }],
  });
  assert.equal(cp.score, 14);
  assert.ok(cp.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "financial infrastructure to grow your revenue" — also in the page title')), JSON.stringify(cp.findings));
  assert.ok(cp.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "businesses on stripe generated 1 9t in 2025"')), JSON.stringify(cp.findings));
  assert.ok(cp.findings.some((f) => f.startsWith('repeated phrase in the page text: 3× "online and in store"')), JSON.stringify(cp.findings));
  // STRUCTURE: legacy signals only (25), no phrase receipts.
  const rep = runRules(text).repetitive;
  assert.equal(rep.score, 25);
  assert.equal(rep.findings.some((f) => f.startsWith('repeated phrase in the page text:')), false);
});

test('matrix: no-false-fire fixtures stay unchanged (getcollectionscopilot, ass-score)', () => {
  for (const name of ['getcollectionscopilot', 'ass-score']) {
    const text = extractText(loadFixture(name));
    // STRUCTURE: 0, legacy fallback, no phrase receipts.
    const rep = runRules(text).repetitive;
    assert.equal(rep.score, 0, name);
    assert.equal(rep.findings.some((f) => f.startsWith('repeated phrase in the page text:')), false);
    // REPETITION: single-page, nothing to measure -> null skip (v1 renormalized).
    const cp = singlePage({ url: `https://${name}.com/`, main: { words: text.words }, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title });
    assert.equal(cp.score, null, name);
  }
  // No-drift composites: ass-score stays 11 (fingerprintVocab pins the full
  // breakdown); cc's fingerprints stay 0 (pinned there).
  assert.equal(fixtureBreakdown('ass-score', 0).composite, 11);
});

// ---------------------------------------------------------------------------
// Three-layer wiring on the crossPage path (parser, tag, bespoke pool,
// legacy no-drift).
// ---------------------------------------------------------------------------
const PHRASE_FINDING = 'repeated phrase in the page text: 3× "a month of platform native" — also in the page title — in 3 paragraphs';
const PHRASE_FINDING_NO_TITLE = 'repeated phrase in the page text: 3× "a month of platform native" — in 3 paragraphs';

test('three-layer: phrase finding parses into quotable tokens under crossPage (and NOT under repetitive)', () => {
  assert.deepEqual(parseEvidenceTokens('crossPage', PHRASE_FINDING), {
    kind: 'phrases',
    count: '3',
    phrase: 'a month of platform native',
    inTitle: 'the page title',
    paragraphCount: '3',
    repeatsNoun: 'repeats',
    appearancesNoun: 'appearances',
    pairsNoun: 'pairs', // the crossPage count-branch plural noun is synthesized for any count token
  });
  const t2 = parseEvidenceTokens('crossPage', PHRASE_FINDING_NO_TITLE);
  assert.equal(t2.phrase, 'a month of platform native');
  assert.equal('inTitle' in t2, false);
  assert.equal(t2.paragraphCount, '3');
  // The phrase format no longer parses as a repetitive (STRUCTURE) evidence.
  assert.deepEqual(parseEvidenceTokens('repetitive', PHRASE_FINDING), {});
});

test('three-layer: phrase findings carry the phrase signal tag under crossPage; legacy crossPage/repetitive stay untagged', () => {
  assert.equal(signalTagFor('crossPage', PHRASE_FINDING), 'phrase');
  assert.equal(signalTagFor('crossPage', 'near-identical page pair: https://a.example/ ~ https://a.example/about (91.0% similar)'), null);
  assert.equal(signalTagFor('crossPage', 'no two pages are more than 80% the same (3 pages compared)'), null);
  // repetitive (STRUCTURE) never carries the phrase tag anymore.
  assert.equal(signalTagFor('repetitive', PHRASE_FINDING), null);
  assert.equal(signalTagFor('repetitive', 'repeated sentence openings: 5× "the company"'), null);
  assert.equal(signalTagFor('repetitive', 'no notable repetitive structure (3 sentences, 2 paragraphs)'), null);
});

test('three-layer: phrase findings draw bespoke template-citing copy, fully interpolated', () => {
  const ins = withInsights({ crossPage: { score: 5, findings: [PHRASE_FINDING] } }, 'phrase-scan-0001')
    .crossPage.insights;
  assert.equal(ins.length, 1);
  const it = ins[0];
  assert.equal(it.evidence, PHRASE_FINDING);
  assert.ok(it.roast.includes('a month of platform native'), `roast must cite the phrase: ${it.roast}`);
  assert.ok(!/\{[a-z]+\}/i.test(it.roast), `uninterpolated tokens left: ${it.roast}`);
  assert.ok(it.why && it.fix, 'phrase-gated why/fix present');
  assert.ok(!/\{[a-z]+\}/i.test(`${it.why} ${it.fix}`));
  assert.ok(it.why.includes('splits your own argument'), 'bespoke phrase why, not the pairwise why');
  assert.ok(it.fix.includes('hero or the first section'), 'bespoke phrase fix');
});

test('three-layer: every phraseRoast variant in the crossPage pool is reachable and token-complete', () => {
  const pool = THREE_LAYER_POOLS.crossPage.phraseRoasts;
  assert.ok(Array.isArray(pool) && pool.length >= 4 && pool.length <= 6, `phraseRoasts pool size ${pool.length}`);
  const tokens = parseEvidenceTokens('crossPage', PHRASE_FINDING);
  for (const tpl of pool) {
    const declared = [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'phrase roast must cite evidence');
    assert.ok(declared.includes('phrase'), `phrase roast must cite the {phrase} trigger: ${tpl}`);
    assert.ok(declared.every((t) => t in tokens), `all tokens parse for: ${tpl}`);
    assert.ok(tpl.length <= 220, `line length ${tpl.length}`);
  }
  // The pool lives ONLY under crossPage (the REPETITION card); the repetitive
  // (STRUCTURE) group's phraseRoasts key stays EMPTY (the shared pool reader
  // maps the key for every category).
  assert.equal(THREE_LAYER_POOLS.repetitive.phraseRoasts.length, 0);
});

test('three-layer: legacy repetitive picks are byte-identical (no drift from the pool moves)', () => {
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

test('three-layer: legacy crossPage picks are byte-identical (phraseRoasts stayed OUT of the generic roasts array)', () => {
  const legacyPair = 'near-identical page pair: https://a.example/ ~ https://a.example/about (91.0% similar)';
  const ins = buildCategoryInsights({ category: 'crossPage', findings: [legacyPair], id: 'scan-bbbb' });
  assert.equal(ins.length, 1);
  assert.ok(ins[0].roast.includes('https://a.example/'), `must cite the URL trigger: ${ins[0].roast}`);
  assert.ok(!/\{[a-z]+\}/i.test(ins[0].roast));
  assert.ok(ins[0].why && ins[0].fix && !/\{[a-z]+\}/i.test(`${ins[0].why} ${ins[0].fix}`));
  // Byte-pinned: this exact roast/why/fix for this exact seed (frozen when the
  // pool gained phraseRoasts + tagged entries — the generic arrays were not
  // shifted and the tagged entries are ineligible for untagged findings, so
  // the deterministic picks cannot drift).
  assert.equal(ins[0].roast, 'https://a.example/about is basically https://a.example/ wearing a different hat: 91.0% identical.');
  assert.equal(ins[0].why, 'A real site is a set of answers to different questions; when all your pages answer the same question, visitors with any other question find nothing new.');
  assert.equal(ins[0].fix, 'Give each page one job, and rewrite the main content so only that page says it.');
});