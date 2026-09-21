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
