import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCategoryInsights,
  entryText,
  entryTriggers,
  eligibleVariants,
  selectEligible,
  signalTagFor,
  THREE_LAYER_KEYS,
} from '../src/threeLayer.js';

/**
 * CONTENT-INTEGRITY TESTS (owner Option 1 — token/trigger gating for why/fix).
 *
 * Regression target (the bug): threeLayer.js picked why/fix lines from
 * category-wide pools seeded only by hash(scanId:category:index) — content-
 * blind position roulette. A "privacy policy" finding could land the
 * learn-more fix and a "vague sentence" finding could land cookie/legal copy.
 *
 * The fix: a why/fix entry may carry OPTIONAL signal "triggers"
 * (object { text, triggers } in threeLayer.json). A tagged entry is eligible
 * ONLY for findings whose signalTagFor(category, evidence) is one of its
 * triggers; plain-string entries are untagged and eligible everywhere (they
 * must stay signal-agnostic — denylist test below). When nothing is eligible
 * for a layer, the layer is omitted — never drawn from an ineligible pool.
 *
 * Owner requirement 6(b): an untagged line must never address one specific
 * problem (encoded in the static denylist audit).
 */

const DATA = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/threeLayer.json', import.meta.url)), 'utf8'));

/** Raw why/fix entries for a category (strings AND {text, triggers} objects). */
const entriesOf = (cat, kind) => DATA.pools[cat][kind] ?? [];

/** The trigger-gated copy fragments we must never misassign (substring match). */
const LEARN_MORE_FIX = 'Replace "learn more" links with labels';
const FACT_CHECK_FIX = 'every sentence gets a fact check';
const LEGAL_COOKIE_FIX = 'Keep legal and cookie text';

// --- representative EVIDENCE FORMATS per rule module -----------------------
// (byte-for-byte shapes the detectors really emit, per EVIDENCE_PARSERS +
// src/rules/boilerplate.js SIGNALS + src/rules/assets.js)
const BOILERPLATE_EVIDENCE = [
  ['1 generic wording match in 18 words (16.7 per 300 words)', null],
  ['29 generic wording matches in 936 words (9.3 per 300 words)', null],
  ['2× repeated block: "our platform is the best in class"', 'repeated'],
  ['vague sentence: "We aim to empower your journey."', 'marketing'],
  ['hedge evidence: "We aim to empower your journey."', 'marketing'],
  ['3× vague phrase "state-of-the-art"', 'marketing'],
  ['1× hedge phrase "we aim to"', 'marketing'],
  ['2× generic \u201Clearn more\u201D link', 'learn-more'],
  ['1× generic \u201Ccontact us\u201D link', 'cta'],
  ['2× privacy policy', 'legal'],
  ['1× cookie banner', 'legal'],
  ['1× cookie settings', 'legal'],
  ['1× consent manager', 'legal'],
  ['1× terms of service', 'legal'],
  ['1× copyright notice', 'legal'],
  ['1× copyright line', 'legal'],
  ['1× unsubscribe link', 'legal'],
  ['1× lorem ipsum placeholder', 'template'],
  ['1× placeholder text', 'template'],
  ['1× powered-by line', 'template'],
  ['1× newsletter subscribe block', 'cta'],
  ['1× newsletter signup', 'cta'],
  ['1× social-follow block', 'cta'],
  ['1× comment form text', 'cta'],
  ['1× generic commitment claim', 'marketing'],
  ['1× generic mission statement', 'marketing'],
  ['1× marketing adjective', 'marketing'],
  ['1× marketing superlative', 'marketing'],
  ['1× marketing cliché', 'marketing'],
  ['1× generic corporate claim', 'marketing'],
  ['3× made-up-label-nowhere-in-signals', null], // unknown label -> null, never guessed
];

const ASSETS_EVIDENCE = [
  ['3 of 10 images come from stock photo sites', 'stock'],
  ['2 of 4 images from stock/placeholder CDNs', 'stock'],
  ['4 of 10 images look generic or placeholder', 'stock'],
  ['1 of 10 images flagged for stock/placeholder signals', 'stock'],
  ['2 of 10 images with placeholder/generic filenames', 'filenames'],
  ['5 of 10 images with missing or generic alt text', 'alt'],
  ['img[0] stock photo host «unsplash.com» (https://images.unsplash.com/photo-1)', 'stock'],
  ['img[1] stock/placeholder CDN «pexels.com» (https://images.pexels.com/x.jpg)', 'stock'],
  ['img[2] generic filename "logo" (https://cdn.example.com/logo.png)', 'filenames'],
  ['img[3] missing alt text', 'alt'],
  ['img[4] empty alt attribute', 'alt'],
  ['img[5] generic alt "image"', 'alt'],
];

// --- (a) Mismatched-assignment sweep ----------------------------------------
test('content-integrity: for EVERY representative evidence format, every assigned why/fix is eligible for the finding\'s signal tag (ids 0..30)', () => {
  for (const [cat, cases] of [['boilerplate', BOILERPLATE_EVIDENCE], ['assets', ASSETS_EVIDENCE]]) {
    for (const [evidence, tag] of cases) {
      assert.equal(signalTagFor(cat, evidence), tag, `${cat}: "${evidence.slice(0, 50)}" -> ${tag}`);
      const whyPool = entriesOf(cat, 'whys');
      const fixPool = entriesOf(cat, 'fixes');
      for (let id = 0; id < 31; id += 1) {
        const [ins] = buildCategoryInsights({ category: cat, findings: [evidence], id: `sweep-${id}` });
        assert.ok(ins, `${cat}/${evidence.slice(0, 40)}… (id sweep-${id}) insight exists`);
        assert.ok(ins.roast, 'roast layer present');
        if ('why' in ins) {
          assert.ok(eligibleVariants(whyPool, tag).includes(ins.why),
            `${cat}/${evidence.slice(0, 40)}… (id sweep-${id}): why "${ins.why.slice(0, 60)}…" NOT eligible for tag ${tag}`);
        }
        if ('fix' in ins) {
          assert.ok(eligibleVariants(fixPool, tag).includes(ins.fix),
            `${cat}/${evidence.slice(0, 40)}… (id sweep-${id}): fix "${ins.fix.slice(0, 60)}…" NOT eligible for tag ${tag}`);
        }
      }
    }
  }
});

// --- (b) Owner-mandated known cases ------------------------------------------
test('content-integrity: owner-mandated known cases — negative AND positive assertions', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `known-${i}`);

  // "2× privacy policy": the learn-more fix must NEVER be assigned.
  for (const id of ids) {
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: ['2× privacy policy'], id });
    assert.ok(!ins.fix.includes(LEARN_MORE_FIX), `privacy policy (${id}) got the learn-more fix: "${ins.fix}"`);
  }

  // "1× cookie banner": the learn-more fix must NEVER be assigned.
  for (const id of ids) {
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: ['1× cookie banner'], id });
    assert.ok(!ins.fix.includes(LEARN_MORE_FIX), `cookie banner (${id}) got the learn-more fix: "${ins.fix}"`);
  }

  // "1× generic “learn more” link": NEVER the fact-check fix NOR the
  // legal/cookie fix; and the learn-more fix MUST be in its eligible set.
  const lmEvidence = '1× generic \u201Clearn more\u201D link';
  const lmFixEligible = eligibleVariants(entriesOf('boilerplate', 'fixes'), 'learn-more');
  assert.ok(lmFixEligible.some((t) => t.includes(LEARN_MORE_FIX)), 'learn-more fix must be in the learn-more eligible set');
  for (const id of ids) {
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [lmEvidence], id });
    assert.ok(!ins.fix.includes(FACT_CHECK_FIX), `learn-more (${id}) got the fact-check fix: "${ins.fix}"`);
    assert.ok(!ins.fix.includes(LEGAL_COOKIE_FIX), `learn-more (${id}) got the legal/cookie fix: "${ins.fix}"`);
    assert.ok(lmFixEligible.includes(ins.fix), `learn-more (${id}) fix "${ins.fix}" not in the eligible set`);
  }

  // Totals line (no signal): why/fix must come from UNTAGGED generic lines only.
  const totalsEvidence = '1 generic wording match in 18 words (16.7 per 300 words)';
  const untaggedWhys = eligibleVariants(entriesOf('boilerplate', 'whys'), null);
  const untaggedFixes = eligibleVariants(entriesOf('boilerplate', 'fixes'), null);
  assert.ok(untaggedWhys.length >= 1 && untaggedFixes.length >= 1, 'untagged boilerplate fallbacks exist');
  for (const id of ids) {
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [totalsEvidence], id });
    assert.ok(untaggedWhys.includes(ins.why), `totals (${id}): why not from untagged lines: "${ins.why}"`);
    assert.ok(untaggedFixes.includes(ins.fix), `totals (${id}): fix not from untagged lines: "${ins.fix}"`);
  }
});

// --- (c) Static denylist audit (owner requirement 6(b)) ----------------------
// Scope: boilerplate + assets — the two trigger-capable categories this pass
// makes signal-aware. (Other categories are null-tag/untagged-only today, so a
// signal word there can never route to a wrong finding; see the fix report.)
const DENYLIST = [
  'learn more', 'cookie', 'privacy', 'terms of service', 'legal', 'compliance',
  'fact check', 'stock', 'alt text', 'alt attribute', 'filename', 'placeholder',
  'powered by', 'newsletter', 'subscribe', 'lorem ipsum', 'consent', 'unsubscribe',
];

/** Plausible trigger tag(s) that COVER each denylist term, per category. */
const COVER = {
  boilerplate: {
    'learn more': ['learn-more'],
    cookie: ['legal'],
    privacy: ['legal'],
    'terms of service': ['legal'],
    legal: ['legal'],
    compliance: ['legal'],
    'fact check': ['marketing'],
    placeholder: ['template'],
    'lorem ipsum': ['template'],
    'powered by': ['template'],
    newsletter: ['cta'],
    subscribe: ['cta'],
    consent: ['legal'],
    unsubscribe: ['legal'],
    stock: ['stock'],
    'alt text': ['alt'],
    'alt attribute': ['alt'],
    filename: ['filenames'],
  },
  assets: {
    stock: ['stock'],
    placeholder: ['stock', 'filenames'],
    'alt text': ['alt'],
    'alt attribute': ['alt'],
    filename: ['filenames'],
    'learn more': ['learn-more'],
    cookie: ['legal'],
    privacy: ['legal'],
    'terms of service': ['legal'],
    legal: ['legal'],
    compliance: ['legal'],
    'fact check': ['marketing'],
    'powered by': ['template'],
    newsletter: ['cta'],
    subscribe: ['cta'],
    'lorem ipsum': ['template'],
    consent: ['legal'],
    unsubscribe: ['legal'],
  },
};

test('content-integrity: static denylist audit — every matching why/fix entry carries covering triggers; every untagged line is denylist-clean (boilerplate + assets)', () => {
  for (const cat of ['boilerplate', 'assets']) {
    for (const kind of ['whys', 'fixes']) {
      for (const entry of entriesOf(cat, kind)) {
        const text = entryText(entry).toLowerCase();
        const triggers = entryTriggers(entry);
        for (const term of DENYLIST) {
          if (!text.includes(term)) continue;
          const cover = COVER[cat][term] ?? [];
          assert.ok(triggers.length > 0,
            `${cat}.${kind} "${{...entry}}" names denylist term "${term}" but is UNTAGGED — an untagged line must never address one specific problem`);
          assert.ok(triggers.some((t) => cover.includes(t)),
            `${cat}.${kind} "${term}" in "${{...entry}}" must be covered by one of triggers [${triggers.join(', ')}] (allowed: ${cover.join(', ') || 'none'})`);
        }
      }
    }
  }
});

// --- (d) Generic fallback -----------------------------------------------------
test('content-integrity: every category ships at least one untagged why and one untagged fix (generic fallback)', () => {
  for (const cat of THREE_LAYER_KEYS) {
    const untaggedWhys = eligibleVariants(entriesOf(cat, 'whys'), null);
    const untaggedFixes = eligibleVariants(entriesOf(cat, 'fixes'), null);
    assert.ok(untaggedWhys.length >= 1, `${cat}: needs >=1 untagged why (got ${untaggedWhys.length})`);
    assert.ok(untaggedFixes.length >= 1, `${cat}: needs >=1 untagged fix (got ${untaggedFixes.length})`);
  }
});

// --- (e) Determinism -----------------------------------------------------------
test('content-integrity: determinism — same (category, evidence, id) -> identical insight; different ids stay inside the eligible set', () => {
  for (const [cat, cases] of [['boilerplate', BOILERPLATE_EVIDENCE], ['assets', ASSETS_EVIDENCE]]) {
    for (const [evidence, tag] of cases) {
      const a = buildCategoryInsights({ category: cat, findings: [evidence], id: 'det-17' });
      const b = buildCategoryInsights({ category: cat, findings: [evidence], id: 'det-17' });
      assert.deepEqual(a, b, `${cat}/${evidence.slice(0, 40)}… deterministic`);
      assert.equal(signalTagFor(cat, evidence), tag, `${cat}/${evidence.slice(0, 40)}… tag check`);
    }
  }
});

// --- (f) Omit-layer -------------------------------------------------------------
test('content-integrity: omit-layer — a finding with NO eligible line for a layer omits that layer (never an ineligible pick)', () => {
  // Eligibility with a synthetic tag-less pool (only tagged lines, no untagged).
  const taggedOnly = [
    { text: 'stock why', triggers: ['stock'] },
    { text: 'alt why', triggers: ['alt'] },
  ];
  // null signal + no untagged line -> the eligible set is EMPTY.
  assert.deepEqual(eligibleVariants(taggedOnly, null), [], 'null tag sees no untagged line in a tagged-only pool');
  assert.equal(selectEligible(taggedOnly, null, 'seed'), null, 'selectEligible returns null -> layer omitted');
  // matching tag still picks deterministically from the eligible set.
  assert.equal(selectEligible(taggedOnly, 'stock', 'seed'), 'stock why', 'tag-matched line selected');
  assert.equal(selectEligible(taggedOnly, 'alt', 'seed'), 'alt why', 'tag-matched line selected');
  // untagged entry is the universal fallback for any tag (and for null).
  const mixed = [{ text: 'generic', triggers: [] }, { text: 'stock why', triggers: ['stock'] }];
  for (const tag of [null, 'stock', 'alt', 'legal', 'repeated']) {
    assert.ok(eligibleVariants(mixed, tag).includes('generic'), `untagged "generic" eligible for tag ${tag}`);
    assert.ok(eligibleVariants(mixed, tag).includes('stock why') === (tag === 'stock'),
      `tagged "stock why" eligible only for tag stock (got ${tag})`);
  }
  // The identity of the omitted key is absent from the built insight shape
  // (white-box: the builder only ever assigns a present layer).
  const real = buildCategoryInsights({ category: 'boilerplate', findings: ['1 generic wording match in 18 words (16.7 per 300 words)'], id: 'omit-0' })[0];
  assert.equal(typeof real.why, 'string', 'totals finding keeps its untagged why in production');
});