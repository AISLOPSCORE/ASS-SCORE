/**
 * OWNER-GATED REGRESSION TESTS — text-extraction quote fix (Option B,
 * owner-approved 2026-10-07; investigation: /home/team/shared/text-extraction-bug/
 * investigation.md §6-7).
 *
 * The two non-negotiable owner gates this file proves:
 *
 *   GATE 1 (general): clean readable quotes for ALL concatenated UI patterns,
 *   not just the reported price+CTA card. Five distinct adjacent-element
 *   patterns each run the REAL pipeline (extractText → runRules →
 *   analyzeCrossPage, mirroring scan.js):
 *     1. price+CTA   ("Advertise now" button + "$29.99 · 30 DAYS" — the bug),
 *     2. stat+label  ("12,000+" + "customers served"),
 *     3. icon+caption("⚡" + "Fast in 0.1s"),
 *     4. nav/link+button ("Sign up now" + "Free forever" — a WORD-MERGE
 *        boundary: "up"+"F" meld into "upFree" in the analysis corpus),
 *     5. icon+text inside a link (SVG + "Get started" + "Free 14-day trial").
 *   For each: the finding quote contains the readable pieces (symbols and
 *   punctuation preserved, elements separated with a space) NOT normalized
 *   garbage; every category score and the composite are IDENTICAL to the
 *   unmodified (no-readable) path; the underlying phrase/sentence is still
 *   detected.
 *
 *   GATE 2 (family coverage): a constructed multi-pattern page where all four
 *   page-text-quoting families fire — REPETITION (crossPage in-page phrase
 *   receipts), STRUCTURE (repetitive openings/near-identical/paragraphs),
 *   MESSAGING (copySlop hedge sentence quotes under boilerplate), COPY
 *   (boilerplate repeated blocks) — and every quoted string reads readable.
 *   ORIGINALITY (fingerprints) and assets quote NO page text (config labels +
 *   HTML/image attributes only) — asserted structurally below.
 *
 * SCORING GUARANTEE: `readable` never feeds a score. Every rule computes its
 * score from the analysis corpus; the readable variant supplies quote strings
 * only. Proved here by running each fixture BOTH ways and asserting the 7
 * category scores + composite are byte-identical.
 *
 * No live fetches — fixtures are static HTML strings (the price+CTA fixture
 * is byte-same as the investigation's fixture-card-quote.html).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractText, extractMainText, extractReadableText, extractHead } from '../src/text.js';
import { runRules } from '../src/rules/index.js';
import { analyzeCrossPage } from '../src/rules/crossPage.js';
import { analyzeFingerprints } from '../src/rules/fingerprints.js';
import { analyzeAssets } from '../src/rules/assets.js';
import { analyzeSpecifics } from '../src/rules/copySlop.js';
import { computeSlopScore } from '../src/scorer.js';
import { runScan } from '../src/scan.js';

// ---------------------------------------------------------------------------
// Fixtures — every one is a REAL adjacent-element concatenation in minified /
// JSX-style markup (no whitespace text node between the elements).
// ---------------------------------------------------------------------------

/** Pattern 1 — price+CTA. Byte-same as investigation fixture-card-quote.html. */
const PRICE_CTA = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Publish Your SaaS — Advertise your product</title>
</head>
<body>
  <main>
    <h1>Publish Your SaaS</h1>
    <p>Reach the exact founders who are already looking for tools like yours.</p>
    <p>Every campaign is manually reviewed before it goes live.</p>

    <!-- The owner-reported pattern: pricing/CTA card widget. B<button>Advertise now</button>
         sits ADJACENT to <span>$29.99 · 30</span> (no separating whitespace text node),
         so the analysis corpus reads "Advertise now$29.99 · 30 day plan." and the
         REPETITION receipt quoted the normalized "advertise now 29 99 30". -->
    <section class="pricing-card">
      <div class="card-body">
        <h2>Featured listing</h2>
        <p>Get featured on the homepage for 30 days.</p>
        <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> day plan.</p>
      </div>
      <div class="card-body">
        <h2>Featured listing</h2>
        <p>Get featured on the homepage for 30 days.</p>
        <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> week plan.</p>
      </div>
      <div class="card-body">
        <h2>Featured listing</h2>
        <p>Get featured on the homepage for 30 days.</p>
        <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> month plan.</p>
      </div>
    </section>
  </main>
</body>
</html>`;

/** Pattern 2 — stat + label. */
const STAT_LABEL = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme Analytics — proof</title></head>
<body><main>
<h1>Acme Analytics</h1>
<p>Numbers tell the real story.</p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<p>Each number is verified quarterly.</p>
<p>Join them today.</p>
</main></body></html>`;

/** Pattern 3 — icon (emoji) + caption. */
const ICON_CAPTION = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Zap Stack — speed</title></head>
<body><main>
<h1>Zap Stack</h1>
<p>Speed is the whole point.</p>
<p class="feature"><span class="icon">⚡</span><span class="cap">Fast in 0.1s.</span></p>
<p class="feature"><span class="icon">⚡</span><span class="cap">Fast in 0.1s.</span></p>
<p class="feature"><span class="icon">⚡</span><span class="cap">Fast in 0.1s.</span></p>
<p>Everything else is secondary.</p>
<p>Try it today.</p>
</main></body></html>`;

/** Pattern 4 — nav/link + button ("Sign up now" + "Free forever"): the WORD-MERGE
 *  boundary case — "up" + "F" meld into "upFree" with NO punctuation in between,
 *  so normalizePhrase containment alone can NOT unify the two corpora; the
 *  whitespace-stripped fallback can. */
const NAV_CTA = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>QuickLaunch — sign up</title></head>
<body><main>
<h1>QuickLaunch</h1>
<p>Ships in minutes, not months.</p>
<p class="cta"><a class="link" href="/signup">Sign up now</a><span class="free">Free forever.</span></p>
<p class="cta"><a class="link" href="/signup">Sign up now</a><span class="free">Free forever.</span></p>
<p class="cta"><a class="link" href="/signup">Sign up now</a><span class="free">Free forever.</span></p>
<p>No credit card required.</p>
<p>Cancel anytime.</p>
</main></body></html>`;

/** Pattern 5 — icon (SVG) + text inside a link. */
const ICON_LINK = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Planetly — pricing</title></head>
<body><main>
<h1>Planetly</h1>
<p>One plan, no surprises.</p>
<p class="plan"><a class="plan-link" href="/pricing"><svg aria-hidden="true"><path d="M0 0"></path></svg>Get started</a><span class="trial">Free 14-day trial.</span></p>
<p class="plan"><a class="plan-link" href="/pricing"><svg aria-hidden="true"><path d="M0 0"></path></svg>Get started</a><span class="trial">Free 14-day trial.</span></p>
<p class="plan"><a class="plan-link" href="/pricing"><svg aria-hidden="true"><path d="M0 0"></path></svg>Get started</a><span class="trial">Free 14-day trial.</span></p>
<p>Upgrade when you are ready.</p>
<p>Questions answered daily.</p>
</main></body></html>`;

/** Gate-2 page — every page-text-quoting family fires:
 *  REPETITION (phrases), STRUCTURE (openings/near-identical/paragraphs),
 *  MESSAGING (hedge "we aim to" + "seamless experience"), COPY (repeated blocks). */
const ALL_FAMILIES = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Example Corp — advertising</title></head>
<body><main>
<h1>Example Corp</h1>
<p>Every product ships with support.</p>
<p><span class="lead">We aim to</span><span class="rest">deliver a seamless experience to every customer.</span></p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<p class="stat-row"><span class="value">12,000+</span><span class="label">customers served.</span></p>
<section class="pricing-card">
  <div class="card-body">
    <h2>Featured listing</h2>
    <p>Get featured on the homepage for 30 days.</p>
    <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> day plan.</p>
  </div>
  <div class="card-body">
    <h2>Featured listing</h2>
    <p>Get featured on the homepage for 30 days.</p>
    <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> week plan.</p>
  </div>
  <div class="card-body">
    <h2>Featured listing</h2>
    <p>Get featured on the homepage for 30 days.</p>
    <p class="cta-row"><button class="cta-button">Advertise now</button><span class="price-label">$29.99 · 30</span> month plan.</p>
  </div>
</section>
</main></body></html>`;

// ---------------------------------------------------------------------------
// Pipeline helper — runs the SAME html through the analysis path with and
// without the readable corpus (both exactly as scan.js composes them), plus
// the real fingerprints/assets (shared — they never consume readable).
// ---------------------------------------------------------------------------
function runBoth(html) {
  const text = extractText(html);
  const main = extractMainText(html);
  const readable = extractReadableText(html);
  const fingerprints = analyzeFingerprints({ html, head: extractHead(html), text: text.text, extraHits: [] });
  const assets = analyzeAssets(html);
  const plainCp = analyzeCrossPage({
    pages: [{ url: 'https://x.test/', main, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title }],
  });
  const fixedCp = analyzeCrossPage({
    pages: [{ url: 'https://x.test/', main, sentences: text.sentences, paragraphs: text.paragraphs, title: text.title, readable }],
  });
  const plain = { ...runRules(text), crossPage: plainCp, fingerprints, assets };
  const fixed = { ...runRules(text, readable), crossPage: fixedCp, fingerprints, assets };
  const scores = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.score]));
  return {
    text,
    readable,
    plain,
    fixed,
    plainScores: scores(plain),
    fixedScores: scores(fixed),
    plainComposite: computeSlopScore(plain).slopScore,
    fixedComposite: computeSlopScore(fixed).slopScore,
  };
}

/** Every quoted string inside every finding of the four page-text families. */
function quotedPieces(breakdown) {
  const out = [];
  for (const cat of ['crossPage', 'repetitive', 'boilerplate']) {
    for (const f of breakdown[cat].findings) {
      for (const m of String(f).matchAll(/"([^"]+)"/g)) out.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit: extractReadableText inserts boundary spaces; analysis corpus untouched.
// ---------------------------------------------------------------------------
test('readable: extractReadableText inserts ONE space at adjacent element boundaries; analysis corpus byte-identical', () => {
  for (const [name, html, garble, readable] of [
    ['price+CTA', PRICE_CTA, 'Advertise now$29.99', 'Advertise now $29.99'],
    ['stat+label', STAT_LABEL, '12,000+customers', '12,000+ customers'],
    ['icon+caption', ICON_CAPTION, '⚡Fast', '⚡ Fast'],
    ['nav/link+button', NAV_CTA, 'nowFree', 'now Free'],
    ['icon+text in link', ICON_LINK, 'startedFree', 'started Free'],
  ]) {
    const text = extractText(html);
    const readableText = extractReadableText(html);
    // The ANALYSIS corpus still has the concat defect (proves it is untouched).
    assert.ok(text.text.includes(garble), `${name}: analysis corpus must keep the concat form (${garble})`);
    assert.ok(!readableText.text.includes(garble), `${name}: readable must not contain the concat form`);
    assert.ok(readableText.text.includes(readable), `${name}: readable must contain the boundary-spaced form`);
    // Same shape: sentences + paragraphs both present and deterministic.
    assert.ok(Array.isArray(readableText.sentences) && readableText.sentences.length > 0, name);
    assert.ok(Array.isArray(readableText.paragraphs) && readableText.paragraphs.length > 0, name);
    assert.deepEqual(extractReadableText(html), readableText, `${name}: deterministic`);
    assert.deepEqual(extractText(html), text, `${name}: analysis extraction byte-identical across calls`);
  }
  // Non-text content is dropped like the corpus (SVG never reaches quotes).
  const icon = extractReadableText(ICON_LINK);
  assert.ok(!/M0 0/.test(icon.text) && !/<svg/.test(icon.text), 'svg subtree must be removed');
});

// ---------------------------------------------------------------------------
// GATE 1 — every concatenation pattern produces readable quotes, byte-identical
// scores to the unmodified path, and detection is preserved.
// ---------------------------------------------------------------------------

test('GATE1 price+CTA: the reported "advertise now 29 99 30" reads "Advertise now $29.99 · 30 day plan"; composite stays 34', () => {
  const r = runBoth(PRICE_CTA);
  // The unmodified path still produces the reported garble (fixture is really
  // garble-affected — the fix, not the fixture, changed the receipt).
  assert.ok(r.plain.crossPage.findings.some((f) => f.includes('"advertise now 29 99 30"')), 'plain path must keep the reported garble');
  // REPETITION (crossPage): the fired normalized phrase is replaced by the
  // readable sentence window containing it (trailing period stripped).
  assert.ok(
    r.fixed.crossPage.findings.some((f) => f === 'repeated phrase in the page text: 3× "Advertise now $29.99 · 30 day plan" — in 3 paragraphs'),
    JSON.stringify(r.fixed.crossPage.findings),
  );
  // STRUCTURE (repetitive): openings + near-identical + paragraphs readable.
  assert.ok(
    r.fixed.repetitive.findings.some((f) => f === 'repeated sentence openings: 3× "Featured listing Get…", 3× "Advertise now $29.99…"'),
    JSON.stringify(r.fixed.repetitive.findings),
  );
  assert.ok(
    r.fixed.repetitive.findings.some((f) => f === 'near-identical sentences: 3× "Featured listing Get featured on the homepage for 30 days."'),
    JSON.stringify(r.fixed.repetitive.findings),
  );
  assert.ok(
    r.fixed.repetitive.findings.some((f) => f === 'repeated paragraphs: 3× "Featured listing", 3× "Get featured on the homepage for 30 days."'),
    JSON.stringify(r.fixed.repetitive.findings),
  );
  // COPY (boilerplate): repeated blocks readable.
  assert.ok(r.fixed.boilerplate.findings.some((f) => f === '3× repeated block: "Featured listing"'), JSON.stringify(r.fixed.boilerplate.findings));
  assert.ok(r.fixed.boilerplate.findings.some((f) => f === '3× repeated block: "Get featured on the homepage for 30 days."'), JSON.stringify(r.fixed.boilerplate.findings));
  // No normalized garble anywhere in the quoted evidence.
  for (const q of quotedPieces(r.fixed)) {
    assert.ok(!q.includes('29 99 30'), `normalized garbage leaked into a quote: ${q}`);
  }
  // Detection intact + score parity (the Option B core guarantee).
  assert.equal(r.plain.crossPage.score, 10);
  assert.equal(r.fixed.crossPage.score, 10);
  assert.deepEqual(r.fixedScores, r.plainScores, 'all 7 category scores identical with/without readable');
  assert.equal(r.fixedComposite, r.plainComposite);
  assert.equal(r.fixedComposite, 34, 'investigation-pinned composite (fingerprints 5 incl.)');
});

test('GATE1 stat+label: "12 000 customers" reads "12,000+ customers"; scores unchanged', () => {
  const r = runBoth(STAT_LABEL);
  assert.ok(r.plain.crossPage.findings.some((f) => f.includes('"12 000 customers served"')), 'plain path keeps the normalized garble');
  assert.ok(
    r.fixed.crossPage.findings.some((f) => f === 'repeated phrase in the page text: 3× "12,000+ customers served" — in 3 paragraphs'),
    JSON.stringify(r.fixed.crossPage.findings),
  );
  // Comma AND plus preserved in the quote; STRUCTURE openings readable too.
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'repeated sentence openings: 3× "12,000+ customers served…"'), JSON.stringify(r.fixed.repetitive.findings));
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'near-identical sentences: 3× "12,000+ customers served."'), JSON.stringify(r.fixed.repetitive.findings));
  assert.ok(r.fixed.boilerplate.findings.some((f) => f === '3× repeated block: "12,000+ customers served."'), JSON.stringify(r.fixed.boilerplate.findings));
  assert.deepEqual(r.fixedScores, r.plainScores);
  assert.equal(r.fixedComposite, r.plainComposite);
  assert.equal(r.fixed.crossPage.score, r.plain.crossPage.score);
});

test('GATE1 icon+caption: "fast in 0 1s" reads "⚡ Fast in 0.1s" — emoji + decimal preserved', () => {
  const r = runBoth(ICON_CAPTION);
  assert.ok(r.plain.crossPage.findings.some((f) => f.includes('"fast in 0 1s"')), 'plain path keeps the normalized garble');
  assert.ok(
    r.fixed.crossPage.findings.some((f) => f === 'repeated phrase in the page text: 3× "⚡ Fast in 0.1s" — in 3 paragraphs'),
    JSON.stringify(r.fixed.crossPage.findings),
  );
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'repeated sentence openings: 3× "⚡ Fast in…"'), JSON.stringify(r.fixed.repetitive.findings));
  assert.deepEqual(r.fixedScores, r.plainScores);
  assert.equal(r.fixedComposite, r.plainComposite);
});

test('GATE1 nav/link+button (word-merge boundary): "sign up nowfree forever" reads "Sign up now Free forever"', () => {
  const r = runBoth(NAV_CTA);
  // The analysis corpus MERGES the boundary into "upFree" (no punctuation to
  // separate it), so the plain receipt is still garbage after normalization.
  assert.ok(r.text.text.includes('Sign up nowFree forever'), 'fixture must have the word-merge concat form');
  assert.ok(r.plain.crossPage.findings.some((f) => f.includes('"sign up nowfree forever"')), 'plain path keeps the word-merge garble');
  assert.ok(
    r.fixed.crossPage.findings.some((f) => f === 'repeated phrase in the page text: 3× "Sign up now Free forever" — in 3 paragraphs'),
    JSON.stringify(r.fixed.crossPage.findings),
  );
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'near-identical sentences: 3× "Sign up now Free forever."'), JSON.stringify(r.fixed.repetitive.findings));
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'repeated sentence openings: 3× "Sign up now…"'), JSON.stringify(r.fixed.repetitive.findings));
  assert.deepEqual(r.fixedScores, r.plainScores);
  assert.equal(r.fixedComposite, r.plainComposite);
});

test('GATE1 icon+text inside a link (SVG sibling): "get startedfree 14 day trial" reads "Get started Free 14-day trial"', () => {
  const r = runBoth(ICON_LINK);
  assert.ok(r.plain.crossPage.findings.some((f) => f.includes('"get startedfree 14 day trial"')), 'plain path keeps the garble');
  assert.ok(
    r.fixed.crossPage.findings.some((f) => f === 'repeated phrase in the page text: 3× "Get started Free 14-day trial" — in 3 paragraphs'),
    JSON.stringify(r.fixed.crossPage.findings),
  );
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'repeated sentence openings: 3× "Get started Free…"'), JSON.stringify(r.fixed.repetitive.findings));
  assert.ok(r.fixed.repetitive.findings.some((f) => f === 'near-identical sentences: 3× "Get started Free 14-day trial."'), JSON.stringify(r.fixed.repetitive.findings));
  assert.deepEqual(r.fixedScores, r.plainScores);
  assert.equal(r.fixedComposite, r.plainComposite);
});

// ---------------------------------------------------------------------------
// GATE 2 — family coverage: REPETITION + STRUCTURE + MESSAGING + COPY all fire
// on one page and every quoted string reads readable; ORIGINALITY/assets never
// quote page text.
// ---------------------------------------------------------------------------
test('GATE2 all families: REPETITION/STRUCTURE/MESSAGING/COPY quotes all readable on one page; scores identical', () => {
  const r = runBoth(ALL_FAMILIES);
  const g = (arr, frag) => arr.find((f) => f.includes(frag));

  // REPETITION (crossPage in-page phrase receipts).
  const cp = r.fixed.crossPage.findings;
  assert.ok(g(cp, '3× "Featured listing Get featured on the homepage for 30 days"'), JSON.stringify(cp));
  assert.ok(g(cp, '3× "Advertise now $29.99 · 30 day plan" — in 3 paragraphs'), JSON.stringify(cp));
  assert.ok(g(cp, '3× "12,000+ customers served" — in 3 paragraphs'), JSON.stringify(cp));
  // The same detectors on the plain path still show the garble (fix proof).
  assert.ok(g(r.plain.crossPage.findings, '"advertise now 29 99 30"'), JSON.stringify(r.plain.crossPage.findings));

  // STRUCTURE (repetitive).
  const rep = r.fixed.repetitive.findings;
  assert.ok(
    g(rep, 'repeated sentence openings: 3× "12,000+ customers served…", 3× "Featured listing Get…", 3× "Advertise now $29.99…"'),
    JSON.stringify(rep),
  );
  assert.ok(g(rep, 'near-identical sentences: 3× "12,000+ customers served.", 3× "Featured listing Get featured on the homepage for 30 days."'), JSON.stringify(rep));
  assert.ok(g(rep, 'repeated paragraphs: 3× "12,000+ customers served.", 3× "Featured listing", 3× "Get featured on the homepage for 30 days."'), JSON.stringify(rep));
  // Plain-path STRUCTURE garble: punctuation-removal melds "12,000+customers".
  assert.ok(g(r.plain.repetitive.findings, '12000customers served'), 'plain path must keep the melded-structure garble');

  // MESSAGING (copySlop hedge quotes under boilerplate).
  const bp = r.fixed.boilerplate.findings;
  const hedgeQuotes = bp.filter((f) => f.startsWith('vague sentence:'));
  assert.ok(hedgeQuotes.length >= 2, `both hedge phrases must quote: ${JSON.stringify(hedgeQuotes)}`);
  for (const hq of hedgeQuotes) {
    assert.equal(hq, 'vague sentence: "We aim to deliver a seamless experience to every customer."', 'hedge evidence must read readable (was "We aim todeliver…")');
  }
  // COPY (boilerplate repeated blocks).
  assert.ok(g(bp, '3× repeated block: "12,000+ customers served."'), JSON.stringify(bp));
  assert.ok(g(bp, '3× repeated block: "Featured listing"'), JSON.stringify(bp));
  assert.ok(g(bp, '3× repeated block: "Get featured on the homepage for 30 days."'), JSON.stringify(bp));

  // EVERY quoted string from the four page-text families reads page-like:
  // no normalized garble, no melded tokens, no missing boundary spaces.
  for (const q of quotedPieces(r.fixed)) {
    assert.ok(!q.includes('29 99 30'), `normalized token-run leaked: ${q}`);
    assert.ok(!q.includes('todeliver'), `melded hedge boundary leaked: ${q}`);
    assert.ok(!q.includes('upfree') && !q.includes('nowfree') && !q.includes('startedfree'), `melded word boundary leaked: ${q}`);
    assert.ok(!q.includes('12,000+customers') && !q.includes('12000customers'), `melded stat boundary leaked: ${q}`);
  }

  // Detection intact on BOTH paths; scores byte-identical (Option B guarantee).
  for (const cat of ['crossPage', 'repetitive', 'boilerplate']) {
    assert.ok(r.plain[cat].score > 0, `${cat} must fire on the constructed page`);
    assert.equal(r.fixed[cat].score, r.plain[cat].score, `${cat} score must not move`);
  }
  assert.deepEqual(r.fixedScores, r.plainScores);
  assert.equal(r.fixedComposite, r.plainComposite);
});

test('GATE2 ORIGINALITY/assets: fingerprints (ORIGINALITY) and assets quote NO page text — config labels and HTML/image attributes only', () => {
  // CODE-LEVEL GUARANTEE (structural): the fingerprints and assets rules never
  // import or consume the readable corpus — their evidence is built from
  // config labels (patterns/tokens in JSON) and HTML/head/image attributes.
  // If a future change routes page text into their quotes, THIS test fails.
  for (const mod of ['src/rules/fingerprints.js', 'src/rules/assets.js']) {
    const src = fs.readFileSync(new URL(`../${mod}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('extractReadableText'), `${mod} must never consume the readable corpus`);
    assert.ok(!src.includes('readableQuotes'), `${mod} must never import readable quote helpers`);
  }
  // RUNTIME proof on the gate-2 page: their findings contain none of the page
  // copy (only template/config labels and attribute values appear).
  const r = runBoth(ALL_FAMILIES);
  const pageCopyFragments = ['Advertise', '$29.99', 'seamless experience', 'customers served', 'We aim to', '12,000+'];
  const fpFindings = [...r.fixed.fingerprints.findings].join(' ');
  const assetFindings = [...r.fixed.assets.findings].join(' ');
  for (const frag of pageCopyFragments) {
    assert.ok(!fpFindings.includes(frag), `fingerprints must not quote page copy: ${frag}`);
    assert.ok(!assetFindings.includes(frag), `assets must not quote page copy: ${frag}`);
  }
  // COPY specifics (analyzeSpecifics examples) quote RAW text spans from the
  // ANALYSIS corpus — untouched by Option B (already raw-quote by design).
  const text = extractText(ALL_FAMILIES);
  const ex = analyzeSpecifics(text.text, text.words.length).examples;
  assert.ok(ex.some((e) => e.includes('$29.99')), 'specifics examples must keep the raw currency span');
});

// ---------------------------------------------------------------------------
// Full-pipeline integration: runScan wires the readable corpus automatically —
// the reported quote appears fixed in the scan PAYLOAD with the pinned score.
// ---------------------------------------------------------------------------
test('integration: runScan produces readable phrase receipts end-to-end; pinned slopScore 34 unchanged', () => {
  const fetcher = {
    fetchHtml: async () => ({ url: 'https://publishyoursaas.com/', status: 200, contentType: 'text/html', body: PRICE_CTA }),
  };
  return runScan({ db: { insertScan: () => {} }, fetcher, url: 'https://publishyoursaas.com/', scanBudgetMs: 8000 }).then(({ ok, payload }) => {
    assert.equal(ok, true);
    assert.equal(payload.slopScore, 34, 'investigation-pinned full-pipeline composite (Option B never feeds scores)');
    const cp = payload.breakdown.crossPage.findings;
    assert.ok(cp.some((f) => f === 'repeated phrase in the page text: 3× "Advertise now $29.99 · 30 day plan" — in 3 paragraphs'), JSON.stringify(cp));
    assert.ok(cp.some((f) => f === 'repeated phrase in the page text: 3× "Featured listing Get featured on the homepage for 30 days"'), JSON.stringify(cp));
    const rep = payload.breakdown.repetitive.findings;
    assert.ok(rep.some((f) => f.includes('"Advertise now $29.99…"')), JSON.stringify(rep));
    const bp = payload.breakdown.boilerplate.findings;
    assert.ok(bp.some((f) => f === '3× repeated block: "Featured listing"'), JSON.stringify(bp));
    // No normalized garbage reaches the payload reputation surfaces either.
    assert.ok(!JSON.stringify(cp).includes('29 99 30'), `garble in payload: ${JSON.stringify(cp)}`);
  });
});