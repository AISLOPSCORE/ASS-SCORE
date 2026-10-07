import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';
import { short } from '../src/reportHtml.js';
/**
 * WHAT TO FIX FIRST — owner defects 2026-10-07 ("the section customers will
 * act on") and their fixes:
 *   1. every item now renders a fix-problem headline naming the concrete
 *      problem (the finding's own trigger line, not the roast);
 *   2. word-for-word identical (key, problem, action) items are deduped
 *      before the top-5 slice;
 *   3. truncation cuts at word boundaries (never mid-token), applied to both
 *      the action line (120) and the problem headline (160);
 *   4. a per-category cap of 2 keeps one hot category from filling all five
 *      slots, so ≥3 categories surface when ≥3 categories have negatives.
 * Rendering-only: scores/verdict/computation untouched.
 */
const SECRET = 'fixfirst-test-secret';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixfirst-test-')), 'test.db');
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
const fixSectionOf = (html) => html.slice(html.indexOf('What To Fix First'), html.indexOf('Your Breakdown'));

// ---------------------------------------------------------------------------
// 3. WORD-BOUNDARY TRUNCATION — the helper itself
// ---------------------------------------------------------------------------
test('fix-first: short() truncates at word boundaries — never mid-word, never to an empty string', () => {
  // The OLD helper cut mid-token: slice(0, n-1) gave 'word1 word2 wo…'.
  assert.equal(short('word1 word2 word3 word4', 14), 'word1 word2…', 'cut lands on the last space at/before n');
  assert.equal(short('The quick brown fox jumps over the lazy dog', 16), 'The quick brown…', 'word-boundary cut');
  // Trailing punctuation and whitespace are stripped before the ellipsis.
  assert.equal(short('Alpha beta, gamma delta', 15), 'Alpha beta…', 'trailing punctuation stripped');
  assert.equal(short('Alpha beta  gamma delta', 12), 'Alpha beta…', 'trailing whitespace stripped');
  // No space at all before n: hard cut (single token), never empty.
  assert.equal(short('x'.repeat(50), 20), `${'x'.repeat(20)}…`, 'hard cut for a single over-long token');
  assert.ok(short('abcdef', 1).length >= 1, 'never truncates to the empty string');
  // Under the limit (and non-strings): returned whole.
  assert.equal(short('short text', 120), 'short text');
  assert.equal(short(12345, 120), '12345');
});

// ---------------------------------------------------------------------------
// 1. HEADLINE + 3. TRUNCATION — rendered fix-first output
// ---------------------------------------------------------------------------
test('fix-first: each item renders a fix-problem headline naming the finding, truncated whole at 160; action whole at 120', async () => {
  const finding = 'repeated phrase in the page text: 2× This hero headline claims to change everything about how modern companies scale their operations overnight and it repeats the same promise three times on this page alone which makes the page read like a broken record to any visitor.';
  const fix = 'Rewrite the hero so it states one specific outcome with a number and then delete every repeated version of the promise from the rest of the page so each section says something new instead of echoing the same claim again and again until the reader stops trusting it.';
  assert.ok(finding.length > 160 && fix.length > 120, 'fixture strings exceed both limits');
  const dbPath = tmpDb();
  await insertScan(dbPath, { id: 'fixfirst-trunc', score: 60, breakdown: {
    repetitive: {
      score: 92,
      findings: [finding],
      insights: [{ roast: 'A fallback roast that never shows because the finding line exists.', why: 'Repeating the same promise reads as padding.', fix }],
    },
  } });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'fixfirst-trunc');
    const fixSection = fixSectionOf(html);
    const problem = /class="fix-problem">([^<\n]*)<\/p>/.exec(fixSection);
    const action = /class="fix-action">\s*<span class="fix-action-label">Fix it:<\/span> ([^<]*)<\/p>/.exec(fixSection);
    const actionText = action ? action[1].trim() : null;
    assert.ok(problem && action, 'one fix item carries both the headline and the action');
    // Headline = the finding's own trigger line (the problem), truncated at a
    // WORD BOUNDARY by the shared helper — NOT the old mid-word splice.
    assert.equal(problem[1], short(finding, 160), 'headline is the word-boundary-truncated finding');
    assert.notEqual(problem[1], `${finding.slice(0, 159)}…`, 'headline is NOT the old mid-word splice');
    assert.ok(problem[1].endsWith('…') && problem[1].length <= 161, 'over-long headline ends with ellipsis within the limit');
    // Action line keeps its 120 limit and the same word-boundary behavior.
    assert.equal(actionText, short(fix, 120), 'action is the word-boundary-truncated fix');
    assert.notEqual(actionText, `${fix.slice(0, 119)}…`, 'action is NOT the old mid-word splice');
    // The fallback rule: the headline must never be the roast when the
    // finding line exists.
    assert.ok(!problem[1].includes('fallback roast'), 'headline uses the finding, not the roast');
    // The item still links to its real finding — the deep-link machinery
    // (owner 2026-10-07) points at the finding card INSIDE its category view
    // (id="finding-<cat>-<n>"), never at the removed flat list; the target id
    // and the category anchor both exist in the report.
    assert.ok(fixSection.includes('href="#finding-repetitive-1"'), 'fix item deep-links to its finding card');
    assert.ok(html.includes('id="finding-repetitive-1"'), 'the deep-link target id exists in the report');
    assert.ok(html.includes('id="cat-repetitive"'), 'the category anchor exists in the report');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. DEDUPE — identical (key, problem, action) triples collapse
// ---------------------------------------------------------------------------
test('fix-first: word-for-word identical items collapse — same key, same roast, same fix renders once', async () => {
  const insight = {
    roast: 'The same lazy sentence, twice.',
    why: 'Repeating one line reads as filler instead of evidence.',
    fix: 'Write one distinct line and delete the duplicate.',
  };
  const dbPath = tmpDb();
  await insertScan(dbPath,
    { id: 'fixfirst-dup', score: 60, breakdown: {
      // Two IDENTICAL signals in one category with the SAME stored insight —
      // the per-category pool scenario that made every REPETITION item
      // word-for-word identical. The dedupe keeps the first occurrence only.
      repetitive: {
        score: 90,
        findings: ['repeated sentence openings: 2× "our platform"', 'repeated sentence openings: 2× "our platform"'],
        insights: [insight, insight],
      },
      filler: { score: 40, findings: ['2× "seamless"'] },
    } });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'fixfirst-dup');
    const fixSection = fixSectionOf(html);
    const problems = [...fixSection.matchAll(/class="fix-problem">([^<]*)</g)].map((m) => m[1]);
    // repetitive is the top scorer (90 > 40): its ONE surviving item is
    // first, then the COPY item — two distinct headlines total, and each
    // headline is the FINDING's trigger line (owner spec: the headline names
    // the concrete problem; the roast is the joke and never leads an item).
    assert.equal(problems.length, 2, 'the duplicated pair collapses to one item; the other category stays');
    assert.equal(problems[0], 'repeated sentence openings: 2× &quot;our platform&quot;', 'the survivor headline is the finding line');
    assert.ok(!problems.includes('The same lazy sentence, twice.'), 'the roast never becomes the headline while the finding exists');
    assert.equal(new Set(problems).size, problems.length, 'no two fix items share a problem headline');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. PER-CATEGORY CAP — one hot category never fills the top five
// ---------------------------------------------------------------------------
test('fix-first: one category with >2 negatives yields ≥3 distinct categories in the top-5', async () => {
  const dbPath = tmpDb();
  await insertScan(dbPath,
    { id: 'fixfirst-cap', score: 80, breakdown: {
      // 4 REPETITION negatives at the TOP score — the pre-fix render showed
      // five REPETITION items and nothing else. The cap admits at most 2 per
      // category, so COPY and IMAGERY surface.
      crossPage: {
        score: 95,
        findings: [
          'repeated phrase in the page text: 2× "Book a free demo today"',
          'repeated phrase in the page text: 2× "Trusted by hundreds of teams"',
          'repeated phrase in the page text: 2× "Schedule a call with our sales team"',
          'repeated phrase in the page text: 2× "Join thousands of happy customers"',
        ],
      },
      filler: { score: 78, findings: ['5× "cutting-edge"'] },
      assets: { score: 55, findings: ['3 of 4 images with placeholder/generic filenames'] },
    } });
  const app = startApp(dbPath);
  try {
    const html = await paidHtml(app.base, 'fixfirst-cap');
    const fixSection = fixSectionOf(html);
    const labels = [...fixSection.matchAll(/class="fix-cat">([^<]*)</g)].map((m) => m[1]);
    assert.ok(labels.length <= 5, 'top-5 cap still applies');
    assert.ok(labels.length >= 3, 'hot category pushed down far enough to leave ≥3 items');
    const distinct = new Set(labels);
    assert.ok(distinct.size >= 3, `≥3 distinct categories surface (got: ${[...distinct].join(', ')})`);
    for (const label of distinct) {
      const perCat = labels.filter((l) => l === label).length;
      assert.ok(perCat <= 2, `${label} contributes at most 2 items (got ${perCat})`);
    }
    // Order stays score-desc (REPETITION 95 first, COPY 78, IMAGERY 55) and
    // the category's own finding order is preserved inside the cap.
    assert.ok(labels[0] === 'REPETITION' && labels[1] === 'REPETITION', 'the hot category leads with its top 2 in order');
    assert.deepEqual([...distinct].sort(), ['COPY', 'IMAGERY', 'REPETITION'], 'all three categories present');
    // Every item still carries the headline + link.
    assert.equal((fixSection.match(/class="fix-problem">/g) ?? []).length, labels.length, 'every item names its problem');
    assert.equal((fixSection.match(/class="fix-link" href="#/g) ?? []).length, labels.length, 'every item links to its finding');
  } finally {
    app.server.close();
  }
});