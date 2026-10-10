import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken, pickTeasers } from '../src/paywall.js';
import {
  buildCategoryInsights,
  isCleanEvidence,
  isBoilerplateAggregateLine,
  signalTagFor,
  eligibleVariants,
  THREE_LAYER_POOLS,
} from '../src/threeLayer.js';
import { analyzeFingerprints } from '../src/rules/fingerprints.js';
import { openDb } from '../src/db.js';

/**
 * REPORT-INTEGRITY TESTS (owner-approved 2026-09-28 — the four audit
 * corrections; NO scoring/weights/thresholds/payment changes).
 *
 *   Q1 — trigger-preferred why/fix (selectEligible): legal findings always get
 *        legal advice; the untagged fallback is a true last resort; 0% of ids
 *        pair a copyright line with the marketing fallback (was 50–52.6%).
 *   Q2 — What's Working gated to CLEAN-band categories (ORIGINALITY 45/WATCH
 *        is never complimented as CLEAN) + DESIGN emits a clean line on a
 *        zero-hit scan so its (previously dead) compliments pool fires.
 *   Q3 — one signal = one finding: a boilerplate totals line + its detail
 *        line render ONE card; the density measurement rides in the receipts;
 *        roast/fix are evidence-aware (legal-safe totals roasts, legal fix).
 *   F2  — share text mirrors the site fallback exactly ("(low is good)") —
 *        asserted in card.test.js.
 *
 * The scenarios reconstruct the OWNER'S two real paid reports
 * (13257f79 = owner's purchase, ed0b4b6f = 5 min earlier) from the evidence
 * strings in report-logic-audit/owner-report.txt: the same scan ids, the same
 * category scores, and the same evidence lines — with insights DERIVED from
 * the scan id (the legacy-derivation path), which is exactly how the old
 * report bytes were produced.
 */
const SECRET = 'report-integrity-test-secret';
const OWNER_ID = '13257f79-159a-475f-9c60-950f94528966';
const ED_ID = 'ed0b4b6f-9061-4165-a29c-5db89c639f10';
const TOTALS = '1 generic wording match in 55 words (5.5 per 300 words)';
const COPYRIGHT = '1× copyright line';
const OLD_FALLBACK_FIX = 'Pick the single most generic element this finding flagged';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ri-test-')), 'test.db');
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://ass-score.com/', body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** grouping: THE ACTUAL FINDINGS = the FLAT grouped list (the owner-facing
 * cards, `.actual-findings-flat`) + the hidden per-category clone-source
 * sections (`<div class="cat-sources" hidden>`, Phase 2C focused views re-use
 * them client-side). Card/roast-count pins scope to the flat list — the
 * hidden sections re-render the same cards, so raw-document counts doubled
 * (ONE PROBLEM = ONE FINDING, owner 2026-10-07). */
function flatRegion(html) {
  const a = html.indexOf('<div class="cat-sources" hidden>');
  const b = html.indexOf('<section class="cat-view"', a);
  assert.ok(a >= 0 && b > a, 'findings region present before the focused category views');
  return html.slice(a, b);
}

async function insertScan(dbPath, { id, breakdown, worstPage = null, score = 11 }) {
  const repository = openDb(dbPath);
  repository.insertScan({
    id,
    url: 'https://www.ass-score.com/',
    score,
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

/** The owner-report breakdown (evidence strings verbatim from the .txt). */
function ownerBreakdown(includeDesignCleanLine = false) {
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
    fingerprints: { score: 0, findings: includeDesignCleanLine ? ['no recognizable template signs detected'] : [] },
    assets: { score: 0, findings: ['0 of 1 images look generic or placeholder'] },
  };
}

const legalFixOf = (cat = 'boilerplate') =>
  eligibleVariants((JSON.parse(fs.readFileSync(new URL('../src/threeLayer.json', import.meta.url), 'utf8')).pools[cat]?.fixes ?? []), 'legal');

// ============================================================================
// Q1 — trigger-preferred why/fix + owner-case reproduction
// ============================================================================
test('Q1/owner-case: the exact owner evidence with the REAL scan ids gets a legal-appropriate fix — never the marketing fallback', () => {
  for (const id of [OWNER_ID, ED_ID]) {
    // Copyright detail line alone (the signal the owner's Finding 2 flagged).
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [COPYRIGHT], id });
    assert.equal(signalTagFor('boilerplate', COPYRIGHT), 'legal', 'copyright line tags as legal');
    assert.equal(ins.fix, 'Keep legal and cookie text in one tight, honest block at the bottom — a copyright line in the footer is expected practice; the rest of the page is where your own voice should do the talking.',
      `${id}: fix must be the legal-tagged line (legal-safe, no invented sprinkling)`);
    assert.ok(!ins.fix.includes(OLD_FALLBACK_FIX), `${id}: never the old generic-marketing fallback`);
    assert.ok(!/nothing to say|generic phrase/i.test(ins.roast), `${id}: detail roast must not mislabel legal text ("${ins.roast}")`);
    assert.ok(/copyright line/.test(ins.roast), `${id}: roast names the legal element ("${ins.roast}")`);
    // Report-quality fix #3 (2026-10-01): the detail roast comes from the
    // LEGAL-SAFE detail pool, not the generic marketing-card roasts (no
    // "it's a checklist", no "greatest-hits album").
    assert.ok(THREE_LAYER_POOLS.boilerplate.legalSafeRoasts
      .map((t) => t.replace(/\{count\}/g, '1').replace(/\{label\}/g, 'copyright line'))
      .includes(ins.roast), `${id}: detail roast must come from the legalSafeRoasts pool ("${ins.roast}")`);

    // Full category ([totals, detail]) — the way the detector actually emits.
    const [totalsIns, detailIns] = buildCategoryInsights({ category: 'boilerplate', findings: [TOTALS, COPYRIGHT], id });
    const poolTemplate = THREE_LAYER_POOLS.boilerplate.legalSafeTotalsRoasts
      .map((t) => t.replace(/\{count\}/g, '1').replace(/\{signalsNoun\}/g, 'phrase').replace(/\{words\}/g, '55'));
    assert.ok(poolTemplate.some((t) => t === totalsIns.roast),
      `${id}: totals roast comes from the legal-safe pool ("${totalsIns.roast}")`);
    assert.ok(!/nothing to say|generic phrase/i.test(totalsIns.roast), `${id}: totals roast never mislabels a legal-only page`);
    assert.equal(signalTagFor('boilerplate', TOTALS), null, 'totals line stays null-tag (untagged-only eligibility)');
  }
});

test('Q1/sweep: 500 deterministic ids — 0% of legal findings get the marketing fallback (was 50–52.6%); every tagged finding stays inside its trigger-matched fix set', () => {
  const DATA = JSON.parse(fs.readFileSync(new URL('../src/threeLayer.json', import.meta.url), 'utf8'));
  const FIXES = DATA.pools.boilerplate.fixes;
  const fixEntries = FIXES.map((e) => (typeof e === 'string' ? { text: e, triggers: [] } : e));

  // (a) legal evidence across 500 deterministic ids: ALWAYS the legal fix.
  let marketingFallbacks = 0;
  let legalPicks = 0;
  for (let i = 0; i < 500; i += 1) {
    const id = `ri-sweep-legal-${i}`;
    const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [COPYRIGHT], id });
    if (ins.fix.includes(OLD_FALLBACK_FIX)) marketingFallbacks += 1;
    if (ins.fix.includes('Keep legal and cookie text')) legalPicks += 1;
    assert.ok(!/nothing to say|generic phrase/i.test(ins.roast), `legal roast mislabels at id ${id}: "${ins.roast}"`);
  }
  assert.equal(marketingFallbacks, 0, `legal findings must NEVER hit the marketing fallback (got ${marketingFallbacks}/500)`);
  assert.equal(legalPicks, 500, `legal findings must ALWAYS get the legal fix (got ${legalPicks}/500)`);

  // (b) every tagged evidence format: fix ∈ trigger-matched subset whenever a
  // matching tagged line exists (never the untagged fallback over a tagged
  // line, never an off-tag line).
  const taggedCases = [
    ['2× privacy policy', 'legal'],
    ['1× cookie banner', 'legal'],
    ['1× lorem ipsum placeholder', 'template'],
    ['2× generic \u201Clearn more\u201D link', 'learn-more'],
    ['1× generic \u201Ccontact us\u201D link', 'cta'],
    ['1× marketing superlative', 'marketing'],
    ['1× hedge phrase "we aim to"', 'marketing'],
    ['2× repeated block: "our platform is the best in class"', 'repeated'],
  ];
  for (const [evidence, tag] of taggedCases) {
    const tagged = fixEntries.filter((e) => (e.triggers ?? []).includes(tag)).map((e) => e.text);
    for (let i = 0; i < 200; i += 1) {
      const id = `ri-sweep-tag-${tag}-${i}`;
      const [ins] = buildCategoryInsights({ category: 'boilerplate', findings: [evidence], id });
      if (tagged.length > 0) {
        assert.ok(tagged.includes(ins.fix),
          `${evidence.slice(0, 40)} (id ${id}): fix "${ins.fix.slice(0, 60)}…" must be a trigger-matched line`);
      } else {
        assert.ok(eligibleVariants(FIXES, tag).includes(ins.fix), `${evidence.slice(0, 40)}: fix stays inside the eligible set`);
      }
    }
  }

  // (c) the untagged fallback fix is semantically signal-agnostic: it must
  // never prescribe "replace with marketing copy" (the old copy did).
  const untaggedFix = eligibleVariants(FIXES, null).find((t) => !/triggers|legal|cookie|learn more|fact check/.test(t));
  assert.ok(untaggedFix, 'an untagged fix exists');
  assert.ok(!/replace it with something only your business could say/i.test(untaggedFix),
    `untagged fallback no longer prescribes marketing replacement: "${untaggedFix}"`);
  assert.ok(/keep it|tighten|cut it|earn its place/i.test(untaggedFix),
    `untagged fallback keeps the signal-agnostic keep/tighten/cut guidance: "${untaggedFix}"`);
});

// ============================================================================
// Q3 — one signal = one finding at the REPORT level (owner scenario)
// ============================================================================
test('Q3/report: owner scan — ONE finding card for the copyright signal; roast names the legal element; density stays in the receipts; legal fix', async () => {
  for (const id of [OWNER_ID, ED_ID]) {
    const dbPath = tmpDb();
    await insertScan(dbPath, { id, breakdown: ownerBreakdown() });
    const app = startApp(dbPath);
    try {
      const paid = await paidHtml(app.base, id);

      // (a) One signal -> ONE card: the totals line no longer renders as a
      // separate negative finding card ("2 findings" was the audit complaint).
      // grouping: count the FLAT grouped list only — the hidden per-category
      // clone-source section re-renders the same card for the Phase 2C view.
      assert.equal((flatRegion(paid).match(/<div class="finding-card"/g) ?? []).length, 1,
        `${id}: grouping: exactly ONE flat-list finding card for ONE copyright signal`);
      // The flat-findings intro line is gone (owner reorder 2026-10-10) — the
      // count now surfaces via the final-verdict next-step and the card line.
      assert.ok(paid.includes('Fix the top items, then rescan — the score is waiting to drop.'),
        `${id}: final verdict next-step fires with the one finding to fix`);
      assert.ok(!paid.includes('2 findings'), `${id}: no double-counted "2 findings" anywhere`);
      assert.ok(paid.includes('<span class="cat-findings cat-findings-problem">1 roast — see receipts</span>'),
        `${id}: MESSAGING breakdown card shows ONE roast`);

      // (b) The one card is the copyright detail: accurate legal roast, legal
      // fix, and BOTH receipts (detail + the density measurement).
      const card = paid.match(/<div class="finding-card">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? paid;
      assert.ok(/copyright line/.test(card), `${id}: roast names the legal element`);
      assert.ok(!/nothing to say|generic phrase/i.test(card), `${id}: roast never mislabels legal text as generic filler`);
      assert.ok(!card.includes('checklist'), `${id}: legal detail card never overstates one legal line as a checklist (fix #3)`);
      assert.ok(card.includes('Keep legal and cookie text in one tight, honest block'),
        `${id}: fix is the legal-tagged line`);
      assert.ok(!card.includes(OLD_FALLBACK_FIX), `${id}: never the old marketing fallback`);
      assert.ok(card.includes('2 lines of evidence'), `${id}: receipts drawer carries both lines`);
      assert.ok(card.includes('1× copyright line'), `${id}: detail receipt verbatim`);
      assert.ok(card.includes('1 generic wording match in 55 words (5.5 per 300 words)'),
        `${id}: the density measurement stays visible as a receipt`);

      // (c) Exactly ONE roast block — the second MESSAGING card is gone — and
      // the mislabeling "nothing to say" phrasing appears nowhere.
      // grouping: count the FLAT grouped list only (hidden per-category
      // clone-source section re-renders the same card for the Phase 2C view).
      assert.equal((flatRegion(paid).match(/<p class="ins-roast">/g) ?? []).length, 1,
        `${id}: grouping: exactly one flat-list roast-styled layer (one signal -> one card)`);
      assert.ok(!paid.includes('having nothing to say'), `${id}: no mislabeling totals roast anywhere`);
    } finally {
      app.server.close();
    }
  }
});

test('Q3/report: MESSAGING "Measurements only" classification still works for a GENUINELY clean category (0.0 per 300 totals → clean, not a negative)', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, {
    id: 'ri-clean-msg-0001',
    breakdown: {
      filler: { score: 0, findings: ['0 filler phrases in 55 words (0.0 per 300 words)'] },
      boilerplate: { score: 0, findings: ['0 boilerplate signals in 55 words (0.0 per 300 words)'] },
      infoDensity: { score: 0, findings: ['word variety: 0.900 (lower = more repetitive vocabulary)'] },
      repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 5 paragraphs)'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
      fingerprints: { score: 0, findings: ['no recognizable template signs detected'] },
      assets: { score: 0, findings: ['0 of 1 images look generic or placeholder'] },
    },
  });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ri-clean-msg-0001');
    assert.ok(paid.includes('Nothing to fix this scan — keep it up, and rescan after any big changes.'),
      'clean totals line classifies clean (not a negative finding): final verdict carries the clean next-step');
    assert.equal((paid.match(/<div class="finding-card"/g) ?? []).length, 0, 'no finding cards');
    assert.ok(paid.includes('MESSAGING — CLEAN:'), 'clean MESSAGING category still compliments in What\'s Working');
  } finally {
    app.server.close();
  }
});

// ============================================================================
// Q2 — What's Working gated to CLEAN-band categories + DESIGN clean line
// ============================================================================
test('Q2/report: What\'s Working compliments only CLEAN-band categories — ORIGINALITY 45/WATCH is never advertised as CLEAN', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'ri-gate-0001', breakdown: ownerBreakdown(true) });
  const app = startApp(dbPath);
  try {
    const paid = await paidHtml(app.base, 'ri-gate-0001');

    // Every What's Working category is CLEAN-band (score < 25).
    assert.ok(paid.includes('COPY — CLEAN:'), 'COPY (0/CLEAN) complimented');
    assert.ok(paid.includes('STRUCTURE — CLEAN:'), 'STRUCTURE (0/CLEAN) complimented');
    assert.ok(paid.includes('REPETITION — CLEAN:'), 'REPETITION (0/CLEAN) complimented');
    assert.ok(paid.includes('IMAGERY — CLEAN:'), 'IMAGERY (0/CLEAN) complimented');
    // DESIGN (0/CLEAN with the new clean line) now compliments too.
    assert.ok(paid.includes('DESIGN — CLEAN:'), 'DESIGN compliments via its (previously dead) pool');
    assert.ok(paid.includes('no recognizable template signs detected'), 'DESIGN receipt is the clean line');

    // ORIGINALITY (45/WATCH) is NEVER in What's Working — the contradiction
    // is gone.
    assert.ok(!paid.includes('ORIGINALITY — CLEAN:'), 'WATCH category never complimented as CLEAN');
    const working = paid.slice(paid.indexOf("What's Working"), paid.indexOf('<div class="cat-sources" hidden>'));
    assert.ok(!working.includes('ORIGINALITY — CLEAN'), 'ORIGINALITY absent from What\'s Working');
    // AND its focused view no longer shows "— CLEAN:" next to the WATCH badge.
    const origView = paid.slice(paid.indexOf('view-cat-infodensity'), paid.indexOf('view-cat-repetitive'));
    assert.ok(!origView.includes('ORIGINALITY — CLEAN'), 'focused ORIGINALITY view drops the CLEAN compliment');

    // The What's Working section lists all 5 clean categories — the legacy
    // DESIGN deficiency (no clean line) is fixed at the rule level.
    for (const name of ['COPY', 'STRUCTURE', 'REPETITION', 'IMAGERY', 'DESIGN']) {
      assert.ok(paid.includes(`${name} — CLEAN:`), `${name} present in What's Working`);
    }

    // What To Fix First lists ONLY categories with actual negative findings.
    const fixSection = paid.slice(paid.indexOf('What To Fix First'), paid.indexOf("What's Working"));
    assert.equal((fixSection.match(/<li class="fix-item/g) ?? []).length, 1, 'exactly one fix item (the MESSAGING signal)');
    assert.ok(fixSection.includes('MESSAGING'), 'fix-first names MESSAGING');
    assert.ok(!fixSection.includes('ORIGINALITY'), 'fix-first never lists a WATCH category with no negative finding');
  } finally {
    app.server.close();
  }
});

test('Q2/unit: fingerprints emits a clean line on a zero-hit scan; it classifies clean and derives a compliment', () => {
  const r = analyzeFingerprints({ html: '<!doctype html><html><head><title>Plain</title></head><body><p>Real engineering docs.</p></body></html>', head: '', text: 'Real engineering docs.' });
  assert.deepEqual(r.findings, ['no recognizable template signs detected'], 'clean scan emits the DESIGN clean line');
  assert.ok(isCleanEvidence('fingerprints', r.findings[0]), 'clean line classifies clean');
  const [ins] = buildCategoryInsights({ category: 'fingerprints', findings: r.findings, id: 'ri-design-clean' });
  assert.equal(ins.kind, 'clean', 'derives a compliment, never a roast');
  assert.ok(THREE_LAYER_POOLS.fingerprints.compliments.includes(ins.roast), 'compliment from the fingerprints pool');
});

// ============================================================================
// Q3 — teaser protection: the FREE sample never surfaces the old
// "nothing to say" totals roast carried by legacy STORED rows
// ============================================================================
test('Q3/teasers: legacy stored totals insight with the mislabeling roast is never sampled when a detail insight exists', () => {
  const legacyTotalsInsight = {
    roast: '1 generic phrase in 55 words. That\'s 5.5 per 300 — a record for having nothing to say.',
    why: 'Every generic sentence is a wasted chance to say one specific thing about your product that a competitor cannot.',
    fix: OLD_FALLBACK_FIX,
    evidence: TOTALS,
  };
  const breakdown = {
    boilerplate: {
      score: 45,
      findings: [TOTALS, COPYRIGHT],
      insights: [
        legacyTotalsInsight,
        {
          roast: '"copyright line" — 1 of them. This isn\'t a website, it\'s a checklist.',
          why: 'Cookie banners, legal text and "learn more" links are fine alone; in bulk they make the page read as assembled rather than written — and trust is the first casualty.',
          fix: 'Keep legal and cookie text in one tight, honest block at the bottom instead of sprinkling generic wording through the page.',
          evidence: COPYRIGHT,
        },
      ],
    },
    filler: { score: 0, findings: ['0 filler phrases in 55 words (0.0 per 300 words)'], insights: [] },
  };
  const teasers = pickTeasers(breakdown, OWNER_ID);
  assert.ok(teasers.length >= 1, 'the >=25 category still supplies teasers');
  for (const t of teasers) {
    assert.notEqual(t.evidence, TOTALS, 'the aggregate/totals insight is dropped from the teaser pool');
    assert.ok(!/nothing to say|generic phrase/i.test(t.roast), `teaser roast never mislabels legal text ("${t.roast}")`);
    assert.ok(/copyright line/.test(t.roast), `teaser names the legal element ("${t.roast}")`);
  }
});

// ============================================================================
// Consistency invariants (CHANGE 5 verification)
// ============================================================================
test('Q5/consistency: report-level sweep — negative-finding count == signal count; fix-first only negative categories; works-within working only CLEAN-band', async () => {
  // 12 deterministic ids (report rendering is heavier; the engine-level 500-id
  // sweep above covers the full range).
  for (let i = 0; i < 12; i += 1) {
    const id = `ri-report-sweep-${i}`;
    const dbPath = tmpDb();
    await insertScan(dbPath, { id, breakdown: ownerBreakdown(true) });
    const app = startApp(dbPath);
    try {
      const paid = await paidHtml(app.base, id);
      // negative-finding count == signal count (1 copyright signal -> 1 card).
      // grouping: count the FLAT grouped list only (the hidden per-category
      // clone-source section re-renders the same card for the Phase 2C view).
      assert.equal((flatRegion(paid).match(/<div class="finding-card"/g) ?? []).length, 1, `${id}: grouping: one per-category card per signal`);
      assert.ok(paid.includes('Fix the top items, then rescan — the score is waiting to drop.'),
        `${id}: findings scan shows the next-step final verdict (the flat findings-intro line is gone)`);
      assert.ok(!paid.includes('every roast points at the receipts inside its category view'),
        `${id}: no legacy flat findings-intro line (findings live in the category views)`);
      // What's Working ⊆ CLEAN-band.
      const working = paid.slice(paid.indexOf("What's Working"), paid.indexOf('<div class="cat-sources" hidden>'));
      for (const banned of ['ORIGINALITY — CLEAN:', 'MESSAGING — CLEAN:']) {
        assert.ok(!working.includes(banned), `${id}: ${banned} never in What's Working`);
      }
      // What To Fix First lists only MESSAGING (the only negative category).
      const fixSection = paid.slice(paid.indexOf('What To Fix First'), paid.indexOf("What's Working"));
      assert.ok(fixSection.includes('MESSAGING'), `${id}: fix-first names the negative category`);
      assert.ok(!fixSection.includes('ORIGINALITY'), `${id}: fix-first never lists a no-negative-finding category`);
      // The aggregate line stays a receipt, never a card.
      assert.ok(paid.includes('2 lines of evidence'), `${id}: density receipt present`);
    } finally {
      app.server.close();
    }
  }
});