import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';

/**
 * REPORT SELF-CONSISTENCY (owner defect 2026-10-07 — HIGH priority trust
 * issue; publishyoursaas.com paid report). The report must NEVER compliment a
 * category it also flags:
 *
 *   - a breakdown card must never show "Nothing meaningful to roast here."
 *     next to "N roasts — see receipts",
 *   - What's Working must never list "IMAGERY — CLEAN:" zero-sibling lines
 *     next to a real "5 of 53 images with placeholder/generic filenames"
 *     finding,
 *   - the finding-severity badges, the fix-first pills AND the focused-view
 *     state line must all agree (promoted CLEAN -> WATCH when the category has
 *     ≥1 actual negative finding).
 *
 * Layer 2 covers OLD stored rows whose findings arrays still contain the
 * legacy zero-sibling "0 of N …" lines (the stored bytes cannot be changed) —
 * so the legacy row shape is the exact fixture here. The all-clean row must
 * keep rendering exactly as before (CLEAN card, legit compliment source).
 */
const SECRET = 'report-self-consistency-test-secret';
const LEGACY_ID = 'rgsc-00000000-0000-4000-8000-000000000001';
const CLEAN_ID = 'rgsc-00000000-0000-4000-8000-000000000002';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rgsc-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://publishyoursaas.com/', body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function insertScan(dbPath, { id, breakdown, score = 26 }) {
  const repository = openDb(dbPath);
  repository.insertScan({
    id,
    url: 'https://publishyoursaas.com/',
    score,
    breakdown,
    createdAt: '2026-10-06T14:22:00.000Z',
  });
  repository.close();
}

async function paidHtml(base, id) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200, 'paid report serves 200 with a valid token');
  return res.text();
}

/**
 * The owner's exact case as a LEGACY stored row: the old assets rule emitted
 * all three aggregate lines (two zero siblings) plus the 5 detail lines.
 * Negative findings = the "5 of 53 …" aggregate + 5 details = 6 roasts.
 * Sub-score 2 sits in the CLEAN band — this is the row that rendered
 * "CLEAN" + "Nothing meaningful to roast here." next to "6 roasts — see
 * receipts" + four "IMAGERY — CLEAN:" compliments before the fix.
 */
function legacyBreakdown() {
  return {
    filler: { score: 0, findings: ['0 filler phrases in 96 words (0.0 per 300 words)'] },
    boilerplate: { score: 0, findings: ['0 generic wording matches in 96 words (0.0 per 300 words)'] },
    infoDensity: {
      score: 0,
      findings: [
        'word variety: 0.902 (lower = more repetitive vocabulary)',
        'common words: 31.4% (little words like "the" and "and" — more means less substance)',
        'average sentence length: 19.2 words (5 sentences)',
        'short paragraphs (<25 words): 0% (2 paragraphs)',
      ],
    },
    repetitive: { score: 0, findings: ['no notable repetitive structure (5 sentences, 2 paragraphs)'] },
    crossPage: { score: 0, findings: ['no two pages are more than 80% the same (2 pages compared)'], pages: [], pairs: [] },
    fingerprints: { score: 0, findings: ['no recognizable template signs detected'] },
    assets: {
      score: 2,
      findings: [
        '0 of 53 images come from stock photo sites',
        '5 of 53 images with placeholder/generic filenames',
        '0 of 53 images with missing or generic alt text',
        'img[0] generic filename "image1" (/assets/image1.jpg)',
        'img[1] generic filename "image2" (/assets/image2.jpg)',
        'img[2] generic filename "image3" (/assets/image3.jpg)',
        'img[3] generic filename "image4" (/assets/image4.jpg)',
        'img[4] generic filename "image5" (/assets/image5.jpg)',
      ],
    },
  };
}

/** A genuinely clean row (assets score 0, no negatives) — must render as before. */
function cleanBreakdown() {
  return {
    filler: { score: 0, findings: ['0 filler phrases in 96 words (0.0 per 300 words)'] },
    boilerplate: { score: 0, findings: ['0 generic wording matches in 96 words (0.0 per 300 words)'] },
    infoDensity: {
      score: 0,
      findings: [
        'word variety: 0.902 (lower = more repetitive vocabulary)',
        'common words: 31.4% (little words like "the" and "and" — more means less substance)',
        'average sentence length: 19.2 words (5 sentences)',
        'short paragraphs (<25 words): 0% (2 paragraphs)',
      ],
    },
    repetitive: { score: 0, findings: ['no notable repetitive structure (5 sentences, 2 paragraphs)'] },
    crossPage: { score: 0, findings: ['no two pages are more than 80% the same (2 pages compared)'], pages: [], pairs: [] },
    fingerprints: { score: 0, findings: ['no recognizable template signs detected'] },
    assets: { score: 0, findings: ['0 of 53 images look generic or placeholder'] },
  };
}

/** The assets card markup (everything between the opening <a> and closing </a>). */
function assetsCard(html) {
  const m = html.match(/<a class="cat-card ([^"]*)" href="#cat-assets">[\s\S]*?<\/a>/);
  assert.ok(m, 'assets breakdown card rendered');
  return m[0];
}

test('legacy flagged row (5/53): the assets card shows the PROMOTED state — WATCH, one-liner, "6 roasts — see receipts", never "Nothing meaningful to roast here."', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEGACY_ID, breakdown: legacyBreakdown() });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEGACY_ID);
    const card = assetsCard(html);
    assert.ok(card.includes('cat-watch'), `assets card promoted to cat-watch (got: ${card.match(/cat-card [^"]*/)?.[0]})`);
    assert.ok(card.includes('<span class="cat-state">WATCH</span>'), 'assets card state pill shows WATCH');
    assert.ok(card.includes('6 roasts — see receipts'), 'assets card keeps the REAL roasts count');
    assert.ok(card.includes('Generic images where real, specific photos of your work would say more.'),
      'assets card shows the category one-liner (follows the promoted state)');
    assert.ok(!card.includes('Nothing meaningful to roast here.'),
      'assets card must NEVER say "Nothing meaningful to roast here." while it lists roasts');
    // The real sub-score stays visible unchanged.
    assert.ok(card.includes('<span class="cat-score">2<span class="cat-den">/100</span></span>'), 'assets sub-score 2/100 unchanged');
  } finally {
    app.server.close();
  }
});

test('legacy flagged row (5/53): the two zero-sibling lines never surface as What\'s Working compliments; finding badges + fix-first pills + focused view all agree on WATCH', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEGACY_ID, breakdown: legacyBreakdown() });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, LEGACY_ID);
    // What's Working: no IMAGERY compliment from the legacy zero lines.
    assert.ok(!html.includes('IMAGERY — CLEAN:'),
      'legacy zero-sibling lines must not render as IMAGERY — CLEAN compliments');
    // The finding card keeps the real finding with a promoted WATCH badge.
    assert.ok(html.includes('5 of 53 images with placeholder/generic filenames'), 'the 5-of-53 finding stays');
    assert.ok(html.includes('class="fc-state fc-state-watch"'), 'finding severity badge shows promoted WATCH');
    // What To Fix First: the assets fix pill agrees (WATCH), never CLEAN.
    const fixPills = [...html.matchAll(/<span class="fix-pill">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.ok(fixPills.includes('WATCH'), `fix-first pills agree on WATCH (got: ${fixPills.join(', ')})`);
    assert.ok(!fixPills.includes('CLEAN'), 'no fix pill may read CLEAN');
    // Focused Category View state line agrees too (same display classification).
    const assetsView = html.slice(html.indexOf('id="view-cat-assets"'), html.indexOf('</section>', html.indexOf('id="view-cat-assets"')));
    assert.ok(assetsView.includes('cv-state cv-state-watch'), 'focused view state line shows promoted WATCH');
  } finally {
    app.server.close();
  }
});

test('legacy flagged row (5/53): deterministic + byte-identical — same scan id renders identical HTML every time', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: LEGACY_ID, breakdown: legacyBreakdown() });
  const app = startApp(dbPath);
  try {
    const html1 = await paidHtml(app.base, LEGACY_ID);
    const html2 = await paidHtml(app.base, LEGACY_ID);
    assert.equal(html1, html2, 'same scan id -> byte-identical HTML');
  } finally {
    app.server.close();
  }
});

test('all-clean assets row renders EXACTLY as before: CLEAN card, "Nothing meaningful to roast here.", legit What\'s Working compliment', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: CLEAN_ID, breakdown: cleanBreakdown() });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, CLEAN_ID);
    const card = assetsCard(html);
    assert.ok(card.includes('cat-clean'), 'all-clean assets card stays cat-clean');
    assert.ok(card.includes('<span class="cat-state">CLEAN</span>'), 'all-clean assets card keeps CLEAN');
    assert.ok(card.includes('Nothing meaningful to roast here.'), 'all-clean card keeps the clean one-liner');
    assert.ok(!card.includes('roasts — see receipts'), 'all-clean card has no roasts count');
    assert.ok(html.includes('IMAGERY — CLEAN:'), 'all-clean assets line legitimately compliments in What\'s Working');
  } finally {
    app.server.close();
  }
});