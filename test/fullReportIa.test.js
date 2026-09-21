import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { verdictBand } from '../src/verdict.js';
import { classifyFinding, buildCategoryInsights } from '../src/threeLayer.js';
import { CATEGORY_LABELS } from '../src/categories.js';
import { openDb } from '../src/db.js';

/**
 * Full Report Phase 1 — content architecture (owner spec 2026-09-17 §13).
 *
 * These 8 tests assert the finding SEMANTICS of the paid full report:
 *   1. Clean site -> zero negative findings.
 *   2. Clean detector -> no negative roast.
 *   3. Real negative detector -> full four-part finding (roast / why / fix /
 *      receipts) with evidence.
 *   4. Metric below threshold -> no negative finding.
 *   5. Multiple negative categories -> only actual problems counted.
 *   6. Single-page site -> correct page handling ("this is the only page
 *      scanned.").
 *   7. Multi-page site -> correct page prioritization.
 *   8. Score direction remains 0 best / 100 worst.
 *
 * They render the REAL paid report (token'd /api/v1/scans/:id?token=…) from
 * fixture rows inserted straight into a temp SQLite DB — no live-site scans.
 */
const SECRET = 'full-report-ia-test-secret';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-')), 'test.db');

/** Dummy fetcher — never used here (fixture rows are inserted directly). */
const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Insert a scan row directly through the app's own db wrapper. */
async function insertScan(dbPath, { id, url = 'https://fixture.example/', score, breakdown, createdAt = '2026-09-17T12:00:00.000Z', worstPage = null }) {
  const repository = openDb(dbPath);
  repository.insertScan({ id, url, score, breakdown, createdAt, worstPage: worstPage ?? undefined });
  repository.close();
}

/** Fetch the token'd paid report HTML for a scan id. */
async function paidHtml(base, id) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200, 'paid report serves 200 with a valid token');
  return res.text();
}

const CLEAN_BREAKDOWN = {
  filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
  infoDensity: { score: 0, findings: [
    'vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)',
    'stopword ratio: 32.0%',
    'mean sentence length: 18.0 words (6 sentences)',
    'short paragraphs (<25 words): 0% (3 paragraphs)',
  ] },
  repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
};

/**
 * Sloppy fixture — 89/100 EXTREMELY ASS, every card state represented (PRIORITY
 * red, NEEDS ATTENTION orange, WATCH amber, CLEAN green, skipped gray) so the
 * Phase 2A dashboard shell tests cover all classes the existing classification
 * can produce.
 */
const SLOPPY_BREAKDOWN_89 = {
  filler: { score: 88, findings: ['3× "cutting-edge"', '2× "seamless"'] },
  boilerplate: { score: 62, findings: ['1× hedge phrase "we aim to"'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};

test('1. clean site -> zero negative findings in the full report', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'ia-clean-0001', score: 0, breakdown: CLEAN_BREAKDOWN });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-clean-0001');
    // No roast-styled layer, no fix labels anywhere.
    assert.equal((paid.match(/<p class="ins-roast">/g) ?? []).length, 0, 'no negative roast paragraphs');
    assert.ok(!paid.includes('How to fix it:'), 'no negative finding structure');
    // Summary counts zero negative findings.
    assert.ok(paid.includes('No findings this scan — nothing to roast, and nothing to hide.'),
      'findings intro counts zero negatives');
    // WHAT'S WORKING carries the clean compliments (positive results only).
    assert.ok(paid.includes("What's Working"), 'What\'s Working section present');
    assert.ok(paid.includes('COPY — CLEAN:'), 'clean COPY result listed as CLEAN');
    assert.ok(paid.includes('MESSAGING — CLEAN:'), 'clean MESSAGING result listed as CLEAN');
    assert.ok(paid.includes('ORIGINALITY — CLEAN:'), 'clean ORIGINALITY metric listed as CLEAN');
    // Fix-first is empty for a clean scan.
    assert.ok(paid.includes('No negative findings to fix this scan'), 'fix-first lists nothing');
    // Single page handling + no Score id metadata.
    assert.ok(paid.includes('this is the only page scanned.'), 'single-page note present');
    assert.ok(!paid.includes('Score id'), 'no Score id UUID in the footer');
  } finally {
    app.server.close();
  }
});

test('2. clean detector -> no negative roast (classifyFinding routes every clean evidence to clean)', () => {
  // In-band/zero measurements across the detectors that HAVE a clean format
  // must classify as 'clean' — never 'negative' — and derive clean compliments.
  const cleanEvidence = {
    filler: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'],
    boilerplate: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'],
    infoDensity: [
      'vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)',
      'stopword ratio: 32.0%',
      'mean sentence length: 18.0 words (6 sentences)',
      'short paragraphs (<25 words): 0% (3 paragraphs)',
    ],
    repetitive: ['no notable repetitive structure (6 sentences, 3 paragraphs)'],
    assets: ['0 of 2 images flagged for stock/placeholder signals'],
  };
  for (const [cat, lines] of Object.entries(cleanEvidence)) {
    const ins = buildCategoryInsights({ category: cat, findings: lines, id: 'clean-detector' });
    lines.forEach((f, i) => {
      assert.equal(classifyFinding(cat, f, ins[i]), 'clean', `${cat}: clean evidence never classified negative`);
      assert.equal(ins[i].kind, 'clean', `${cat}: derived as a compliment, not a roast`);
    });
  }
  // fingerprints has no clean evidence format (no findings when clean).
  assert.equal(classifyFinding('fingerprints', 'anything not a metric/clean line', null), 'negative',
    'a real negative pattern still classifies negative');
});

test('3. real negative detector -> full four-part finding with evidence', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'ia-neg-0001',
    score: 50,
    breakdown: {
      filler: { score: 50, findings: ['3× "cutting-edge"'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
      infoDensity: { score: 0, findings: ['vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: [] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-neg-0001');
    // Exactly one negative finding -> exactly one four-part finding.
    assert.equal((paid.match(/<p class="ins-roast">/g) ?? []).length, 1, 'one roast layer for the one negative finding');
    assert.ok(paid.includes('Why it matters:'), 'WHY IT MATTERS label present');
    assert.ok(paid.includes('How to fix it:'), 'HOW TO FIX IT label present');
    assert.ok(paid.includes('Show the receipts:'), 'THE RECEIPTS label present');
    assert.ok(paid.includes('3× &quot;cutting-edge&quot;'), 'evidence/receipt shows the real trigger');
    assert.ok(paid.includes('1 finding across 1 category — every roast points at the receipts below.'),
      'summary counts the single negative finding only (compliments ignored)');
  } finally {
    app.server.close();
  }
});

test('4. metric below threshold -> no negative finding (neutral evidence only)', async () => {
  const dbPath = tmpDb();
  // infoDensity with ONLY out-of-band metric readings and no concrete-specifics
  // gap: the detector scored it 30, but there is no NAMED negative finding —
  // metrics must render as neutral measurements, never a finding/roast/count.
  await insertScan(dbPath, {
    id: 'ia-metric-0001',
    score: 30,
    breakdown: {
      filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
      infoDensity: { score: 30, findings: [
        'vocabulary diversity (MATTR-50): 0.766 (lower = more repetitive vocabulary)',
        'stopword ratio: 46.0%',
        'mean sentence length: 28.4 words (12 sentences)',
        'short paragraphs (<25 words): 60% (20 paragraphs)',
      ] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: [] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-metric-0001');
    // The metric readings produce NO negative finding and NO count.
    assert.equal((paid.match(/<p class="ins-roast">/g) ?? []).length, 0, 'no negative roast from metrics');
    assert.ok(!paid.includes('How to fix it:'), 'no fix task manufactured from a metric');
    assert.ok(paid.includes('No findings this scan'), 'summary counts zero negative findings');
    // The metrics ARE shown as neutral evidence, clearly labelled.
    assert.ok(paid.includes('Measurements:'), 'metric readings render as neutral measurements');
    assert.ok(paid.includes('vocabulary diversity (MATTR-50): 0.766'), 'MATTR reading present as evidence');
    // The detector score still communicates (band), but never as a fabricated finding.
    assert.ok(paid.includes('GETTING ASSY'), 'score band reflects the detector signal');
  } finally {
    app.server.close();
  }
});

test('5. multiple negative categories -> only actual problems counted', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'ia-multi-0001',
    score: 60,
    breakdown: {
      filler: { score: 50, findings: ['3× "cutting-edge"', '2× "seamless"'] },
      boilerplate: { score: 40, findings: ['1× hedge phrase "we aim to"'] },
      infoDensity: { score: 30, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: [] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-multi-0001');
    // Negatives: filler(2) + boilerplate(1) + infoDensity(1) = 4 across 3 cats.
    // The clean repetitive + assets lines are NOT findings and are NOT counted.
    assert.ok(paid.includes('4 findings across 3 categories — every roast points at the receipts below.'),
      'summary counts only actual negative findings');
    assert.ok(!paid.includes('6 findings across 5 categories'), 'compliments are never counted as findings');
    assert.equal((paid.match(/<p class="ins-roast">/g) ?? []).length, 4, 'four negative roast layers rendered');
  } finally {
    app.server.close();
  }
});

test('6. single-page site -> correct page handling', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'ia-single-0001',
    score: 60,
    breakdown: {
      filler: { score: 60, findings: ['3× "cutting-edge"'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
      infoDensity: { score: 0, findings: ['vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: [] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-single-0001');
    assert.ok(paid.includes('this is the only page scanned.'), 'single-page note present');
    const pageSection = paid.slice(paid.indexOf('Page That Needs The Most Work'), paid.indexOf('What To Fix First'));
    assert.ok(pageSection.includes('Homepage'), 'names the homepage');
    assert.ok(pageSection.includes('COPY'), 'summarizes the actual finding on the homepage');
    assert.ok(!pageSection.includes('ORIGINALITY'), 'does not invent findings that are not negative');
  } finally {
    app.server.close();
  }
});

test('7. multi-page site -> correct page prioritization', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'ia-worst-0001',
    score: 70,
    breakdown: {
      filler: { score: 60, findings: ['3× "cutting-edge"'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
      infoDensity: { score: 0, findings: ['vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
      crossPage: { score: 40, findings: ['no page pairs above 80% similarity (2 pages compared)'], pages: ['https://a.example/', 'https://worst.example/about'] },
      fingerprints: { score: 0, findings: [] },
      assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
    },
    worstPage: {
      url: 'https://worst.example/about',
      score: 80,
      // First finding is a real negative; the second is a METRIC measurement
      // that must NEVER be presented as a page problem.
      findings: ['3× "cutting-edge"', 'vocabulary diversity (MATTR-50): 0.766 (lower = more repetitive vocabulary)'],
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ia-worst-0001');
    const pageSection = paid.slice(paid.indexOf('Page That Needs The Most Work'), paid.indexOf('What To Fix First'));
    assert.ok(pageSection.includes('https://worst.example/about'), 'names the worst page URL');
    assert.ok(pageSection.includes('COPY'), 'lists the actual negative finding (COPY)');
    assert.ok(!pageSection.includes('ORIGINALITY'), 'metric reading is not presented as a page problem');
    assert.ok(!pageSection.includes('0.766'), 'metric value is not listed as a finding on the worst page');
  } finally {
    app.server.close();
  }
});

test('8. score direction remains 0 best / 100 worst', async () => {
  // Locked direction: 0 = best/cleanest, 100 = worst. A low score is never
  // described as poor; a high score is.
  assert.equal(verdictBand(0).shortLabel, 'CLEANEST', '0 -> CLEANEST');
  assert.equal(verdictBand(7).shortLabel, 'CLEANEST', '7 -> CLEANEST');
  assert.equal(verdictBand(100).shortLabel, 'CATASTROPHICALLY ASS', '100 -> CATASTROPHICALLY ASS');

  // Low-score report (0): clean findings, positive final verdict, no "poor".
  const dbLow = tmpDb();
  await insertScan(dbLow, { id: 'ia-dir-low', score: 0, breakdown: CLEAN_BREAKDOWN });
  const appLow = startApp(dbLow);
  try {
    const low = await paidHtml(appLow.base, 'ia-dir-low');
    assert.ok(low.includes('CLEANEST'), 'low score shows the cleanest grade');
    assert.ok(low.includes('this is what a good website looks like'), 'final verdict praises the low score');
    assert.ok(!/poor/i.test(low) && !/bad\b/i.test(low), 'a low score is never described as poor/bad');
  } finally {
    appLow.server.close();
  }

  // High-score report (93): catastrophic band, the verdict calls it bad.
  const dbHigh = tmpDb();
  await insertScan(dbHigh, {
    id: 'ia-dir-high',
    score: 93,
    breakdown: {
      filler: { score: 95, findings: ['3× "cutting-edge"'] },
      boilerplate: { score: 95, findings: ['1× hedge phrase "we aim to"'] },
      infoDensity: { score: 95, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
      repetitive: { score: 90, findings: ['repeated sentence openings: 5× "the company"'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 90, findings: ['pattern evidence in html: v0.dev builder assets (high confidence, template-like signal)'] },
      assets: { score: 90, findings: ['2 of 2 images from stock/placeholder CDNs'] },
    },
  });
  const appHigh = startApp(dbHigh);
  try {
    const high = await paidHtml(appHigh.base, 'ia-dir-high');
    assert.ok(high.includes('CATASTROPHICALLY ASS'), 'high score shows the catastrophic grade');
    assert.ok(high.includes('badge nobody asked for'), 'final verdict calls the high score bad');
  } finally {
    appHigh.server.close();
  }
});

// ============================================================================
// Phase 2A — dashboard shell (presentation/UI rework, owner 2026-09-17).
// UI-only assertions: the shell (hero, cards, anchors, hierarchy) renders
// around the Phase 1 content WITHOUT changing score/verdict/disclaimer values.
// ============================================================================

test('P2A.1: hero shows the scan score + verdict unchanged and the mandated disclaimer is present (clean 7 / sloppy 89)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2a-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2a-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const clean = await paidHtml(app.base, 'p2a-clean');
    assert.ok(clean.includes('A.S.S. Score: 7 / 100'), 'clean hero shows score 7');
    assert.ok(clean.includes('CLEANEST'), 'clean hero shows the CLEANEST band');
    assert.ok(clean.includes('does not detect AI authorship'), 'exact disclaimer on clean report');

    const sloppy = await paidHtml(app.base, 'p2a-sloppy');
    assert.ok(sloppy.includes('A.S.S. Score: 89 / 100'), 'sloppy hero shows score 89');
    assert.ok(sloppy.includes('EXTREMELY ASS'), 'sloppy hero shows the EXTREMELY ASS band');
    assert.ok(sloppy.includes('does not detect AI authorship'), 'exact disclaimer on sloppy report');
  } finally {
    app.server.close();
  }
});

test('P2A.2: all 7 category cards render as <a> links, each href="#…" targeting an id that exists on the same page', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2a-cards', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2a-cards');
    const hrefs = [...html.matchAll(/<a class="cat-card[^"]*" href="#(cat-[a-z]+)">/g)].map((m) => m[1]);
    assert.deepEqual(hrefs,
      ['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets'],
      'exactly the 7 existing categories as cards, engine key order');
    for (const anchor of hrefs) {
      assert.ok(html.includes(`id="${anchor}"`), `card href "#${anchor}" has a matching in-page id`);
    }
    // The 7 customer-facing names all appear (cards + detail sections).
    for (const name of ['COPY', 'MESSAGING', 'ORIGINALITY', 'STRUCTURE', 'REPETITION', 'DESIGN', 'IMAGERY']) {
      assert.ok(html.includes(name), `category name ${name} appears on the page`);
    }
  } finally {
    app.server.close();
  }
});

test('P2A.3: card numbers/states come from the existing classification (state classes + unchanged values)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2a-states', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2a-states');
    // State colors are driven by categoryClass on the stored sub-scores.
    assert.ok(html.includes('class="cat-card cat-priority"'), 'high sub-score renders a PRIORITY (red) card');
    assert.ok(html.includes('class="cat-card cat-attention"'), 'mid sub-score renders a NEEDS ATTENTION (orange) card');
    assert.ok(html.includes('class="cat-card cat-watch"'), 'low sub-score renders a WATCH (amber) card');
    assert.ok(html.includes('class="cat-card cat-clean"'), 'zero sub-score renders a CLEAN (green) card');
    assert.ok(html.includes('class="cat-card cat-skipped"'), 'null sub-score renders a neutral (gray) skipped card');
    // Existing values are shown verbatim: score numbers and state labels.
    for (const score of ['88', '62', '90', '30', '0', '82']) {
      assert.ok(html.includes(`<span class="cat-score">${score}<span class="cat-den">/100</span></span>`),
        `card shows the existing sub-score ${score}/100`);
    }
    for (const state of ['PRIORITY', 'NEEDS ATTENTION', 'WATCH', 'CLEAN']) {
      assert.ok(html.includes(`<span class="cat-state">${state}</span>`), `card shows state ${state}`);
    }
    assert.ok(html.includes('insufficient pages for cross-page analysis'),
      'skipped card surfaces the stored note (REPETITION on a single-page scan)');
  } finally {
    app.server.close();
  }
});

test('P2A.4: dashboard section hierarchy — hero → verdict → breakdown → working → findings → page → fix → final → methodology', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2a-order', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2a-order');
    const idx = (s) => html.indexOf(s);
    const seq = ['A.S.S. Score: 89 / 100', 'The Verdict', 'Your Breakdown', "What's Working",
      'The Actual Findings', 'Page That Needs The Most Work', 'What To Fix First', 'Final Verdict', 'Methodology'];
    let prev = -1;
    for (const marker of seq) {
      const at = idx(marker);
      assert.ok(at > prev, `"${marker}" appears after the previous section (at ${at}, expected > ${prev})`);
      prev = at;
    }
    // The category detail anchors live inside the findings area (after the cards).
    const firstCard = html.indexOf('<a class="cat-card');
    const firstDetail = html.indexOf('id="cat-');
    assert.ok(firstCard >= 0 && firstDetail > firstCard, 'category detail targets sit lower on the page than the cards');
  } finally {
    app.server.close();
  }
});

// ============================================================================
// Phase 2B — diagnostic finding cards (owner 2026-09-17 2B spec).
// Presentation/UI only: each NEGATIVE finding renders as ONE clearly separated
// `.finding-card` with the four labeled zones ROAST / WHY IT MATTERS / HOW TO
// FIX IT / RECEIPTS. Neutral metric measurements stay "Measurements:" blocks,
// never cards; clean reports have zero cards. Finding order and every content
// string are unchanged from the fixture.
// ============================================================================

/** The renderer's esc() (src/routes/scans.js) — mirrored so tests can assert
 * the verbatim receipt text as it actually appears in the HTML. */
function escForTest(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Expected NEGATIVE findings in engine (Object.entries) order — recomputed
 * with the SAME classifyFinding the renderer uses, so the expected list is
 * derived from the fixture, never hand-maintained. */
function negativeFindings(breakdown) {
  const out = [];
  for (const [key, rule] of Object.entries(breakdown)) {
    const findings = Array.isArray(rule?.findings) ? rule.findings : [];
    const insights = Array.isArray(rule?.insights) ? rule.insights : [];
    findings.forEach((f, i) => {
      if (classifyFinding(key, String(f), insights[i]) === 'negative') out.push({ key, finding: String(f) });
    });
  }
  return out;
}

/** Isolate each `.finding-card` region of the report (from its opening tag to
 * just before the next card's opening tag) so per-card assertions can run. */
function cardRegions(html) {
  const starts = [...html.matchAll(/<div class="finding-card">/g)].map((m) => m.index);
  const regions = [];
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : html.length;
    regions.push(html.slice(starts[i], to));
  }
  return regions;
}

test('P2B.1: every negative finding renders as its own diagnostic card — count equals the fixture negatives, order matches input order, four labeled zones with verbatim receipts', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2b-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2b-sloppy');
    const expected = negativeFindings(SLOPPY_BREAKDOWN_89);
    const regions = cardRegions(html);

    // Count equals the fixture's negative finding list.
    assert.equal(regions.length, expected.length,
      `one card per negative finding (expected ${expected.length}, got ${regions.length})`);
    // The roast layer count mirrors the card count (one roast per card).
    assert.equal((html.match(/<p class="ins-roast">/g) ?? []).length, expected.length,
      'one roast layer per negative finding');

    // Order matches the input order, and every card carries the four labeled
    // zones with its own verbatim receipt text.
    for (let i = 0; i < expected.length; i++) {
      const card = regions[i];
      const exp = expected[i];
      const label = CATEGORY_LABELS[exp.key] ?? exp.key;
      assert.ok(card.includes('The Roast'), `card ${i + 1} has a Roast zone`);
      assert.ok(card.includes('Why it matters:'), `card ${i + 1} has a Why It Matters zone`);
      assert.ok(card.includes('How to fix it:'), `card ${i + 1} has a How To Fix It zone`);
      assert.ok(card.includes('Show the receipts:'), `card ${i + 1} has a Receipts zone`);
      assert.ok(card.includes('<p class="ins-roast">'), `card ${i + 1} renders a roast paragraph`);
      assert.ok(card.includes(label), `card ${i + 1} shows its category context (${label})`);
      assert.ok(card.includes(escForTest(exp.finding)),
        `card ${i + 1} keeps the verbatim receipt (${exp.finding})`);
      assert.ok(card.includes('Finding ' + (i + 1)), `card ${i + 1} shows its ordinal`);
    }

    // Order sanity: the fixture's receipt strings appear in the same sequence.
    const receiptSeq = expected.map((e) => escForTest(e.finding));
    let prev = -1;
    for (const r of receiptSeq) {
      const at = html.indexOf(r);
      assert.ok(at > prev, `receipt "${r}" appears after the previous card`);
      prev = at;
    }

    // A high-finding report separates cards visually — each card is bounded.
    assert.ok(html.includes('class="finding-card"'), 'finding-card container class present');
    // Severity badge comes from the existing classification (filler 88 = PRIORITY).
    assert.ok(html.includes('class="fc-state fc-state-priority"'), 'PRIORITY badge from category classification');
    assert.ok(!html.includes('"><'), 'no raw quote-bracket sequence anywhere (sacred markup constraint)');
  } finally {
    app.server.close();
  }
});

test('P2B.2: neutral metric measurements are NOT cards — a metric-only category stays a Measurements block', async () => {
  const dbPath = tmpDb();
  // infoDensity carries ONLY out-of-band metric readings (no concrete-specifics
  // gap) -> zero negative findings there. filler is the one real negative.
  // The SAME breakdown drives both the insert and the expected-negative
  // computation (full canonical metric lines, exactly as the detectors emit).
  const P2B_METRIC_BREAKDOWN = {
    filler: { score: 50, findings: ['3× "cutting-edge"'] },
    boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
    infoDensity: { score: 30, findings: [
      'vocabulary diversity (MATTR-50): 0.766 (lower = more repetitive vocabulary)',
      'stopword ratio: 46.0%',
      'mean sentence length: 28.4 words (12 sentences)',
      'short paragraphs (<25 words): 60% (20 paragraphs)',
    ] },
    repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
    crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
    fingerprints: { score: 0, findings: [] },
    assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
  };
  await insertScan(dbPath, { id: 'p2b-metric', score: 50, breakdown: P2B_METRIC_BREAKDOWN });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2b-metric');
    const expected = negativeFindings(P2B_METRIC_BREAKDOWN);
    assert.equal(expected.length, 1, 'fixture has exactly one negative (filler)');
    // Exactly one card — the metric-only category is NOT a finding card.
    assert.equal(cardRegions(html).length, 1, 'only the real negative becomes a card');
    // The metric measurements render as a neutral Measurements block, not a card.
    const infoSection = html.slice(html.indexOf('id="cat-infodensity"'), html.indexOf('id="cat-repetitive"'));
    assert.ok(infoSection.includes('Measurements:'), 'metric-only category shows Measurements');
    assert.ok(!infoSection.includes('class="finding-card"'), 'metric-only category has no finding card');
    assert.ok(!infoSection.includes('How to fix it:'), 'no fix task manufactured from a metric');
    assert.ok(infoSection.includes('vocabulary diversity (MATTR-50): 0.766'), 'MATTR reading kept as neutral evidence');
  } finally {
    app.server.close();
  }
});

test('P2B.3: clean report has zero finding-card elements (no cards for compliments or measurements)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2b-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2b-clean');
    assert.equal(cardRegions(html).length, 0, 'clean report has zero finding cards');
    assert.equal((html.match(/<p class="ins-roast">/g) ?? []).length, 0, 'no roast layers on a clean report');
    assert.ok(!html.includes('How to fix it:'), 'no fix zone on a clean report');
    assert.ok(!html.includes('class="finding-card"'), 'no finding-card container markup at all');
  } finally {
    app.server.close();
  }
});

test('P2B.4: Phase 2A assertions hold unchanged under the card redesign (hero, 7 cards, anchors, hierarchy)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2b-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2b-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const clean = await paidHtml(app.base, 'p2b-clean');
    assert.ok(clean.includes('A.S.S. Score: 7 / 100') && clean.includes('CLEANEST'), 'clean hero unchanged');
    assert.ok(clean.includes('does not detect AI authorship'), 'exact disclaimer unchanged');
    const sloppy = await paidHtml(app.base, 'p2b-sloppy');
    assert.ok(sloppy.includes('A.S.S. Score: 89 / 100') && sloppy.includes('EXTREMELY ASS'), 'sloppy hero unchanged');
    // 7 category cards + in-page anchors still intact.
    const hrefs = [...sloppy.matchAll(/<a class="cat-card[^"]*" href="#(cat-[a-z]+)">/g)].map((m) => m[1]);
    assert.deepEqual(hrefs,
      ['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets'],
      'the 7 existing category cards remain');
    for (const anchor of hrefs) assert.ok(sloppy.includes(`id="${anchor}"`), `anchor ${anchor} still present`);
    // Section hierarchy unchanged.
    const idx = (s) => sloppy.indexOf(s);
    const seq = ['A.S.S. Score: 89 / 100', 'The Verdict', 'Your Breakdown', "What's Working",
      'The Actual Findings', 'Page That Needs The Most Work', 'What To Fix First', 'Final Verdict', 'Methodology'];
    let prev = -1;
    for (const marker of seq) {
      const at = idx(marker);
      assert.ok(at > prev, `"${marker}" still ordered after the previous section`);
      prev = at;
    }
  } finally {
    app.server.close();
  }
});

// ============================================================================
// Phase 2C — category drill-down views (owner 2026-09-17 2C spec).
// Navigation/presentation only: each category card opens a FOCUSED Category
// View (Back to Dashboard → category name → existing score/state → the
// category's own clean info + finding cards / measurements), hash-driven
// (#cat-<key>) in the SAME single document. The dashboard stays fully present;
// views layer on top. No audit/scoring/content data is changed.
// ============================================================================

const VIEW_KEYS = ['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets'];

/** Metric-only fixture: infoDensity has ONLY neutral Measurements (no negative
 * finding); filler is the one real negative. */
const P2C_METRIC_BREAKDOWN = {
  filler: { score: 50, findings: ['3× "cutting-edge"'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
  infoDensity: { score: 30, findings: [
    'vocabulary diversity (MATTR-50): 0.766 (lower = more repetitive vocabulary)',
    'stopword ratio: 46.0%',
    'mean sentence length: 28.4 words (12 sentences)',
    'short paragraphs (<25 words): 60% (20 paragraphs)',
  ] },
  repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
};

/** Isolate each `.cat-view` region (from its opening tag to the next one). */
function viewRegions(html) {
  const starts = [...html.matchAll(/<section class="cat-view" id="(view-cat-[a-z]+)" hidden>/g)].map((m) => m.index);
  return starts.map((s, i) => ({
    id: html.slice(s).match(/id="(view-cat-[a-z]+)"/)[1],
    html: html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length),
  }));
}

test('P2C.1: all 7 category cards open a focused Category View — every card resolves to a distinct per-category view container wired to its own dashboard section (clean + sloppy)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2c-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2c-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const clean = await paidHtml(app.base, 'p2c-clean');
    const sloppy = await paidHtml(app.base, 'p2c-sloppy');
    for (const [name, html] of [['clean', clean], ['sloppy', sloppy]]) {
      const cards = [...html.matchAll(/<a class="cat-card[^"]*" href="#(cat-[a-z]+)">/g)].map((m) => m[1]);
      assert.deepEqual(cards, VIEW_KEYS, `${name}: the 7 category cards remain, engine order`);
      const views = viewRegions(html);
      assert.equal(views.length, 7, `${name}: one focused view per category`);
      assert.equal(new Set(views.map((v) => v.id)).size, 7, `${name}: all 7 view containers are distinct`);
      for (const anchor of VIEW_KEYS) {
        const view = views.find((v) => v.id === `view-${anchor}`);
        assert.ok(view, `${name}: card ${anchor} has a focused view container (view-${anchor})`);
        // Distinct from the dashboard: a Back to Dashboard control…
        assert.ok(view.html.includes('class="cat-back" href="#dashboard"'), `${name}: ${anchor} view has a Back to Dashboard control`);
        // …and a clone body wired to the SAME existing dashboard section.
        assert.ok(view.html.includes(`data-source="${anchor}"`), `${name}: ${anchor} view body resolves to the existing ${anchor} section`);
        assert.ok(html.includes(`id="${anchor}"`), `${name}: dashboard still carries the ${anchor} section target`);
        assert.ok(view.html.includes('class="cat-view-name"'), `${name}: ${anchor} view carries the category name`);
      }
    }
  } finally {
    app.server.close();
  }
});

test('P2C.2: dashboard retains every existing section in order — views layer on top, hidden by default (clean + sloppy)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2c-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2c-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    for (const [name, id] of [['clean', 'p2c-clean'], ['sloppy', 'p2c-sloppy']]) {
      const html = await paidHtml(app.base, id);
      const idx = (s) => html.indexOf(s);
      const seq = ['A.S.S. Score: ', 'The Verdict', 'Your Breakdown', "What's Working",
        'The Actual Findings', 'Page That Needs The Most Work', 'What To Fix First', 'Final Verdict', 'Methodology'];
      let prev = -1;
      for (const marker of seq) {
        const at = idx(marker);
        assert.ok(at > prev, `${name}: "${marker}" still ordered after the previous section`);
        prev = at;
      }
      assert.ok(html.includes('does not detect AI authorship'), `${name}: mandated disclaimer unchanged`);
      assert.ok(html.includes('id="dashboard"'), `${name}: dashboard wrapper present (default/no-JS view)`);
      // Views are layered AFTER the full dashboard and hidden by default.
      assert.ok(idx('id="view-cat-filler"') > idx('Methodology'), `${name}: focused views come after all dashboard sections`);
      const views = viewRegions(html);
      assert.equal(views.length, 7, `${name}: exactly 7 views`);
      for (const v of views) {
        assert.ok(/<section class="cat-view" id="view-cat-[a-z]+" hidden>/.test(v.html),
          `${name}: ${v.id} is hidden by default (dashboard = the no-JS baseline)`);
        assert.ok(v.html.includes('class="cat-view-state"'), `${name}: ${v.id} carries the existing score/state line`);
      }
    }
  } finally {
    app.server.close();
  }
});

test('P2C.3: Category Views reuse the existing audit content — negative (2B cards), clean (compliments only), metric-only (neutral Measurements, never a card)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2c-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  await insertScan(dbPath, { id: 'p2c-metric', score: 50, breakdown: P2C_METRIC_BREAKDOWN });
  const app = startApp(dbPath);
  try {
    const sloppy = await paidHtml(app.base, 'p2c-sloppy');
    // (a) COPY (filler) has TWO negative findings — its view is wired to the
    // dashboard section that carries both 2B cards verbatim (roast/why/fix/
    // receipts), so the focused view shows the SAME cards.
    const fillerView = viewRegions(sloppy).find((v) => v.id === 'view-cat-filler');
    const fillerSection = sloppy.slice(sloppy.indexOf('id="cat-filler"'), sloppy.indexOf('id="cat-boilerplate"'));
    assert.ok(fillerView.html.includes('data-source="cat-filler"'), 'filler view wired to its dashboard section');
    assert.equal((fillerSection.match(/<div class="finding-card">/g) ?? []).length, 2,
      'filler dashboard section carries the 2 negative finding cards (the two-card category)');
    assert.ok(fillerSection.includes('3× &quot;cutting-edge&quot;') && fillerSection.includes('2× &quot;seamless&quot;'),
      'filler cards keep the verbatim receipts');
    for (const zone of ['The Roast', 'Why it matters:', 'How to fix it:', 'Show the receipts:']) {
      assert.ok(fillerSection.includes(zone), `filler view resolves to 2B cards with the ${zone} zone`);
    }
    assert.ok(fillerSection.includes('Finding 1') && fillerSection.includes('Finding 2'),
      'filler cards keep their global ordinals');
    // (b) REPETITION (crossPage, skipped on a single-page scan) — the focused
    // view carries the stored note as its neutral state, no finding card.
    const crossView = viewRegions(sloppy).find((v) => v.id === 'view-cat-crosspage');
    assert.ok(crossView.html.includes('insufficient pages for cross-page analysis'),
      'skipped category view surfaces the stored note');
    // (c) Clean category on the sloppy report (fingerprints, score 0) — the
    // view chrome keeps the CLEAN state; no finding card anywhere in it.
    const fpView = viewRegions(sloppy).find((v) => v.id === 'view-cat-fingerprints');
    assert.ok(fpView.html.includes('cv-state-clean'), 'clean category view keeps the CLEAN state');
    assert.ok(!fpView.html.includes('class="finding-card"'), 'clean category view has no finding card');

    const metric = await paidHtml(app.base, 'p2c-metric');
    // (d) Metric-only category (ORIGINALITY/infoDensity): the view is wired to
    // the dashboard section that keeps the NEUTRAL Measurements block — never
    // a finding card, never a warning.
    const infoView = viewRegions(metric).find((v) => v.id === 'view-cat-infodensity');
    const infoSection = metric.slice(metric.indexOf('id="cat-infodensity"'), metric.indexOf('id="cat-repetitive"'));
    assert.ok(infoView.html.includes('data-source="cat-infodensity"'), 'infoDensity view wired to its dashboard section');
    assert.ok(infoSection.includes('Measurements:'), 'metric-only category keeps its neutral Measurements block');
    assert.ok(infoSection.includes('vocabulary diversity (MATTR-50): 0.766'), 'MATTR reading kept as neutral evidence');
    assert.ok(!infoSection.includes('class="finding-card"'), 'metric-only category has no finding card');
    assert.ok(!infoSection.includes('How to fix it:'), 'no fix task manufactured from a metric');
  } finally {
    app.server.close();
  }
});

test('P2C.4: refresh with a #cat-<key> hash re-opens the same view — the inline script maps every hash to its view container on load (clean + sloppy)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2c-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2c-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    for (const [name, id] of [['clean', 'p2c-clean'], ['sloppy', 'p2c-sloppy']]) {
      const html = await paidHtml(app.base, id);
      const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
      const keys = [...script.matchAll(/'((?:cat-[a-z]+))'/g)].map((m) => m[1]);
      assert.deepEqual(keys, VIEW_KEYS, `${name}: the inline script knows all 7 category hashes`);
      assert.ok(script.includes("addEventListener('hashchange', apply)"), `${name}: navigation (incl. browser Back) drives the views`);
      assert.ok(script.includes("addEventListener('DOMContentLoaded', apply)"), `${name}: refresh with a hash re-opens the view on load`);
      assert.ok(script.includes("getElementById('view-' + key)"), `${name}: the hash resolves to its view container on load`);
      for (const anchor of VIEW_KEYS) {
        const view = viewRegions(html).find((v) => v.id === `view-${anchor}`);
        assert.ok(view, `${name}: #${anchor} refresh never lands on an empty state — view-${anchor} exists`);
        assert.ok(view.html.includes(`data-source="${anchor}"`) && html.includes(`id="${anchor}"`),
          `${name}: #${anchor} resolves to a real dashboard section in the same document`);
      }
    }
  } finally {
    app.server.close();
  }
});
// ============================================================================
// Phase 2D-1 — A.S.S. visual identity (owner 2026-09-17 2D-1 spec).
// Presentation only: the paid report + Category Views adopt the A.S.S. Score
// brand language (near-black foundation, band-semantic accents, Anton
// wordmark, donkey motif, restrained brand moments) WITHOUT touching
// architecture, audit text or the 2C wiring. These assertions are structural
// (dark-theme marker + brand tokens + state accent class hooks); the visual
// result is verified by the phase2d1 sample renders and screenshots.
// ============================================================================
test('P2D.1: report carries the A.S.S. dark theme marker, brand tokens and semantic state-accent hooks (clean + sloppy)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d1-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2d1-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    for (const [name, id] of [['clean', 'p2d1-clean'], ['sloppy', 'p2d1-sloppy']]) {
      const html = await paidHtml(app.base, id);
      // Dark A.S.S. foundation: root marker + native dark color-scheme.
      assert.match(html, /<html lang="en" data-theme="dark">/, `${name}: document root carries the dark theme marker`);
      assert.ok(html.includes('color-scheme: dark'), `${name}: dark color-scheme declared (native controls stay dark)`);
      assert.ok(html.includes('--ass:#d4f000'), `${name}: brand lime token defined`);
      assert.ok(html.includes('--bg:#0a0a0b'), `${name}: near-black page foundation token defined`);
      assert.ok(html.includes('<meta name="viewport"'), `${name}: mobile viewport meta present`);
      // Restrained brand moments (structure only).
      assert.ok(html.includes('class="head-donkey"'), `${name}: masthead donkey motif present`);
      assert.ok(html.includes('0 = LEAST ASS / 100 = MAX ASS'), `${name}: score scale hint (poster language)`);
      // Band-semantic accents stay wired to the existing per-state classes.
      assert.ok(html.includes('--cat: #4ade80') && html.includes('--cat: #facc15')
        && html.includes('--cat: #fb923c') && html.includes('--cat: #f87171'),
        `${name}: clean/watch/attention/priority accents defined`);
    }
    const sloppy = await paidHtml(app.base, 'p2d1-sloppy');
    // Category-detail sections carry the SAME existing classification as a
    // state-accent class (visual hook only — the theme CSS, never logic).
    assert.ok(sloppy.includes('class="cat-detail cat-detail-priority"'), 'sloppy: PRIORITY sections carry the state-accent hook');
    assert.ok(sloppy.includes('class="cat-detail cat-detail-needs-attention"'), 'sloppy: NEEDS ATTENTION sections carry the state-accent hook');
    assert.ok(sloppy.includes('class="cat-detail cat-detail-watch"'), 'sloppy: WATCH sections carry the state-accent hook');
    // The 2C view state badge class is normalized (previously emitted as
    // "cv-state-needs attention" with a space, so it could never be styled);
    // the category view name inherits the state accent via :has().
    assert.ok(sloppy.includes('cv-state cv-state-needs-attention'), 'sloppy: view state badge class normalized (needs-attention)');
    assert.ok(sloppy.includes('.cat-view:has(.cv-state-needs-attention)'), 'sloppy: view accent themed via the normalized badge class');
  } finally {
    app.server.close();
  }
});
