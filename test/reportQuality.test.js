import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import {
  buildCategoryInsights,
  classifyFinding,
  signalTagFor,
  eligibleVariants,
  parseEvidenceTokens,
  THREE_LAYER_POOLS,
} from '../src/threeLayer.js';
import { worstPageSummary } from '../src/routes/scans.js';
import { openDb } from '../src/db.js';

/**
 * REPORT-QUALITY FIXES #3 + #4 (owner-approved 2026-10-01).
 *
 * Fix #4 — worst-page panel presentation: a METRIC MEASUREMENT line — including
 * the parenthetical-annotated "common words: 40.3% (little words like "the" and
 * "and" — …)" form the infoDensity rule actually emits — must never count or
 * render as an "actual finding" on ANY report surface. The /about case in the
 * production scan acf076b1 showed "ORIGINALITY — 1 actual finding on this page"
 * purely because that parenthetical escaped isMetricFinding's $-anchored regex;
 * the ORIGINALITY card itself showed "Measurements only".
 *
 * Fix #3 — legal finding semantics: a detail finding whose evidence tags as
 * legal/copyright ("1× copyright line") now selects legal-safe roast/why/fix
 * copy (the finding's OWN trigger tag gates it), instead of the generic
 * marketing-card copy that overstated one legal line as "a checklist" and
 * invented "sprinkling". Scoring, detector triggers, labels, weights, verdicts
 * and the NON_MARKETING totals-line behavior are untouched.
 */
const SECRET = 'report-quality-test-secret';
const OWNER_ID = '13257f79-159a-475f-9c60-950f94528966';
const ED_ID = 'ed0b4b6f-9061-4165-a29c-5db89c639f10';
const TOTALS = '1 generic wording match in 55 words (5.5 per 300 words)';
const COPYRIGHT = '1× copyright line';
const LEGAL_FIX = 'Keep legal and cookie text in one tight, honest block at the bottom — a copyright line in the footer is expected practice; the rest of the page is where your own voice should do the talking.';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rq-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://ass-score.com/', body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function insertScan(dbPath, { id, breakdown, worstPage = null }) {
  const repository = openDb(dbPath);
  repository.insertScan({
    id,
    url: 'https://www.ass-score.com/',
    score: 11,
    breakdown,
    createdAt: '2026-09-28T18:10:10.000Z',
    worstPage: worstPage ?? undefined,
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
 * The exact worst-page finding list the production scan acf076b1 stored for
 * /about (engine order: filler, boilerplate, infoDensity, repetitive, sliced
 * to 6): every line is a CLEAN measurement or a METRIC measurement — the only
 * line the OLD code miscounted as a negative infoDensity finding was the
 * parenthetical common-words reading ("common words: 40.3% (little words …)").
 */
const ABOUT_WORST_FINDINGS = [
  '0 filler phrases in 295 words (0.0 per 300 words)',
  '0 generic wording matches in 295 words (0.0 per 300 words)',
  'word variety: 0.852 (lower = more repetitive vocabulary)',
  'common words: 40.3% (little words like "the" and "and" — more means less substance)',
  'average sentence length: 32.8 words (9 sentences)',
  'short paragraphs (<25 words): 87% (23 paragraphs)',
];

/** The owner-report breakdown shape (category scores 0/45/45 — like the live site). */
function ownerBreakdown() {
  return {
    filler: { score: 0, findings: ['0 filler phrases in 55 words (0.0 per 300 words)'] },
    boilerplate: { score: 45, findings: [TOTALS, COPYRIGHT] },
    infoDensity: {
      score: 45,
      findings: [
        'word variety: 0.760 (lower = more repetitive vocabulary)',
        'common words: 29.1% (little words like "the" and "and" — more means less substance)',
        'average sentence length: 9.2 words (6 sentences)',
        'short paragraphs (<25 words): 100% (5 paragraphs)',
      ],
    },
    repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 5 paragraphs)'] },
    crossPage: { score: 0, findings: ['no two pages are more than 80% the same (5 pages compared)'], pages: ['https://www.ass-score.com/'], pairs: [] },
    fingerprints: { score: 0, findings: [] },
    assets: { score: 0, findings: ['0 of 1 images look generic or placeholder'] },
  };
}

/** Interpolate a legal-safe roast template with a legal detail finding's tokens. */
function interpolateLegal(tpl, label, count) {
  return String(tpl).replace(/\{label\}/g, label).replace(/\{count\}/g, String(count));
}

// ============================================================================
// FIX #4 — metric measurements are never "actual findings"
// ============================================================================
test('#4 (a): the worst-page panel can never count a metric measurement as an actual finding', () => {
  const WORST_PAGE_KEYS = ['filler', 'boilerplate', 'infoDensity', 'repetitive'];
  // Every /about worst-page line must classify measurement/clean — including
  // the parenthetical common-words form the production scan stored — under the
  // SAME key detection the panel uses (parseEvidenceTokens).
  for (const f of ABOUT_WORST_FINDINGS) {
    const key = WORST_PAGE_KEYS.find((k) => Object.keys(parseEvidenceTokens(k, f)).length > 0);
    assert.ok(key, `evidence parsed to a real category: ${f.slice(0, 50)}`);
    assert.notEqual(classifyFinding(key, f, null), 'negative', `${key}: "${f}" must not classify as a negative finding`);
  }
  // The panel summary over the REAL /about list is EMPTY — no ORIGINALITY count.
  assert.deepEqual(worstPageSummary(ABOUT_WORST_FINDINGS), [],
    'measurements-only worst page produces zero actual-finding counts');
  // Positive control: a real negative finding still counts; the metric does not.
  assert.deepEqual(
    worstPageSummary(['3× "cutting-edge"', 'common words: 40.3% (little words like "the" and "and" — more means less substance)']),
    [['filler', 1]],
    'real negatives still count, measurements never');
});

test('#4 (b): the /about production case — panel no longer claims an ORIGINALITY finding (measurements only)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'rq-about-0001',
    breakdown: ownerBreakdown(),
    worstPage: { url: 'https://www.ass-score.com/about', score: 14, findings: ABOUT_WORST_FINDINGS },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'rq-about-0001');
    const pageSection = paid.slice(paid.indexOf('Page That Needs The Most Work'), paid.indexOf('What To Fix First'));
    assert.ok(!pageSection.includes('ORIGINALITY'),
      'panel must not even name ORIGINALITY for a measurements-only page');
    assert.ok(pageSection.includes('No actual negative findings captured for this page'),
      'panel shows the honest no-actual-findings fallback');
    // The ORIGINALITY category card itself keeps its neutral "Measurements only".
    assert.ok(paid.includes('<span class="cat-findings">Measurements only</span>'),
      'ORIGINALITY card still shows Measurements only');
  } finally {
    app.server.close();
  }
});

test('#4 (unit): parenthetical common-words line classifies metric (bare legacy forms still metric, in-band still clean)', () => {
  assert.equal(classifyFinding('infoDensity', 'common words: 40.3% (little words like "the" and "and" — more means less substance)', null), 'metric');
  assert.equal(classifyFinding('infoDensity', 'common words: 40.3%', null), 'metric');
  assert.equal(classifyFinding('infoDensity', 'stopword ratio: 52.0%', null), 'metric');
  assert.equal(classifyFinding('infoDensity', 'common words: 29.1% (little words like "the" and "and" — more means less substance)', null), 'clean');
  // The concrete-specifics GAP lines must stay negative — metrics are
  // measurements, gaps are findings.
  assert.equal(classifyFinding('infoDensity', 'concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)', null), 'negative');
});

// ============================================================================
// FIX #3 — legal/copyright findings get legal-safe, evidence-accurate copy
// ============================================================================
test('#3 (c): the copyright detector still fires, tags legal, and contributes its existing (locked) score — full pipeline', async () => {
  // The exact production signal pattern ("© 2026 A.S.S. Score") on a minimal
  // page. The pinned numbers are bit-for-bit identical to the pre-change
  // engine on the same fixture (verified against pristine main): overall 34,
  // boilerplate 100, infoDensity 48 — scoring is untouched by this fix.
  const HTML = `<!doctype html><html><head><title>Acme</title></head><body>
<p>We build software tools for small businesses.</p>
<p>Our platform helps teams stay organized and ship faster.</p>
<footer><p>© 2026 A.S.S. Score. All rights reserved.</p></footer>
</body></html>`;
  const fetcher = { fetchHtml: async (url) => ({ status: 200, url, contentType: 'text/html', body: HTML }) };
  const dbPath = tmpDb();
  const repository = openDb(dbPath);
  const { runScan } = await import('../src/scan.js');
  const { ok, payload } = await runScan({ db: repository, fetcher, url: 'https://fixture.example/', now: () => '2026-10-01T00:00:00.000Z' });
  repository.close();
  assert.ok(ok, 'scan succeeds');
  assert.equal(payload.slopScore, 34, 'overall score unchanged (locked math)');
  assert.equal(payload.breakdown.boilerplate.score, 100, 'boilerplate sub-score unchanged');
  assert.equal(payload.breakdown.infoDensity.score, 48, 'infoDensity sub-score unchanged');
  assert.ok(payload.breakdown.boilerplate.findings.includes('1× copyright line'),
    'the © detector still fires the copyright-line signal');
  assert.equal(signalTagFor('boilerplate', '1× copyright line'), 'legal', 'copyright line still tags legal');
});

test('#3 (d): a legal/copyright finding receives legal-safe, evidence-accurate roast/why/fix — generic card copy is gone', () => {
  const whyEligibleLegal = eligibleVariants(
    (JSON.parse(fs.readFileSync(new URL('../src/threeLayer.json', import.meta.url), 'utf8')).pools.boilerplate.whys ?? []), 'legal');
  const legalRoastTemplates = THREE_LAYER_POOLS.boilerplate.legalSafeRoasts;
  assert.ok(legalRoastTemplates.length >= 2, 'legal-safe detail roast pool ships');

  for (const id of [OWNER_ID, ED_ID, 'rq-legal-0', 'rq-legal-1', 'rq-legal-2']) {
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [COPYRIGHT], id });
    // Roast: from the legal-safe pool, cites the real element, never the
    // generic marketing-card overclaims.
    assert.ok(legalRoastTemplates.some((t) => interpolateLegal(t, 'copyright line', '1') === ins.roast),
      `${id}: roast must come from the legalSafeRoasts pool ("${ins.roast}")`);
    assert.ok(/copyright line/.test(ins.roast), `${id}: roast cites the actual legal element`);
    assert.ok(!/checklist|greatest-hits|sprinkling/i.test(ins.roast), `${id}: roast never overstates one legal line ("${ins.roast}")`);
    // Why/fix: legal-appropriate, evidence-accurate (no invented bulk/sprinkling).
    assert.ok(whyEligibleLegal.includes(ins.why), `${id}: why from the legal-tagged eligible set ("${ins.why}")`);
    assert.ok(!/in bulk/i.test(ins.why), `${id}: why does not invent a bulk problem ("${ins.why}")`);
    assert.equal(ins.fix, LEGAL_FIX, `${id}: fix is the single legal-tagged line`);
    assert.ok(!/sprinkling|generic wording through the page/i.test(ins.fix), `${id}: fix no longer invents sprinkling`);
  }

  // Totals-line legal-safe behavior preserved (audit Q3.2): when the category's
  // only signals are legal, the TOTALS roast still comes from the totals pool.
  const [totalsIns] = buildCategoryInsights({ category: 'boilerplate', findings: [TOTALS, COPYRIGHT], id: OWNER_ID });
  assert.ok(THREE_LAYER_POOLS.boilerplate.legalSafeTotalsRoasts
    .map((t) => t.replace(/\{count\}/g, '1').replace(/\{signalsNoun\}/g, 'phrase').replace(/\{words\}/g, '55'))
    .includes(totalsIns.roast), `totals roast keeps the legal-safe totals pool ("${totalsIns.roast}")`);

  // NON-MARKETING semantics elsewhere untouched: a learn-more (CTA) detail
  // finding keeps the GENERIC marketing-card roast — legal-safe copy is gated
  // on the finding's OWN tag === 'legal'.
  const lmIns = buildCategoryInsights({ category: 'boilerplate', findings: ['1× generic \u201Clearn more\u201D link'], id: 'rq-lm-0' })[0];
  assert.equal(signalTagFor('boilerplate', '1× generic \u201Clearn more\u201D link'), 'learn-more');
  assert.ok(!THREE_LAYER_POOLS.boilerplate.legalSafeRoasts.some((t) => interpolateLegal(t, 'generic “learn more” link', '1') === lmIns.roast),
    'learn-more finding does not get legal-safe roast copy');
  assert.ok(/learn more/.test(lmIns.roast), `learn-more roast still cites its own label ("${lmIns.roast}")`);
});

test('#3 (e): determinism — same (category, evidence, id) still yields identical legal-safe insights', () => {
  const a = buildCategoryInsights({ category: 'boilerplate', findings: [COPYRIGHT], id: 'rq-det-7' });
  const b = buildCategoryInsights({ category: 'boilerplate', findings: [COPYRIGHT], id: 'rq-det-7' });
  assert.deepEqual(a, b, 'deterministic legal insight');
});