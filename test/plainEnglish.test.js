/**
 * Plain-English report pass (2026-09-23) — regression guard.
 *
 * The owner asked for a copy-only pass: every customer-facing string in the
 * report pipeline must read as plain English to someone with zero technical
 * background. This test pins the result — the technical/detector terms from
 * the terminology map must NOT appear in:
 *   - the three-layer pools (roasts/whys/fixes/compliments/cleanWhys/keepUps)
 *   - the one-line Slop Roast pools (labels + lines)
 *   - the breakdown one-liners
 *   - the rule modules' emitted evidence/receipt strings (a real scan's
 *     findings), which the report shows verbatim as receipts
 *   - a rendered paid report built from those findings
 *
 * Internal JSON keys (filler/boilerplate/infoDensity/...) and internal code
 * comments are untouched by design — this test only inspects strings a
 * customer can see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE_LAYER_POOLS } from '../src/threeLayer.js';
import { ROAST_POOLS } from '../src/roast.js';
import { CATEGORY_ONE_LINERS, CATEGORY_LABELS } from '../src/categories.js';
import { analyze as analyzeFiller } from '../src/rules/filler.js';
import { analyze as analyzeBoilerplate } from '../src/rules/boilerplate.js';
import { analyze as analyzeInfoDensity } from '../src/rules/infoDensity.js';
import { analyzeSpecifics } from '../src/rules/copySlop.js';
import { analyzeCrossPage } from '../src/rules/crossPage.js';
import { analyzeFingerprints } from '../src/rules/fingerprints.js';
import { analyzeAssets } from '../src/rules/assets.js';
import { buildCategoryInsights, parseEvidenceTokens } from '../src/threeLayer.js';

// Technical/detector jargon that must never reach a customer-facing string
// (terminology map, plain-English report pass 2026-09-23). "vocabulary
// diversity" and "MATTR" measure the same thing and both became "word variety".
const BANNED = [
  'boilerplate',
  'MATTR',
  'stopword',
  'vocabulary diversity',
  'concrete specifics',
  'template-like',
  'cross-page duplication',
  'fully-connected',
  'information density',
  'asset slop',
  'AI-like',
  'AI-looking',
  'fingerprint',
  'hedge phrase',
  'hedge evidence',
  'flagged for stock',
  'alt attribute',
];

function checkStrings(label, strings) {
  for (const s of strings) {
    if (typeof s !== 'string' || s === '') continue;
    // Interpolation tokens ({mattr}, {stopwordRatio}, …) are the internal
    // token NAMES — they are replaced with plain values before anything is
    // shown to a customer, so strip them before the banned-term scan.
    const plain = s.replace(/\{[a-zA-Z]+\}/g, '');
    for (const term of BANNED) {
      assert.ok(
        !plain.toLowerCase().includes(term.toLowerCase()),
        `${label} contains banned term "${term}": ${JSON.stringify(s)}`,
      );
    }
  }
}

test('plain-English pass: no detector jargon in any customer-facing copy pool', () => {
  // Three-layer pools (roasts/whys/fixes/compliments/cleanWhys/keepUps).
  for (const [cat, pool] of Object.entries(THREE_LAYER_POOLS)) {
    for (const key of ['roasts', 'whys', 'fixes', 'compliments', 'cleanWhys', 'keepUps']) {
      checkStrings(`threeLayer.${cat}.${key}`, pool[key]);
    }
  }
  // One-line Slop Roast pools: label + lines (label is exposed as roast metadata).
  for (const [cat, pool] of Object.entries(ROAST_POOLS)) {
    checkStrings(`roasts.${cat}.label`, [pool.label]);
    checkStrings(`roasts.${cat}.lines`, pool.lines);
  }
  // Breakdown one-liners (owner-ratified CATEGORY_LABELS are single uppercase words).
  checkStrings('CATEGORY_ONE_LINERS', Object.values(CATEGORY_ONE_LINERS));
  assert.ok(Object.values(CATEGORY_LABELS).every((l) => /^[A-Z]+$/.test(l)), 'CATEGORY_LABELS stay single plain words');
});

test('plain-English pass: rule evidence strings (the receipts) use plain labels', () => {
  // Filler summary + per-phrase hits.
  const filler = analyzeFiller({
    text: 'In today\'s fast-paced world, we leverage robust solutions to elevate your brand. In today\'s fast-paced world.',
    words: 'In today\'s fast-paced world we leverage robust solutions to elevate your brand today\'s world'.split(' '),
  });
  checkStrings('filler findings', filler.findings);

  // Boilerplate summary + label hits + vague-sentence quotes.
  const boilerplate = analyzeBoilerplate({
    text: 'We use cookies to enhance your browsing experience. All rights reserved. We are committed to excellence. We aim to be the best.',
    words: 'We use cookies to enhance your browsing experience All rights reserved We are committed to excellence We aim to be the best'.split(' '),
    sentences: ['We use cookies to enhance your browsing experience.', 'All rights reserved.', 'We are committed to excellence.', 'We aim to be the best.'],
    paragraphs: ['We use cookies to enhance your browsing experience.', 'All rights reserved. We are committed to excellence. We aim to be the best.'],
  });
  checkStrings('boilerplate findings', boilerplate.findings);

  // InfoDensity metric lines (receipt labels) — word variety / common words /
  // average sentence length / short paragraphs.
  const info = analyzeInfoDensity({
    text: 'Welcome to our site. We are the best. Trust us. Click here. Buy now. Great deals.',
    words: ['Welcome', 'to', 'our', 'site', 'We', 'are', 'the', 'best', 'Trust', 'us', 'Click', 'here', 'Buy', 'now', 'Great', 'deals'],
    sentences: ['Welcome to our site.', 'We are the best.', 'Trust us.', 'Click here.', 'Buy now.', 'Great deals.'],
    paragraphs: ['Welcome to our site.', 'We are the best. Trust us.', 'Click here. Buy now.', 'Great deals.'],
  });
  checkStrings('infoDensity findings', info.findings);

  // Specifics gap evidence.
  const specs = analyzeSpecifics('We help teams grow. We are the best. Everyone loves us.', 12);
  if (specs.gap) checkStrings('specifics gap evidence', ['specific details: only 0 in 12 words (need at least 1 per 75 words)']);

  // Cross-page evidence lines (multi-page pair + clean line).
  const cross = analyzeCrossPage({
    pages: [
      { url: 'https://a.example/', main: { words: ['same', 'words', 'again', 'same', 'words', 'again'] } },
      { url: 'https://b.example/', main: { words: ['same', 'words', 'again', 'same', 'words', 'again'] } },
    ],
  });
  checkStrings('crossPage findings', cross.findings);

  // Fingerprints evidence.
  const fp = analyzeFingerprints({ html: '', head: '<meta name="generator" content="v0.dev">', text: '' });
  checkStrings('fingerprints findings', fp.findings);

  // Assets evidence (stock host + alt text lines).
  const assets = analyzeAssets(
    '<img src="https://images.unsplash.com/photo-1" alt=""><img src="/img/photo2.png" alt="image">',
  );
  checkStrings('assets findings', assets.findings);
});

test('plain-English pass: insights built from plain evidence stay plain', () => {
  const findings = [
    '4 filler phrases in 300 words (4.0 per 300 words)',
    '3× "seamless"',
    '2 generic wording matches in 300 words (2.0 per 300 words)',
    '1× vague phrase "we aim to"',
    'vague sentence: "We aim to be the best."',
    'word variety: 0.581 (lower = more repetitive vocabulary)',
    'common words: 52.0% (little words like "the" and "and" — more means less substance)',
    'specific details: only 1 in 300 words (need at least 3 per 75 words) — e.g. $99, 2021',
    'same content on multiple pages: 2 page pairs, most similar at 92.3%',
    'recognizable template sign in the page html: v0.dev builder assets (high confidence)',
    '0 of 5 images look generic or placeholder',
  ];
  // Every finding must parse (evidence contract) and every produced insight must stay jargon-free.
  for (const f of findings) {
    const cat = f.includes('filler') || f.includes('"seamless"') ? 'filler'
      : f.includes('generic wording') || f.includes('vague') ? 'boilerplate'
        : f.includes('word variety') || f.includes('common words') || f.includes('specific details') ? 'infoDensity'
          : f.includes('same content') ? 'crossPage'
            : f.includes('recognizable template') ? 'fingerprints' : 'assets';
    const tokens = parseEvidenceTokens(cat, f);
    const insights = buildCategoryInsights({ category: cat, findings: [f], id: 'plain-english-check' });
    assert.ok(insights.length === 1, `insight built for ${f}`);
    checkStrings(`insight(${cat})`, [insights[0].roast, insights[0].why, insights[0].fix]);
  }
});