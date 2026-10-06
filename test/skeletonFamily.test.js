import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSkeleton, applySkeletonTerm, SKEL_PAIR_T, SKEL_COVERAGE_BAR, SKEL_SUB_WEIGHT } from '../src/rules/skeletonFamily.js';
import { analyzeCrossPage } from '../src/rules/crossPage.js';
import { computeSlopScore, FULL_RULE_WEIGHTS } from '../src/scorer.js';
import { VERDICT_BANDS } from '../src/verdict.js';
import { fixtureBreakdown } from './fixtures/helpers.js';
/**
 * Round-2 DOM skeleton / template-family detector — owner-approved spec
 * 2026-10-06 (ROUND2-SPEC.md, recommended parameters SKEL_PAIR_T 0.75 /
 * SKEL_COVERAGE_BAR 0.75 / SKEL_SUB_WEIGHT 0.8). The anchor table doubles as
 * the test spec: measured fixture pins are EXACT (real stored HTML, real
 * functions), synthetic controls are crafted HTML, and the composites run
 * through the REAL computeSlopScore (C1+C2 @ fc22ae6). Fixture bytes are
 * read-only — no live calls at test time.
 */
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skeleton');
const readPage = (tree, file) => fs.readFileSync(path.join(FIXTURES_DIR, tree, file), 'utf8');
const loadTree = (tree, host, pages) =>
  pages.map((p) => ({ url: host + p, html: readPage(tree, p === '/' ? 'index.html' : p) }));
// The exact scan-page sets + orders the shipped payloads were measured with
// (match /tmp/round2/final.mjs page lists byte-for-byte).
const TREES = {
  clean: loadTree('clean', 'https://peakformclimbing.example', ['/', '/about.html', '/schedule.html', '/privacy.html', '/terms.html']),
  blog: loadTree('blog', 'https://hikingdesk.example', ['/', '/review/trailwright-kiln-38.html', '/review/solstice-ridge-2p.html', '/review/meridian-fleece.html', '/about.html']),
  franchise: loadTree('franchise', 'https://budgetheroes.example', ['/', '/locations/springfield.html', '/locations/fairview.html', '/locations/cornerbrook.html', '/locations/elkton.html']),
  collapse: loadTree('collapse', 'https://greendoorlistings.example', ['/', '/listings/123-elm-street.html', '/listings/45-oak-avenue.html', '/listings/8-river-road.html', '/listings/221-birch-circle.html']),
};
// Stored per-category scores for the four fixture trees (the shipped payloads:
// clean-out.json / blog-v2.json / franchise-v3.json / c-v10-score.json — NOT
// the pre-C1/C2 drafts). "after" composites substitute the new crossPage'.
const STORED = {
  clean: { filler: 0, boilerplate: 17, infoDensity: 22, repetitive: 0, crossPage: 0, fingerprints: 0, assets: 0 },
  blog: { filler: 0, boilerplate: 33, infoDensity: 29, repetitive: 18, crossPage: 10, fingerprints: 18, assets: 0 },
  franchise: { filler: 21, boilerplate: 100, infoDensity: 30, repetitive: 3, crossPage: 27, fingerprints: 11, assets: 0 },
  collapse: { filler: 82, boilerplate: 100, infoDensity: 100, repetitive: 100, crossPage: 100, fingerprints: 58, assets: 75 },
};
// TechBullion-shaped synthetic vector (after-tb25.json, C1+C2-live):
//   filler 0, boilerplate 32, infoDensity 50, repetitive 7, crossPage 0,
//   fingerprints 15, assets 3 — pre-round 13.375. crossPage' 80 unlocks C2
//   (k=4 -> +9) and the farm lands EXACTLY on 50 (spec §4 worked example).
const TB_VECTOR = { filler: 0, boilerplate: 32, infoDensity: 50, repetitive: 7, crossPage: 0, fingerprints: 15, assets: 3 };
const cat = (scores) =>
  Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Number.isFinite(v) ? { score: v } : { score: null, findings: [], note: 'insufficient pages for cross-page analysis' }]),
  );
const composite = (scores) => computeSlopScore(cat(scores)).slopScore;
const preRound = (scores) =>
  Object.values(computeSlopScore(cat(scores)).components).reduce((s, c) => s + c.weighted, 0);

// ---------------------------------------------------------------------------
// Crafted-HTML helpers (deterministic skeletons via tag sequences)
// ---------------------------------------------------------------------------
const TAGS = ['b', 'i', 'u', 'em', 'strong', 'small', 'sub', 'sup', 'mark', 'q', 's'];
const OUT_TAGS = ['ol', 'ul', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption'];
const pageHtml = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const tagsPage = (tags) => pageHtml(tags.map((t) => `<${t}></${t}>`).join(''));
const seqTags = (n, tags = TAGS) => tags.slice(0, n);

// ---------------------------------------------------------------------------
// GROUP 1 — measured fixture pins (EXACT numbers from ROUND2-SPEC §5.1)
// ---------------------------------------------------------------------------
test('fixtures: clean-tree does not fire (family 2/5, below the 75% coverage bar), composite stays 5', () => {
  const r = detectSkeleton(TREES.clean);
  assert.equal(r.fired, false);
  assert.equal(r.familySize, 2);
  assert.equal(r.coverage, 0.4);
  assert.equal(r.skeletonScore, 0);
  assert.ok(r.receipts[0].includes('below the 75% coverage bar'), r.receipts[0]);
  assert.equal(composite({ ...STORED.clean, crossPage: applySkeletonTerm(STORED.clean.crossPage, r.skeletonScore) }), 5);
});
test('fixtures: blog-tree does not fire (family 3/5), composite stays 15', () => {
  const r = detectSkeleton(TREES.blog);
  assert.equal(r.fired, false);
  assert.equal(r.familySize, 3);
  assert.equal(r.coverage, 0.6);
  assert.equal(r.skeletonScore, 0);
  assert.ok(r.receipts[0].includes('below the 75% coverage bar'), r.receipts[0]);
  assert.equal(composite({ ...STORED.blog, crossPage: applySkeletonTerm(STORED.blog.crossPage, r.skeletonScore) }), 15);
});
test('fixtures: franchise-tree fires (family 4/5, maxJ4 1.000, skeleton 100) — crossPage 27 -> 100, composite 27 -> 61', () => {
  const r = detectSkeleton(TREES.franchise);
  assert.equal(r.fired, true);
  assert.equal(r.familySize, 4);
  assert.equal(r.coverage, 0.8);
  assert.equal(r.maxJ4, 1.0);
  assert.equal(r.skeletonScore, 100);
  // Receipts byte-exact (ROUND2-SPEC §5.1).
  assert.deepEqual(r.receipts, [
    '4 of the 5 scanned pages share one DOM skeleton (80% of the scan)',
    'https://budgetheroes.example/locations/springfield.html and https://budgetheroes.example/locations/fairview.html share 100% of their page skeleton',
  ]);
  const crossNew = applySkeletonTerm(STORED.franchise.crossPage, r.skeletonScore); // 27 + 0.8*100 -> clamped 100
  assert.equal(crossNew, 100);
  assert.equal(composite({ ...STORED.franchise, crossPage: STORED.franchise.crossPage }), 27, 'pre-change composite still 27');
  assert.equal(composite({ ...STORED.franchise, crossPage: crossNew }), 61, '27 -> 61 (C1 no, C2 k=5 -> +12)');
});
test('fixtures: collapse-tree fires but composite stays 100 (already clamped)', () => {
  const r = detectSkeleton(TREES.collapse);
  assert.equal(r.fired, true);
  assert.equal(r.familySize, 4);
  assert.equal(r.coverage, 0.8);
  assert.equal(r.maxJ4, 1.0);
  assert.equal(r.skeletonScore, 100);
  assert.deepEqual(r.receipts, [
    '4 of the 5 scanned pages share one DOM skeleton (80% of the scan)',
    'https://greendoorlistings.example/listings/123-elm-street.html and https://greendoorlistings.example/listings/45-oak-avenue.html share 100% of their page skeleton',
  ]);
  assert.equal(applySkeletonTerm(STORED.collapse.crossPage, r.skeletonScore), 100);
  assert.equal(composite({ ...STORED.collapse, crossPage: 100 }), 100);
});

// ---------------------------------------------------------------------------
// GROUP 2 — single-page no-fire (E1): detector null, composites byte-identical
// ---------------------------------------------------------------------------
test('single-page: detector is null and composites are byte-identical to the shipped pins (17/7/11/16)', () => {
  for (const name of ['stripe', 'getcollectionscopilot', 'ass-score', 'blog2posts']) {
    assert.equal(detectSkeleton([{ url: `https://${name}.example/`, html: fixtureBreakdown(name).html }]), null, `${name} single page -> null`);
  }
  assert.equal(fixtureBreakdown('stripe', 0).composite, 17);
  assert.equal(fixtureBreakdown('getcollectionscopilot', 0).composite, 7);
  assert.equal(fixtureBreakdown('ass-score', 0).composite, 11);
  assert.equal(fixtureBreakdown('blog2posts', 5).composite, 16);
  assert.equal(detectSkeleton([]), null, 'zero pages -> null');
});

// ---------------------------------------------------------------------------
// GROUP 3 — synthetic control pins (E2/E3/E4)
// ---------------------------------------------------------------------------
test('controls: chrome-only pair (shared nav+footer, different mains) never fires', () => {
  const [a, b] = [
    '<!doctype html><html><body><header><nav><a href="/a.html">A</a><a href="/b.html">B</a></nav></header><main><h1>Alpha Corp — trusted by teams for a decade of excellence</h1><p>Our platform helps teams ship faster with enterprise-grade reliability and world-class support.</p><p>See how our customers succeed with results they can measure and count on.</p><p>Contact our sales team to book a demo with an account executive today.</p></main><footer><p>Copyright Alpha Corp. All rights reserved.</p></footer></body></html>',
    '<!doctype html><html><body><header><nav><a href="/a.html">A</a><a href="/b.html">B</a></nav></header><main><h1>Beta Corp pricing</h1><p>Choose the plan that fits your team.</p><section><h2>Starter</h2><ul><li>10 seats</li><li>Basic support</li><li>2 GB storage</li></ul><h2>Pro</h2><ul><li>Unlimited seats</li><li>Priority support</li><li>50 GB storage</li></ul></section><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Starter</td><td>$9</td></tr></table><blockquote>Loved by thousands of customers.</blockquote></main><footer><p>Copyright Alpha Corp. All rights reserved.</p></footer></body></html>',
  ];
  const r = detectSkeleton([
    { url: 'https://control.example/a.html', html: a },
    { url: 'https://control.example/b.html', html: b },
  ]);
  assert.equal(r.fired, false);
  assert.equal(r.reason, `no pair >= ${SKEL_PAIR_T}`);
  assert.equal(r.skeletonScore, 0);
  assert.deepEqual(r.receipts, [`no two scanned pages share more than ${Math.round(SKEL_PAIR_T * 100)}% of their DOM skeleton`]);
});
test('controls: identical-skeleton pair (farm) fires at 100', () => {
  const r = detectSkeleton([
    { url: 'https://farm.example/1', html: tagsPage(seqTags(11)) },
    { url: 'https://farm.example/2', html: tagsPage(seqTags(11)) },
  ]);
  assert.equal(r.fired, true);
  assert.equal(r.familySize, 2);
  assert.equal(r.coverage, 1.0);
  assert.equal(r.maxJ4, 1.0);
  assert.equal(r.skeletonScore, 100);
});
test('controls: coverage boundary — 3-of-5 family does not fire, 4-of-5 fires', () => {
  const family = seqTags(8); // 5 shingles among themselves
  const outsider = seqTags(8, OUT_TAGS); // zero shingle overlap
  const mk = (nFamily) => {
    const pages = [];
    for (let i = 0; i < nFamily; i += 1) pages.push({ url: `https://t.example/f${i}`, html: tagsPage(family) });
    for (let i = nFamily; i < 5; i += 1) pages.push({ url: `https://t.example/o${i}`, html: tagsPage(outsider) });
    return pages;
  };
  const r3 = detectSkeleton(mk(3));
  assert.equal(r3.fired, false);
  assert.equal(r3.familySize, 3);
  assert.equal(r3.coverage, 0.6);
  const r4 = detectSkeleton(mk(4));
  assert.equal(r4.fired, true);
  assert.equal(r4.familySize, 4);
  assert.equal(r4.coverage, 0.8);
  assert.equal(r4.skeletonScore, 100);
});

// ---------------------------------------------------------------------------
// GROUP 4 — boundary pins (pair gate, score slope, clamp)
// ---------------------------------------------------------------------------
test('boundary: pair gate at exactly j4 0.75 fires (score 0), a hair below (5/7 = 0.714) does not', () => {
  const pair = (nA, nB) => [
    { url: 'https://b.example/a', html: tagsPage(seqTags(nA)) },
    { url: 'https://b.example/b', html: tagsPage(seqTags(nB)) },
  ];
  const at75 = detectSkeleton(pair(9, 11)); // 6/8 shingles = exactly 0.75
  assert.equal(at75.fired, true);
  assert.equal(at75.maxJ4, 0.75);
  assert.equal(at75.skeletonScore, 0, '0 at j4 = 0.75');
  const below = detectSkeleton(pair(8, 10)); // 5/7 shingles = 0.714 < 0.75
  assert.equal(below.fired, false);
  assert.equal(below.skeletonScore, 0);
});
test('boundary: skeletonScore slope — 0.75 -> 0, 0.875 -> 50, 1.0 -> 100', () => {
  const run = (nA, nB) => detectSkeleton([
    { url: 'https://s.example/a', html: tagsPage(seqTags(nA)) },
    { url: 'https://s.example/b', html: tagsPage(seqTags(nB)) },
  ]);
  assert.equal(run(9, 11).maxJ4, 0.75);
  assert.equal(run(9, 11).skeletonScore, 0);
  assert.equal(run(10, 11).maxJ4, 0.875);
  assert.equal(run(10, 11).skeletonScore, 50);
  assert.equal(run(11, 11).maxJ4, 1.0);
  assert.equal(run(11, 11).skeletonScore, 100);
});
test('boundary: crossPage\' clamp — 27+80 -> 100, 100+80 -> 100, 0+79.2 -> 79, 50+0.8*63 -> 100', () => {
  assert.equal(applySkeletonTerm(27, 100), 100);
  assert.equal(applySkeletonTerm(100, 100), 100);
  assert.equal(applySkeletonTerm(0, 99), 79); // 0.8*99 = 79.2 -> round 79
  assert.equal(applySkeletonTerm(50, 63), 100); // 50 + 50.4 -> 100.4 -> clamp 100
  assert.equal(applySkeletonTerm(10, 0), 10); // detector not fired -> unchanged
  assert.equal(applySkeletonTerm(null, 100), 80); // null contribution treated as 0
  assert.equal(applySkeletonTerm(0, undefined), 0);
});

// ---------------------------------------------------------------------------
// GROUP 5 — identity guard (E6): same-URL pairs are never compared
// ---------------------------------------------------------------------------
test('identity guard: a duplicated URL in the pages array is skipped; result identical to the deduped set', () => {
  const f = seqTags(8);
  const withDup = [
    { url: 'https://i.example/a', html: tagsPage(f) },
    { url: 'https://i.example/a', html: tagsPage(f) }, // duplicate URL (belt-and-braces)
    { url: 'https://i.example/b', html: tagsPage(f) },
    { url: 'https://i.example/c', html: tagsPage(f) },
  ];
  const deduped = [withDup[0], withDup[2], withDup[3]];
  const a = detectSkeleton(withDup);
  const b = detectSkeleton(deduped);
  assert.equal(a.fired, true);
  assert.equal(a.fired, b.fired);
  assert.equal(a.coverage, b.coverage); // 4/4 == 3/3 == 1.0 — the self-pair never inflated the family
  assert.equal(a.maxJ4, b.maxJ4);
  assert.equal(a.skeletonScore, b.skeletonScore);
  assert.equal(a.coverage, 1.0);
});

// ---------------------------------------------------------------------------
// GROUP 6 — C2 interplay (E8): crossPage' 80 unlocks +9 (k=4 -> 50 with the TB
// vector); 79 does not
// ---------------------------------------------------------------------------
test('C2 interplay: crossPage\' = 80 fires C2 (k=4, +9, composite 50); 79 does not', () => {
  assert.equal(applySkeletonTerm(0, 100), 80, 'full-fire skeleton lands EXACTLY on the C2 gate');
  const at80 = { ...TB_VECTOR, crossPage: 80 };
  const at79 = { ...TB_VECTOR, crossPage: 79 };
  assert.ok(Math.abs(preRound(at80) - 37.375) < 1e-9, 'pre-round 37.375');
  assert.equal(composite(at80), 50, '37.375 + 4 (C1) + 9 (C2, k=4) = 50.375 -> 50');
  assert.equal(composite(at79), 41, '37.075 + 4 (C1) = 41.075 -> 41 — no C2 at 79');
  assert.equal(composite(at79), composite({ ...at79, crossPage: 79 })); // deterministic
});

// ---------------------------------------------------------------------------
// GROUP 7 — determinism
// ---------------------------------------------------------------------------
test('determinism: two detector runs on the franchise tree produce identical objects', () => {
  const a = detectSkeleton(TREES.franchise);
  const b = detectSkeleton(TREES.franchise);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------
// GROUP 8 — C1/C2 composition: the §4 worked example lands EXACTLY on 50
// ---------------------------------------------------------------------------
test('composition: TB-shape synthetic farm (skeleton 100 -> crossPage\' 80) reproduces the §4 math exactly (50)', () => {
  const nav = '<header class="site-header"><nav class="main-nav"><a class="brand" href="/">Daily Wire Finance</a><a href="/news/">News</a><a href="/markets/">Markets</a><a href="/crypto/">Crypto</a></nav></header>';
  const footer = '<footer class="site-footer"><p>© 2026 Daily Wire Finance. All rights reserved. Privacy Policy Terms of Service.</p></footer>';
  const cat_ = (title, lines) => `<!doctype html><html><head><title>${title}</title></head><body>${nav}<main><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}<section class="article-list"><article class="entry"><h2 class="entry-title">Latest in ${title}</h2><p>Read more about ${title} updates</p></article></section></main>${footer}</body></html>`;
  const home = `<!doctype html><html><head><title>Daily Wire Finance</title></head><body>${nav}<main><h1>Welcome to Daily Wire Finance</h1><p>Stay ahead of the curve with our comprehensive coverage of global financial markets, delivered to your inbox every morning with exclusive insights that matter.</p><p>The financial landscape is changing faster than ever, and our expert analysts break down complex trends into actionable intelligence for investors of every level.</p><section class="hero"><h2>Your trusted source</h2><p>Join thousands of readers who rely on our team for breaking news, in-depth analysis, and market-moving coverage.</p></section></main>${footer}</body></html>`;
  const pages = [
    { url: 'https://dailywire.example/', html: home },
    { url: 'https://dailywire.example/news/', html: cat_('News', ['The latest headlines from around the world of business and finance.', 'Markets rallied today as investors weighed new data from the labor market.']) },
    { url: 'https://dailywire.example/markets/', html: cat_('Markets', ['Equities finished mixed in light trading, with technology shares leading gains.', 'Bond yields eased as traders positioned ahead of the central bank decision.']) },
    { url: 'https://dailywire.example/crypto/', html: cat_('Crypto', ['Digital assets extended their gains for a third consecutive session.', 'Regulators signaled a cautious approach to the fast-growing industry.']) },
    { url: 'https://dailywire.example/economy/', html: cat_('Economy', ['Economic data pointed to steady growth in the services sector.', 'Manufacturing activity showed signs of stabilization after a rocky quarter.']) },
  ];
  const det = detectSkeleton(pages);
  assert.equal(det.fired, true);
  assert.equal(det.familySize, 4);
  assert.equal(det.maxJ4, 1.0);
  assert.equal(det.skeletonScore, 100);
  assert.equal(applySkeletonTerm(TB_VECTOR.crossPage, det.skeletonScore), 80);
  const withCredit = { ...TB_VECTOR, crossPage: 80 };
  assert.ok(Math.abs(preRound(withCredit) - 37.375) < 1e-9);
  assert.equal(composite(withCredit), 50, '13.375 + 24 (0.30*80) + 4 (C1) + 9 (C2) = 50.375 -> 50');
  // And the detector result receipts ride into the REPETITION card through
  // crossPage findings (the wiring both scan.js paths share). Distinct main
  // bodies -> pairwise term 0 -> score = 0 + 0.8*100 = 80 exactly.
  const mains = pages.map((p, idx) => ({ url: p.url, main: { words: `only words unique to page ${idx} here`.split(' ') } }));
  const cross = analyzeCrossPage({ pages: mains, skeleton: det });
  assert.equal(cross.score, 80);
  assert.ok(cross.findings.some((f) => f.includes('share one DOM skeleton (80% of the scan)')), cross.findings.join(' | '));
  assert.ok(cross.findings.some((f) => f.includes('share 100% of their page skeleton')), cross.findings.join(' | '));
  const single = { pages: [{ url: 'https://x/', main: { words: 'a b c d e'.split(' ') } }] };
  assert.deepEqual(analyzeCrossPage({ ...single, skeleton: det }), analyzeCrossPage(single), 'single page -> skeleton ignored, v1 branch byte-identical');
});

// ---------------------------------------------------------------------------
// GROUP 9 — spec-parity guard: no category/weight/verdict/computeSlopScore
// surface changes; thresholds are the recommended values
// ---------------------------------------------------------------------------
test('spec parity: knobs are the recommended values and no engine surface changed', () => {
  assert.equal(SKEL_PAIR_T, 0.75);
  assert.equal(SKEL_COVERAGE_BAR, 0.75);
  assert.equal(SKEL_SUB_WEIGHT, 0.8);
  assert.deepEqual(FULL_RULE_WEIGHTS, {
    filler: 0.125, boilerplate: 0.10, infoDensity: 0.15, repetitive: 0.125,
    crossPage: 0.30, fingerprints: 0.10, assets: 0.10,
  });
  assert.deepEqual(VERDICT_BANDS.map((b) => b.max), [9, 19, 29, 39, 49, 59, 69, 79, 89, 100]);
  const input = { ...STORED.franchise, crossPage: 100 };
  const r = computeSlopScore(cat(input));
  assert.deepEqual(Object.keys(r).sort(), ['components', 'slopScore']);
  for (const [key, comp] of Object.entries(r.components)) {
    assert.deepEqual(Object.keys(comp).sort(), ['score', 'weight', 'weighted']);
    assert.equal(comp.score, input[key]);
  }
});