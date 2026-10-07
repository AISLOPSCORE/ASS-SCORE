import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';

/**
 * Phase 2D-2 — Full Report visual polish (owner spec 2026-09-21).
 * Presentation/UI only: the already-approved 2D-1 dark identity is polished
 * (giant band-colored hero number + severity gauge, per-category meters,
 * findings-or-not lines, premium finding cards with a receipts drawer count,
 * ranked fix-first cards linked to their findings, rewarded What's Working
 * items vs an intentional empty state). These assertions are structural
 * (markup hooks + direction + contracts); the visual result is verified by
 * the phase2d2 sample renders and screenshots. No scoring/engine/paywall
 * behavior is changed.
 */
const SECRET = 'phase2d2-test-secret';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p2d2-test-')), 'test.db');

const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function insertScan(dbPath, { id, score, breakdown }) {
  const repository = openDb(dbPath);
  repository.insertScan({ id, url: 'https://fixture.example/', score, breakdown, createdAt: '2026-09-17T12:00:00.000Z' });
  repository.close();
}

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

const SLOPPY_BREAKDOWN_89 = {
  filler: { score: 88, findings: ['3× "cutting-edge"', '2× "seamless"'] },
  boilerplate: { score: 62, findings: ['1× hedge phrase "we aim to"'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};

test('P2D2.1: hero communicates severity at a glance — giant band-colored number + fill gauge whose width IS the score (0=best, 100=worst)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d2-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2d2-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const clean = await paidHtml(app.base, 'p2d2-clean');
    const sloppy = await paidHtml(app.base, 'p2d2-sloppy');
    for (const [name, html] of [['clean', clean], ['sloppy', sloppy]]) {
      assert.ok(html.includes('class="hero-num"'), `${name}: giant score number block present`);
      assert.ok(html.includes('class="hero-val"'), `${name}: score value element present`);
      assert.ok(html.includes('class="hero-gauge"'), `${name}: severity gauge present`);
      assert.ok(html.includes('class="hero-scale"'), `${name}: direction scale caption present`);
      assert.ok(html.includes('class="hero" style="--band:'), `${name}: hero carries the band color`);
    }
    // Direction lock: low score -> small green fill; high score -> big red fill.
    assert.ok(clean.includes('<span class="hero-val">7</span>'), 'clean: hero value is 7');
    assert.ok(clean.includes('style="width:7%"'), 'clean: gauge at 7% (low = good)');
    assert.ok(sloppy.includes('<span class="hero-val">89</span>'), 'sloppy: hero value is 89');
    assert.ok(sloppy.includes('style="width:89%"'), 'sloppy: gauge at 89% (high = worse)');
    // The mandated verbal score line is unchanged for the paywall/order tests.
    assert.ok(clean.includes('A.S.S. Score: 7 / 100') && sloppy.includes('A.S.S. Score: 89 / 100'), 'verbal score line preserved');
  } finally {
    app.server.close();
  }
});

test('P2D2.2: category cards are scannable — per-category meter fill (sub-score direction) + findings-or-not line, real counts only', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d2-cards', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2d2-cards');
    assert.equal((html.match(/class="cat-meter"/g) ?? []).length, 6, 'six scored categories each show a meter (skipped cross-page has none)');
    assert.ok(html.includes('class="cat-meter-fill" style="width:88%"'), 'filler meter = 88% (highest)');
    assert.ok(html.includes('class="cat-meter-fill" style="width:82%"'), 'assets meter = 82%');
    assert.ok(html.includes('class="cat-meter-fill" style="width:0%"'), 'clean categories meter = 0%');
    assert.ok(html.includes('cat-findings-problem'), 'roasted categories carry the problem findings line');
    assert.ok(html.includes('cat-findings-clean'), 'clean categories carry the no-roasts line');
    assert.ok(html.includes('2 roasts — see receipts'), 'filler card counts its real negative findings');
    assert.ok(html.includes('class="cat-line"'), 'one-liner explanations preserved on every card');
    assert.ok(!html.includes('"><'), 'no raw quote-bracket sequence (sacred)');
  } finally {
    app.server.close();
  }
});

test('P2D2.3: findings are premium cards with a receipts drawer; What To Fix First is ranked and links to the underlying finding', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d2-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'p2d2-sloppy');
    // grouping: count the FLAT grouped list only — the hidden per-category
    // clone-source sections re-render the same cards for the Phase 2C focused
    // views, so raw-document counts would double (6 flat + 6 hidden).
    const flat = html.slice(html.indexOf('<div class="actual-findings-flat">'), html.indexOf('<div class="cat-sources" hidden>'));
    assert.equal((flat.match(/<div class="finding-card">/g) ?? []).length, 6, 'grouping: one flat-list premium card per negative finding');
    assert.equal((flat.match(/class="rec-count">/g) ?? []).length, 6, 'grouping: every flat-list receipts drawer shows a real evidence-line count');
    assert.ok(html.includes('class="rec-count">1 line of evidence<'), 'drawer count is the actual line count');
    assert.ok(html.includes('class="fc-roast"'), 'roast blocks present');
    // What To Fix First: COMPACT ranked SUMMARY cards (dashboard final cleanup)
    // — capped at 5, ranked by category severity, each linked to its category
    // view anchor, never a repeat of the full roast/receipt.
    const fixItems = [...html.matchAll(/<li class="fix-item fix-([a-z-]+)">/g)].map((m) => m[1]);
    assert.equal(fixItems.length, 5, 'fix-first capped at top 5 ranked cards');
    assert.ok(fixItems.every((c) => ['priority', 'needs-attention', 'watch'].includes(c)), 'fix cards carry real state classes');
    const links = [...html.matchAll(/class="fix-link" href="#(cat-[a-z]+)"/g)].map((m) => m[1]);
    assert.equal(links.length, 5, 'each fix card links to its finding');
    for (const anchor of links) assert.ok(html.includes(`id="${anchor}"`), `fix link resolves to the real ${anchor} section`);
    assert.ok(html.includes('class="fix-action"'), 'fix cards carry the one-line what-to-fix summary');
    // OWNER DEFECT FIX 2026-10-07: every fix card carries a fix-problem
    // headline that names the concrete problem; the full receipt is still
    // never repeated as its own block.
    assert.ok(html.includes('class="fix-problem"'), 'fix cards name the problem in a fix-problem headline');
    assert.ok(!html.includes('class="fix-evidence"'), 'compact fix cards never repeat a full fix-evidence block');
    // The headline names the CONCRETE problem — the finding's own trigger
    // line (infoDensity is the top-ranked fix item), never the joke roast.
    const fixSection = html.slice(html.indexOf('What To Fix First'), html.indexOf('Your Breakdown'));
    assert.ok(fixSection.includes('class="fix-problem">concrete specifics: 0 found in 500 words'),
      'fix-problem headline carries the finding trigger line, not the roast');
  } finally {
    app.server.close();
  }
});

test('P2D2.4: What\'s Working — real compliments render as rewarded items; a scan with no compliments gets an intentional A.S.S.-voiced empty state (never invented)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d2-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2d2-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    const clean = await paidHtml(app.base, 'p2d2-clean');
    assert.ok(clean.includes('class="working-list"'), 'clean: compliments live in a reward list');
    assert.ok(clean.includes('class="working-item"'), 'clean: reward items present');
    assert.ok(clean.includes('COPY — CLEAN:'), 'clean: real compliments keep their CLEAN label');
    assert.ok(!clean.includes('class="working-empty"'), 'clean: no empty state when rewards exist');

    const sloppy = await paidHtml(app.base, 'p2d2-sloppy');
    assert.ok(sloppy.includes('class="working-empty"'), 'sloppy: intentional empty state panel present');
    assert.ok(sloppy.includes('Nothing to compliment this scan'), 'sloppy: empty state keeps the A.S.S. voice');
    assert.equal((sloppy.match(/class="working-item"/g) ?? []).length, 0, 'sloppy: zero invented compliments');
  } finally {
    app.server.close();
  }
});

test('P2D2.5: locked architecture unchanged under the polish — section order, 7 views, disclaimer, paywall markers, score direction', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'p2d2-clean', score: 7, breakdown: CLEAN_BREAKDOWN });
  await insertScan(dbPath, { id: 'p2d2-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89 });
  const app = startApp(dbPath);
  try {
    for (const [name, id] of [['clean', 'p2d2-clean'], ['sloppy', 'p2d2-sloppy']]) {
      const html = await paidHtml(app.base, id);
      const idx = (s) => html.indexOf(s);
      // Dashboard final cleanup order: verdict → page → fix → breakdown →
      // working → findings → final → methodology.
      const seq = ['A.S.S. Score: ', 'The Verdict', 'Page That Needs The Most Work', 'What To Fix First',
        'Your Breakdown', "What's Working", 'The Actual Findings', 'Final Verdict', 'Methodology'];
      let prev = -1;
      for (const marker of seq) {
        const at = idx(marker);
        assert.ok(at > prev, `${name}: "${marker}" still ordered after the previous section`);
        prev = at;
      }
      assert.ok(html.includes('does not detect AI authorship'), `${name}: mandated disclaimer verbatim`);
      assert.ok(html.includes('id="dashboard"'), `${name}: dashboard wrapper present`);
      assert.equal((html.match(/<section class="cat-view" id="(?:view-cat-[a-z]+)" hidden>/g) ?? []).length, 7,
        `${name}: exactly 7 focused category views remain`);
      assert.equal((html.match(/<script\b/g) ?? []).length, 1, `${name}: exactly the one inline 2C script`);
      assert.ok(!html.includes('"><'), `${name}: no raw quote-bracket sequence (sacred)`);
    }
  } finally {
    app.server.close();
  }
});