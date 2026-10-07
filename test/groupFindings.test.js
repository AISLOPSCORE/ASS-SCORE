import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  attachSources,
  collapseSummaries,
  withinCategoryGroups,
  groupAcrossCategories,
  locatePhrase,
  componentKey,
  firstQuote,
  isAssetsAggregateLine,
  isAssetsDetailLine,
} from '../src/groupFindings.js';
import { withInsights } from '../src/threeLayer.js';
import { renderHtmlReport } from '../src/reportHtml.js';
import { pickTeasers } from '../src/paywall.js';

/**
 * ONE PROBLEM = ONE FINDING (owner 2026-10-07) — finding grouping
 * (src/groupFindings.js, DESIGN.md in /home/team/shared/finding-grouping/).
 *
 * Phase A (within-category collapse, legacy-safe): a summary/aggregate line
 * and its detail lines are ONE problem — the summary becomes the card, the
 * details become byte-identical receipts. Works on stored evidence strings
 * alone (legacy rows have no `sources`).
 *
 * Phase B (cross-category grouping, NEW scans only): every rule is text-level,
 * so `attachSources(html, breakdown)` computes `breakdown.<cat>.sources[i]`
 * post-hoc on the target page HTML — the component key of the element the
 * finding's quoted evidence points at. The report merges negative findings
 * that share a non-null src ACROSS categories into ONE card; page-level keys
 * are rejected (null) so unrelated page-shell findings never merge.
 *
 * The fixture mimics the verified publishyoursaas.com sponsor block
 * (evidence-dump.md): a unique-class section (`page-module__E0kJGG__premiumSection`)
 * containing two sibling cards (`sponsors-module__4lWqXG__sponsorCard` — the
 * class repeats, so only the section is unique). Six sponsor findings across
 * three categories + the Zinn Hub sibling must resolve to EXACTLY ONE key;
 * the nav/ad-rail phrase (page shell) and the no-quote page-pair finding must
 * resolve to null and never merge.
 */

const SPONSOR_KEY = '.page-module__E0kJGG__premiumSection';

/** The real evidence strings (evidence-dump.md ordinals in comments). */
const SPONSOR_FIXTURE = {
  boilerplate: [
    '2× repeated block: "Orbitype: The Go-to-Market Runtime"', // 2
    '2× repeated block: "Orbitype is the Go-to-Market Runtime for B2B sales automation. Install complete…"', // 3
    '2× repeated block: "Zinn Hub Freelance Marketplace"', // 4 (sibling card)
  ],
  repetitive: [
    'repeated sentence openings: 2× "Install complete systems…", 2× "Scale execution with…", 2× "Supporting 46 languages…"', // 5
    'near-identical sentences: 2× "Install complete systems for lead research, LinkedIn and ema…", 2× "Scale execution with…", 2× "Supporting 46 languages…"', // 6
    'repeated paragraphs: 2× "Orbitype: The Go-to-Market Runtime", 2× "Orbitype is the Go-to-Market Runtime for B2B sales automatio…", 2× "Zinn Hub Freelance Marketplace"', // 7
  ],
  crossPage: [
    'repeated phrase in the page text: 4× "Sponsors Premium Partners View all Sponsor O Orbitype: The Go-to-Market Runtime…" — in 4 paragraphs', // 10 — spans the section header + first card
    'repeated phrase in the page text: 6× "View pricing Contact + Advertise now $29.99 · 30 days + …"', // 8 — nav/ad-rail, page shell
    'same content on multiple pages: 1 page pair, most similar at 97.8%', // 11 — no quoted element
  ],
};

/**
 * Mimics the real DOM structure verified on publishyoursaas.com (2026-10-07):
 * - the section header + first card text only join in BOUNDARY-SPACED text
 *   (finding 10 spans them; raw textContent concatenation does not match);
 * - the h2 text is broken by an inline element with NO separating space on one
 *   side ("Orbitype: The" + "Go-to-Market Runtime") — boundary spacing is the
 *   only way the finding's quote can match;
 * - the sponsor-card class repeats (two cards) so it never keys;
 * - the nav/ad-rail text sits in an unclassed body-level element (page shell);
 * - the sponsor phrase ALSO appears inside <script> and <svg> — both must be
 *   excluded from page-text matching.
 */
const SPONSOR_HTML = `<!doctype html>
<html><head><title>Sponsors</title>
<script>var adCopy = "Orbitype: The Go-to-Market Runtime; View pricing Contact + Advertise now $29.99 · 30 days +";</script>
</head><body>
<div><span>View pricing</span> <span>Contact</span> <span>+ Advertise now</span> <span>$29.99</span> <span>·</span> <span>30 days</span> <span>+</span></div>
<div class="page-module__E0kJGG__premiumSection">
  <div class="premium-header"><span>Sponsors</span> <span>Premium Partners</span> <span>View all Sponsor</span> <span>O</span></div>
  <div class="sponsors-module__4lWqXG__sponsorCard">
    <h2>Orbitype: The<span>Go-to-Market Runtime</span></h2>
    <p class="sponsors-module__4lWqXG__description">Orbitype is the <strong>Go-to-Market Runtime</strong> for B2B sales automation. Install complete systems for lead research, LinkedIn and email outreach, and CRM updates. Scale execution with GTM teams while Supporting 46 languages across the stack.</p>
    <p>More details about Orbitype.</p>
  </div>
  <div class="sponsors-module__4lWqXG__sponsorCard">
    <h2>Zinn Hub Freelance Marketplace</h2>
    <p class="sponsors-module__4lWqXG__description">Zinn Hub connects freelance developers with product teams.</p>
  </div>
</div>
<svg><text>Orbitype is the Go-to-Market Runtime for B2B sales automation</text></svg>
</body></html>`;

/** A full scan-shaped breakdown: negative categories + clean/skipped lines. */
function sponsorBreakdown() {
  return {
    filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
    boilerplate: { score: 34, findings: [...SPONSOR_FIXTURE.boilerplate] },
    infoDensity: { score: 0, findings: ['vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)'] },
    repetitive: { score: 56, findings: [...SPONSOR_FIXTURE.repetitive] },
    crossPage: { score: 100, findings: [...SPONSOR_FIXTURE.crossPage], note: '2 pages compared' },
    fingerprints: { score: 0, findings: [] },
    assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
  };
}

/** The negatives of one category, in stored order, with their idx. */
function negativesOf(cat) {
  return SPONSOR_FIXTURE[cat].map((f, i) => ({ finding: f, insight: null, idx: i }));
}

// ===========================================================================
// Phase A — within-category collapse (works on evidence strings alone)
// ===========================================================================

test('Phase A/assets: aggregate + img[N] details collapse to ONE group with byte-identical receipts (legacy row shape, no sources)', () => {
  const findings = [
    '0 of 53 images come from stock photo sites',
    '5 of 53 images with placeholder/generic filenames',
    '0 of 53 images with missing or generic alt text',
    'img[0] generic filename "image1" (/assets/image1.jpg)',
    'img[1] generic filename "image2" (/assets/image2.jpg)',
    'img[2] generic filename "image3" (/assets/image3.jpg)',
    'img[3] generic filename "image4" (/assets/image4.jpg)',
    'img[4] generic filename "image5" (/assets/image5.jpg)',
  ];
  const negatives = findings.map((f, i) => ({ finding: f, insight: null, idx: i }));
  assert.ok(isAssetsAggregateLine('5 of 53 images with placeholder/generic filenames'), 'aggregate line shape detected');
  assert.ok(isAssetsDetailLine('img[0] generic filename "image1" (/assets/image1.jpg)'), 'detail line shape detected');
  assert.ok(!isAssetsAggregateLine('img[0] generic filename "image1"'), 'detail line is not an aggregate');

  const groups = collapseSummaries('assets', negatives);
  // Exactly ONE group: the 5-of-53 aggregate gets the 5 img[N] details as
  // receipts; the two ZERO-sibling aggregates are not negatives* — here they
  // are passed in, so they stay as their own single-item groups in stored
  // order (*the renderer only passes NEGATIVE findings; this test feeds the
  // raw list to prove zero lines never merge into the flagged aggregate).
  const spg = groups.find((g) => g.primary.finding.includes('5 of 53'));
  assert.ok(spg, 'the flagged aggregate becomes a group');
  assert.equal(spg.receipts.length, 5, 'all five img[N] detail lines fold in as receipts');
  assert.deepEqual(spg.receipts.map((r) => r.text), negatives.slice(3).map((n) => n.finding),
    'receipts are the ORIGINAL byte-identical detail strings (never edited, never reordered)');
  const leftovers = groups.filter((g) => g !== spg).map((g) => g.primary.finding);
  assert.deepEqual(leftovers, [
    '0 of 53 images come from stock photo sites',
    '0 of 53 images with missing or generic alt text',
  ], 'leftover lines stay individual cards in stored order (zero siblings + unmatched details; the 5-of-53 aggregate is the group primary)');
});

test('Phase A/assets: signal-matched aggregates stay honest — a stock-photo aggregate never swallows generic-filename details', () => {
  const findings = [
    '3 of 10 images come from stock photo sites',
    'img[0] stock photo host "shutterstock.com" (/assets/a.jpg)',
    'img[7] generic filename "image1" (/assets/image1.jpg)',
  ];
  const negatives = findings.map((f, i) => ({ finding: f, insight: null, idx: i }));
  const groups = collapseSummaries('assets', negatives);
  const stock = groups.find((g) => g.primary.finding.includes('stock photo sites'));
  assert.equal(stock.receipts.length, 1, 'stock aggregate folds in ONLY its stock-host detail');
  assert.equal(stock.receipts[0].text, findings[1], 'receipt is the byte-identical stock detail');
  assert.ok(groups.some((g) => g.primary.finding.includes('img[7]')), 'the unrelated generic-filename detail stays its own card');
});

test('Phase A/boilerplate: existing totals demotion preserved (totals folds into the FIRST card\'s receipts)', () => {
  const findings = [
    '1 generic wording match in 55 words (5.5 per 300 words)',
    '1× copyright line',
  ];
  const negatives = findings.map((f, i) => ({ finding: f, insight: null, idx: i }));
  const groups = collapseSummaries('boilerplate', negatives);
  assert.equal(groups.length, 1, 'totals line + detail = ONE group');
  assert.equal(groups[0].primary.finding, findings[1], 'the detail is the card');
  assert.deepEqual(groups[0].receipts.map((r) => r.text), [findings[0]], 'the totals line rides as a receipt');
});

test('Phase A/legacy: withinCategoryGroups without `sources` = Phase A only (no cross-category merge can happen)', () => {
  const groups = withinCategoryGroups('boilerplate', negativesOf('boilerplate'), undefined);
  assert.equal(groups.length, 3, 'legacy boilerplate rows keep one card per raw line (no src to merge on)');
  assert.equal(groups.map((g) => g.primary.finding).join('|'), SPONSOR_FIXTURE.boilerplate.join('|'),
    'primary order is the stored finding order');
});

// ===========================================================================
// Phase B — src computation (attachSources/locatePhrase/componentKey)
// ===========================================================================

test('Phase B/verified sponsor DOM: six sponsor findings + Zinn Hub resolve to EXACTLY ONE key; page-shell and no-phrase findings resolve to null', () => {
  const breakdown = sponsorBreakdown();
  attachSources(SPONSOR_HTML, breakdown);
  assert.deepEqual(breakdown.boilerplate.sources, [SPONSOR_KEY, SPONSOR_KEY, SPONSOR_KEY],
    'MESSAGING: both Orbitype lines AND the Zinn Hub sibling card land in the one unique section (finding ordinals 2,3,4)');
  assert.deepEqual(breakdown.repetitive.sources, [SPONSOR_KEY, SPONSOR_KEY, SPONSOR_KEY],
    'STRUCTURE: all three repeated-line findings land in the same section (ordinals 5,6,7)');
  assert.deepEqual(breakdown.crossPage.sources, [SPONSOR_KEY, null, null],
    'REPETITION: the section-spanning phrase keys (ordinal 10); the nav/ad-rail phrase is page-shell -> null (8); the page-pair line has no quote -> null (11)');
  // sources is ADDITIVE: findings/insights untouched, one src per finding.
  assert.deepEqual(breakdown.boilerplate.findings, SPONSOR_FIXTURE.boilerplate, 'findings stay byte-identical');
  assert.equal(breakdown.crossPage.sources.length, 3, 'sources[i] parallels findings[i]');
});

test('Phase B/flat grouping: the seven sponsor lines merge into ONE card; unrelated findings never join it', () => {
  const breakdown = sponsorBreakdown();
  attachSources(SPONSOR_HTML, breakdown);
  const cats = ['boilerplate', 'repetitive', 'crossPage'];
  const perCategory = cats.map((key) => ({
    key,
    groups: withinCategoryGroups(key, negativesOf(key), breakdown[key].sources),
    sources: breakdown[key].sources,
  }));
  const flat = groupAcrossCategories(perCategory);

  // 3 flat cards: the merged sponsor problem + the nav phrase + the page pair.
  assert.equal(flat.length, 3, '18-finding-style duplication collapses to ONE sponsor card plus two unrelated cards');
  const sponsor = flat.find((g) => g.receipts.length >= 1 || g.primary.finding.includes('repeated block:'));
  assert.equal(sponsor.key, 'boilerplate', 'the sponsor card keeps its PRIMARY category (first in the report\'s category order)');
  const members = sponsor.receipts.map((r) => r.catKey);
  assert.deepEqual(members, ['boilerplate', 'boilerplate', 'repetitive', 'repetitive', 'repetitive', 'crossPage'],
    'every member\'s original evidence rides as receipts, each labeled with ITS member category (incl. the primary\'s own within-category siblings)');
  assert.equal(sponsor.receipts.length, 6,
    '6 + Zinn Hub = 7 raw lines -> 1 card: primary line + 6 member receipts (2 MESSAGING + 3 STRUCTURE + 1 REPETITION)');
  // Receipts are the byte-identical evidence strings, never edited.
  assert.ok(sponsor.receipts.some((r) => r.text === SPONSOR_FIXTURE.repetitive[0]), 'STRUCTURE receipt verbatim');
  assert.ok(sponsor.receipts.some((r) => r.text === SPONSOR_FIXTURE.crossPage[0]), 'REPETITION receipt verbatim');
  // Nothing unrelated merged: the nav phrase (src null) and the no-quote line
  // are separate cards, and their sticky evidence is their own only.
  const nav = flat.find((g) => g.primary.finding.includes('View pricing'));
  assert.ok(nav && nav.receipts.length === 0 && nav.key === 'crossPage', 'page-shell finding stays its own card');
  const pair = flat.find((g) => g.primary.finding.includes('page pair'));
  assert.ok(pair && pair.receipts.length === 0 && pair.key === 'crossPage', 'no-quote finding stays its own card');
});

test('Phase B/within-category merging: same-src lines collapse inside a category too (the breakdown/focused-view view)', () => {
  const breakdown = sponsorBreakdown();
  attachSources(SPONSOR_HTML, breakdown);
  const boilerplate = withinCategoryGroups('boilerplate', negativesOf('boilerplate'), breakdown.boilerplate.sources);
  const crossPage = withinCategoryGroups('crossPage', negativesOf('crossPage'), breakdown.crossPage.sources);
  assert.equal(boilerplate.length, 1, 'MESSAGING: 3 sponsor lines -> 1 within-category card');
  assert.equal(boilerplate[0].receipts.length, 2, 'the two later sponsor lines fold into that card\'s receipts');
  assert.equal(crossPage.length, 3, 'REPETITION: only the same-src lines merge (sponsor phrase stays 1; nav + page pair are their own cards)');
});

test('Phase B/unit: boundary-spaced phrase location (raw textContent would not match the no-separator h2)', () => {
  const $ = cheerio.load(SPONSOR_HTML);
  const h2 = $('h2').first()[0];
  // The h2 is "Orbitype: The" + <span>"Go-to-Market Runtime"</span> — raw
  // textContent concatenates to "Orbitype: TheGo-to-Market Runtime"; only
  // boundary-spaced text contains the finding's quoted phrase.
  assert.equal($(h2).text(), 'Orbitype: TheGo-to-Market Runtime', 'fixture really exercises boundary spacing');
  const texts = new Map();
  $('*').each((_, el) => {
    const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;
    // Reuse the module's own boundary text via locatePhrase's caller behavior:
    // we re-derive with the same normalization the module uses.
    const parts = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (!child) continue;
        if (child.type === 'text') {
          const t = String(child.data ?? '').replace(/\s+/g, ' ');
          if (t) parts.push(t);
        } else if (child.type === 'tag' || child.type === 'script') {
          if (['script', 'style', 'noscript', 'template', 'svg'].includes(String(child.tagName ?? child.name ?? '').toLowerCase())) continue;
          parts.push(' ');
          walk(child);
          parts.push(' ');
        }
      }
    };
    walk(el);
    texts.set(el, String(parts.join(' ')).replace(/\s+/g, ' ').trim());
  });
  const el = locatePhrase('Orbitype: The Go-to-Market Runtime', $, texts);
  assert.ok(el, 'phrase located in the boundary-spaced DOM');
  assert.equal(el.tagName, 'h2', 'leaf-most match is the h2 itself');
  const counts = new Map();
  $('*').each((_, e) => {
    const id = $(e).attr('id');
    if (id) counts.set(`#${id}`, (counts.get(`#${id}`) ?? 0) + 1);
    const cls = $(e).attr('class');
    if (cls) for (const c of String(cls).split(/\s+/).filter(Boolean)) counts.set(`.${c}`, (counts.get(`.${c}`) ?? 0) + 1);
  });
  assert.equal(componentKey(el, $, counts), SPONSOR_KEY,
    'component key = the FIRST unique-classed ancestor (the repeated sponsorship-card class is skipped)');
});

test('Phase B/unit: script/svg text is excluded — a phrase only in script/svg resolves to null', () => {
  const html = '<html><body><script>var s = "secret phrase inside a script tag"</script><svg><text>secret phrase inside an svg tag</text></svg></body></html>';
  const $ = cheerio.load(html);
  const texts = new Map();
  $('*').each((_, el) => { texts.set(el, 'x'); });
  // The module excludes script/svg/template/noscript from its text map, so a
  // phrase that exists ONLY in those containers is not locatable anywhere.
  const breakdown = { boilerplate: { findings: ['1× secret phrase "secret phrase inside a script tag"'] } };
  attachSources(html, breakdown);
  assert.equal(breakdown.boilerplate.sources[0], null, 'script-only phrase -> src null (never a component)');
  // And the same for a real locatePhrase call with an empty visible document.
  assert.equal(locatePhrase('secret phrase inside an svg tag', $, new Map()), null,
    'svg-only phrase is not page text');
});

test('Phase B/unit: leaf-most + first-in-document-order key choice', () => {
  // Two identical <p> at the same depth: the FIRST in document order wins.
  // Inside the first <p>, a nested <span> also contains the phrase: the span
  // is the LEAF (deepest) and wins over the <p>.
  const html = '<html><body><div class="alpha"><p>alpha beta <span class="leaf">shared phrase</span></p></div><div class="beta"><p>shared phrase</p></div></body></html>';
  const $ = cheerio.load(html);
  const texts = new Map();
  $('*').each((_, el) => {
    const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;
    texts.set(el, $(el).text().replace(/\s+/g, ' ').trim());
  });
  const el = locatePhrase('shared phrase', $, texts);
  assert.equal(el.tagName, 'span', 'leaf-most match (the span inside the first p) wins');
  const counts = new Map();
  $('*').each((_, e) => {
    const cls = $(e).attr('class');
    if (cls) for (const c of String(cls).split(/\s+/).filter(Boolean)) counts.set(`.${c}`, (counts.get(`.${c}`) ?? 0) + 1);
  });
  assert.equal(componentKey(el, $, counts), '.leaf', 'the span\'s unique class keys it');
});

test('Phase B/unit: page-level keys rejected — an unclassed body-level phrase resolves to null', () => {
  const $ = cheerio.load('<html><body><div><p>Hello world and beyond the pale horizon</p></div></body></html>'.replace('<div>', '<div><div>'));
  const texts = new Map();
  $('*').each((_, el) => {
    const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;
    texts.set(el, $(el).text().replace(/\s+/g, ' ').trim());
  });
  const el = locatePhrase('Hello world and beyond the pale horizon', $, texts);
  assert.ok(el, 'phrase located');
  const counts = new Map();
  const breakdown = { boilerplate: { findings: ['1× hallway phrase "Hello world and beyond the pale horizon"'] } };
  attachSources('<html><body><div><div><p>Hello world and beyond the pale horizon</p></div></div></body></html>', breakdown);
  assert.equal(breakdown.boilerplate.sources[0], null,
    'no unique id/class until <body> -> src null (page-shell keys never merge)');
  assert.equal(el.tagName, 'p', 'the leaf is the paragraph (depth check sanity)');
});

// ===========================================================================
// Determinism + surfaces (fresh scan object WITH sources, full report render)
// ===========================================================================

function freshScan() {
  const breakdown = sponsorBreakdown();
  attachSources(SPONSOR_HTML, breakdown);
  return {
    id: 'group-surfaces-0001',
    url: 'https://fixture.example/',
    score: 57,
    created_at: '2026-10-07T00:00:00.000Z',
    breakdown: withInsights(breakdown, 'group-surfaces-0001'),
  };
}

test('determinism: same html + same findings -> identical sources; two renders of the same scan -> byte-identical HTML', () => {
  const a = sponsorBreakdown();
  const b = sponsorBreakdown();
  attachSources(SPONSOR_HTML, a);
  attachSources(SPONSOR_HTML, b);
  assert.deepEqual(a, b, 'attachSources is deterministic (findings + insights byte-identical)');
  const s1 = freshScan();
  const h1 = renderHtmlReport(s1);
  const h2 = renderHtmlReport(s1);
  assert.equal(h1, h2, 'same scan object -> byte-identical grouped report');
  // Re-running on an already-sourced copy must not change anything.
  const s2 = freshScan();
  attachSources(SPONSOR_HTML, s2.breakdown);
  assert.equal(renderHtmlReport(s2), h1, 'attachSources is idempotent over its own output');
});

test('surfaces agree: intro/ordinals/cards, breakdown counts, fix-first length and teasers all derive from the grouped set', () => {
  const scan = freshScan();
  const html = renderHtmlReport(scan);
  const flat = html.slice(html.indexOf('<div class="cat-sources" hidden>'), html.indexOf('<section class="cat-view"', html.indexOf('<div class="cat-sources" hidden>')));
  // THE ACTUAL FINDINGS: the flat list = 3 grouped problems (sponsor section,
  // nav phrase, page pair) — the flat intro counts THOSE, not the raw lines.
  // "across 2 categories": the flat set spans MESSAGING (sponsor card) +
  // REPETITION (nav + page pair); STRUCTURE's cards all merged into the
  // sponsor card, so STRUCTURE has no flat card of its own (design rule: the
  // intro's M uses the GROUPED flat set, see DESIGN.md "Fork / decisions").
  assert.ok(flat.includes('id="finding-'), 'cat-sources cards carry deep-link finding ids');
  assert.equal((flat.match(/<div class="finding-card"/g) ?? []).length, 3, 'exactly 3 flat cards');
  assert.ok(flat.includes('Finding 1') && flat.includes('Finding 2') && flat.includes('Finding 3'),
    'global ordinals over the grouped set');
  // The sponsor card: primary evidence + category-labeled member receipts.
  const sponsorCard = flat.slice(flat.indexOf('<div class="finding-card">'), flat.indexOf('<div class="finding-card">', flat.indexOf('<div class="finding-card">') + 1));
  assert.ok(sponsorCard.includes('2× repeated block: &quot;Orbitype: The Go-to-Market Runtime&quot;'),
    'sponsor card primary evidence is the first member\'s line');
  assert.ok(sponsorCard.includes('STRUCTURE — repeated sentence openings: 2× &quot;Install complete systems…&quot;'),
    'STRUCTURE member evidence rides labeled with its category');
  assert.ok(sponsorCard.includes('REPETITION — repeated phrase in the page text: 4× &quot;Sponsors Premium Partners View all Sponsor O Orbitype: The Go-to-Market Runtime…&quot;'),
    'REPETITION member evidence rides labeled with its category');
  // The card's receipt drawer shows the real line count: 1 primary evidence
  // line + 6 member receipts.
  assert.ok(sponsorCard.includes('7 lines of evidence'), 'sponsor card receipts drawer counts primary + member evidence');
  // YOUR BREAKDOWN: per-category GROUPED counts (within-category merges only).
  assert.ok(html.includes('1 roast — see receipts'), 'MESSAGING + STRUCTURE breakdown cards each show 1 grouped roast');
  assert.ok(html.includes('3 roasts — see receipts'), 'REPETITION breakdown card shows its 3 within-category groups');
  // WHAT TO FIX FIRST: one ranked item per grouped problem (3, capped at 5).
  const fix = html.slice(html.indexOf('What To Fix First'), html.indexOf('Your Breakdown'));
  assert.equal((fix.match(/<li class="fix-item/g) ?? []).length, 3, 'fix-first lists the 3 grouped problems, not the 9 raw lines');
  // Final Verdict conclusion uses the grouped count (score 57 = VERY ASSY).
  assert.ok(html.includes('in a list of 3 findings'), 'verdict conclusion counts the grouped set');
});

test('teasers: src-dedupe — never two free samples for one grouped problem; src never leaks into the teaser payload', () => {
  const scan = freshScan();
  const teasers = pickTeasers(scan.breakdown, scan.id);
  assert.ok(teasers.length >= 1 && teasers.length <= 2, 'teasers drawn from the WATCH+ categories');
  const srcs = [];
  for (const t of teasers) {
    assert.ok(!('src' in t), 'component keys never leak to the free tier (teaser shape unchanged)');
    // Re-derive the src of the teaser's evidence from the stored sources.
    const entry = Object.entries(scan.breakdown).find(([k]) => k === t.key);
    const idx = (entry[1].findings ?? []).findIndex((f) => String(f) === String(t.evidence));
    srcs.push(idx >= 0 ? (entry[1].sources ?? [])[idx] ?? null : null);
  }
  const nonNull = srcs.filter((s) => s !== null);
  assert.equal(new Set(nonNull).size, nonNull.length,
    'grouping: no two teasers name the same component (one grouped problem = one free sample)');
  // The paid report and the free payload tell the same story: with the sponsor
  // block collapsed in the paid flat list, the teaser evidence for the
  // sponsor problem appears at most once among the samples.
  const flatCardEvidence = new Set([
    '2× repeated block: "Orbitype: The Go-to-Market Runtime"',
    ...SPONSOR_FIXTURE.repetitive,
    SPONSOR_FIXTURE.crossPage[0],
  ]);
  const sponsorEvidence = teasers.filter((t) => flatCardEvidence.has(t.evidence));
  assert.ok(sponsorEvidence.length <= 1, 'at most ONE sample from the merged sponsor problem');
});

test('clean fixture unchanged: a clean scan (no negatives) renders exactly the same no-roast markers', () => {
  const scan = {
    id: 'group-clean-0001',
    url: 'https://fixture.example/',
    score: 0,
    created_at: '2026-10-07T00:00:00.000Z',
    breakdown: {
      filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
      infoDensity: { score: 0, findings: ['vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: ['no recognizable template signs detected'] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
  };
  const html = renderHtmlReport(scan);
  assert.ok(html.includes('<div class="cat-sources" hidden>'), 'clone-source present on a clean scan');
  assert.ok(!html.includes('<div class="finding-card">'), 'no finding cards on a clean scan');
  assert.ok(!html.includes('How to fix it:'), 'no fix tasks on a clean scan');
});

test('firstQuote: the evidence-quote extractor used by sources never misreads a no-quote line', () => {
  assert.equal(firstQuote('2× repeated block: "Orbitype: The Go-to-Market Runtime"'), 'Orbitype: The Go-to-Market Runtime');
  assert.equal(firstQuote('same content on multiple pages: 1 page pair, most similar at 97.8%'), null);
  assert.equal(firstQuote(''), null);
});