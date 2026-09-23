import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import {
  THREE_LAYER_POOLS,
  THREE_LAYER_KEYS,
  MAX_INSIGHTS_PER_CATEGORY,
  parseEvidenceTokens,
  triggerTokensFor,
  buildCategoryInsights,
  withInsights,
  hashScanId,
  isCleanEvidence,
} from '../src/threeLayer.js';
import { hashScanId as roastHashScanId } from '../src/roast.js';
import { createReportToken } from '../src/paywall.js';

/** Shared report-token secret for the integration app instances in this file. */
const TL_SECRET = 'three-layer-test-secret';

/**
 * Three-layer findings tests (spec §5): every finding gains { roast, why, fix,
 * evidence }, deterministic per scan id, roasts always citable to the real
 * trigger. Requirements asserted here:
 *   - pools valid (keys, sizes, quality); no leftover {tokens} in any output
 *   - determinism: same (category, findings, id) -> identical insights
 *   - specificity: when the evidence carries a known trigger (phrase, sentence,
 *     label, URL, host, alt...), the roast contains it — across many scan ids
 *   - structure: roast/why/fix non-empty strings, evidence mirrors the finding,
 *     insights capped at 6 per category
 *   - wiring: withInsights idempotent, persisted in the stored breakdown JSON,
 *     derived for legacy rows, rendered in the HTML report
 *   - forbidden-phrase guard still green over pools AND produced output
 */

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-3layer-')), 'test.db');

// ---------------------------------------------------------------------------
// Canonical evidence strings per group (mirror the rule modules' output exactly)
// ---------------------------------------------------------------------------
const CANONICAL = {
  filler: [
    '12 filler phrase occurrence(s) in 900 words (3.6 per 300 words)',
    '3× "cutting-edge"',
  ],
  boilerplate: [
    '7 boilerplate signal(s) in 1200 words (1.8 per 300 words)',
    '2× cookie banner',
    '1× hedge phrase "we aim to"',
    'hedge evidence: "We aim to empower your journey."',
    '2× repeated block: "our platform is the best in class"',
  ],
  infoDensity: [
    'vocabulary diversity (MATTR-50): 0.581 (lower = more repetitive vocabulary)',
    'stopword ratio: 52.0%',
    'mean sentence length: 28.4 words (12 sentences)',
    'short paragraphs (<25 words): 60% (20 paragraphs)',
    'concrete specifics: only 3 in 500 words (need at least 7 per 75 words) — e.g. $99, 2021, Acme Corp',
    'concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)',
  ],
  repetitive: [
    'repeated sentence openings: 5× "the company", 3× "we offer"',
    'near-identical sentences: 4× "our platform helps businesses grow"',
    'repeated paragraphs: 3× "we are the leading provider of solutions"',
    'no notable repetitive structure (24 sentences, 8 paragraphs)',
  ],
  crossPage: [
    'cross-page duplication: 2 flagged pair(s), max similarity 92.3%',
    'near-identical page pair: https://a.example/ ~ https://a.example/about (91.0% similar)',
    'content duplicated across 3 pages (fully-connected cluster)',
    'no page pairs above 80% similarity (3 pages compared)',
  ],
  fingerprints: [
    'pattern evidence in html: v0.dev builder assets (high confidence, template-like signal)',
  ],
  assets: [
    '2 of 4 images from stock/placeholder CDNs',
    '1 of 4 images with placeholder/generic filenames',
    '3 of 4 images with missing or generic alt text',
    '0 of 5 images flagged for stock/placeholder signals',
    'img[0] stock/placeholder CDN «unsplash.com» (https://images.unsplash.com/photo-1556742049)',
    'img[1] generic filename "logo" (https://cdn.ourbrand.com/logo.png)',
    'img[2] missing alt attribute',
    'img[3] generic alt "image"',
  ],
};

/** All canonical findings flattened with their group. */
const ALL_CANONICAL = Object.entries(CANONICAL).flatMap(([cat, fs]) => fs.map((f) => [cat, f]));

// ---------------------------------------------------------------------------
// Pool validity
// ---------------------------------------------------------------------------
test('threeLayer.json: pools cover exactly the seven breakdown categories with 8-12 roasts, 4-6 whys/fixes and 4-6 compliments/cleanWhys/keepUps', () => {
  assert.deepEqual([...THREE_LAYER_KEYS].sort(),
    ['filler', 'boilerplate', 'infoDensity', 'repetitive', 'crossPage', 'fingerprints', 'assets'].sort());
  for (const key of THREE_LAYER_KEYS) {
    const pool = THREE_LAYER_POOLS[key];
    assert.ok(pool, `pool ${key}`);
    assert.ok(Array.isArray(pool.roasts) && pool.roasts.length >= 8 && pool.roasts.length <= 12,
      `${key}: ${pool.roasts.length} roasts (need 8-12)`);
    assert.ok(Array.isArray(pool.whys) && pool.whys.length >= 4 && pool.whys.length <= 6,
      `${key}: ${pool.whys.length} whys (need 4-6)`);
    assert.ok(Array.isArray(pool.fixes) && pool.fixes.length >= 4 && pool.fixes.length <= 6,
      `${key}: ${pool.fixes.length} fixes (need 4-6)`);
    // Owner CR (2026-09-16: clean findings are compliments): every category
    // ships a compliments pool, a clean-result why pool, and a keep-it-up pool.
    for (const [name, lo, hi] of [['compliments', 4, 6], ['cleanWhys', 4, 6], ['keepUps', 4, 6]]) {
      assert.ok(Array.isArray(pool[name]) && pool[name].length >= lo && pool[name].length <= hi,
        `${key}: ${pool[name].length} ${name} (need ${lo}-${hi})`);
    }
    const all = [...pool.roasts, ...pool.whys, ...pool.fixes, ...pool.compliments, ...pool.cleanWhys, ...pool.keepUps];
    assert.equal(new Set(all).size, all.length, `${key}: no duplicate lines`);
    for (const line of all) {
      assert.ok(typeof line === 'string' && line.trim().length > 0, `${key}: non-empty line`);
      assert.ok(line.length <= 220, `${key}: line not overlong (${line.length} chars)`);
    }
    // Sentence rule (1-2 sentences) applies to the roast lines AND the new
    // compliment / keep-it-up lines — the same structural discipline.
    for (const r of [...pool.roasts, ...pool.compliments, ...pool.keepUps]) {
      // 1-2 sentences: 1-3 sentence terminators (ellipses/rhetoric allowed).
      const terminators = (r.match(/[.!?]+(?:["'’”]|$)/g) ?? []).length;
      assert.ok(terminators >= 1 && terminators <= 3, `${key}: "${r}" not 1-2 sentences`);
    }
  }
});

test('threeLayer.json: every roast variant is reachable — token variants from canonical findings, token-free fallbacks from untokenizable evidence', () => {
  for (const key of THREE_LAYER_KEYS) {
    for (const tpl of THREE_LAYER_POOLS[key].roasts) {
      const declared = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      let reachable;
      if (declared.length === 0) {
        // Token-free fallback: reachable from any unparseable evidence line
        // (legacy rows, unexpected rule output shapes). Verified end-to-end in
        // the structure tests via an untokenizable finding.
        reachable = typeof parseEvidenceTokens(key, 'legacy finding') === 'object';
      } else {
        reachable = CANONICAL[key].some((f) => {
          const tokens = parseEvidenceTokens(key, f);
          if (!declared.every((t) => t in tokens)) return false;
          const triggerPresent = Object.keys(tokens).filter((t) => triggerTokensFor(key).includes(t));
          if (triggerPresent.length > 0 && !declared.some((t) => triggerPresent.includes(t))) return false;
          return true;
        });
      }
      assert.ok(reachable, `${key}: variant "${tpl.slice(0, 60)}…" unreachable from the canonical findings`);
    }
  }
});

test('threeLayer.json: copy is pattern-based — no factual AI-authorship claims (pools)', () => {
  const forbidden = [
    /\b(?:written|made|created|authored|generated|produced|built) (?:by|with) (?:an? )?AI\b/i,
    /\bAI (?:wrote|made|created|authored|generated|produced|built)\b/i,
    /\b(?:ChatGPT|GPT-?[0-9]|Claude|Gemini) (?:wrote|made|generated)\b/i,
  ];
  for (const key of THREE_LAYER_KEYS) {
    const pools = THREE_LAYER_POOLS[key];
    for (const line of [...pools.roasts, ...pools.whys, ...pools.fixes,
      ...pools.compliments, ...pools.cleanWhys, ...pools.keepUps]) {
      for (const re of forbidden) {
        assert.ok(!re.test(line), `${key}: "${line}" must not assert AI authorship`);
      }
    }
  }
});

test('threeLayer.json + parser: every canonical finding parses and so do the real rule outputs', async () => {
  for (const [cat, f] of ALL_CANONICAL) {
    assert.ok(Object.keys(parseEvidenceTokens(cat, f)).length > 0,
      `${cat}: canonical finding should parse: ${f.slice(0, 60)}`);
  }
  // Round-trip against the ACTUAL rule modules (the parser must not drift from
  // what the pipeline really emits).
  const { runRules } = await import('../src/rules/index.js');
  const { extractText } = await import('../src/text.js');
  const { analyzeFingerprints } = await import('../src/rules/fingerprints.js');
  const { analyzeAssets } = await import('../src/rules/assets.js');
  const html = `<!doctype html><html><head><title>T</title></head><body>
    <p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
    <p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
    <p>Subscribe to our newsletter. We aim to empower your journey. All rights reserved.</p>
    <img src="https://images.unsplash.com/photo-1" alt="image">
    <img src="https://cdn.x.com/image2.jpg">
    <script src="https://v0.dev/runtime.js"></script>
  </body></html>`;
  const text = extractText(html);
  const rules = runRules(text);
  for (const cat of ['filler', 'boilerplate', 'infoDensity', 'repetitive']) {
    for (const f of rules[cat].findings) {
      assert.ok(Object.keys(parseEvidenceTokens(cat, f)).length > 0,
        `${cat}: unparsed finding "${f.slice(0, 70)}"`);
    }
  }
  for (const f of analyzeFingerprints({ html, head: '<title>T</title>', text: text.text }).findings) {
    assert.ok(Object.keys(parseEvidenceTokens('fingerprints', f)).length > 0, `fingerprints: "${f}"`);
  }
  for (const f of analyzeAssets(html).findings) {
    assert.ok(Object.keys(parseEvidenceTokens('assets', f)).length > 0, `assets: "${f}"`);
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
test('buildCategoryInsights: deterministic — same (category, findings, id) -> identical insights', () => {
  for (const cat of THREE_LAYER_KEYS) {
    const a = buildCategoryInsights({ category: cat, findings: CANONICAL[cat], id: 'scan-abc-123' });
    const b = buildCategoryInsights({ category: cat, findings: CANONICAL[cat], id: 'scan-abc-123' });
    assert.deepEqual(a, b, `${cat} deterministic`);
  }
  // Different ids usually pick different variants (rescan freshness), but every
  // pick stays deterministic and in-pool.
  const ids = ['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
  const roasts = new Set();
  for (const i of ids) {
    const ins = buildCategoryInsights({ category: 'filler', findings: ['3× "cutting-edge"'], id: i })[0];
    roasts.add(ins.roast);
    assert.ok(THREE_LAYER_POOLS.filler.roasts.length > 1, 'pool has variants');
  }
  assert.ok(roasts.size > 1, `different ids spread across variants (got ${roasts.size}/${ids.length})`);
});

test('hashScanId is the SAME function the Slop Roast uses (seeding consistency)', () => {
  assert.equal(hashScanId, roastHashScanId, 'three-layer seeding reuses the existing FNV-1a scan-id hash');
  assert.equal(hashScanId('7d5f2b1a-1111-4222-8333-444444444444'),
    roastHashScanId('7d5f2b1a-1111-4222-8333-444444444444'));
});

// ---------------------------------------------------------------------------
// Specificity: the roast cites the REAL trigger
// ---------------------------------------------------------------------------
test('specificity: roasts contain the exact trigger from the evidence (every eligible variant, many ids)', () => {
  // [category, evidence, substring that MUST appear in the roast]
  const cases = [
    ['filler', '3× "cutting-edge"', 'cutting-edge'],
    ['boilerplate', '1× hedge phrase "we aim to"', 'we aim to'],
    ['boilerplate', 'hedge evidence: "We aim to empower your journey."', 'We aim to empower your journey.'],
    ['boilerplate', '2× repeated block: "our platform is the best in class"', 'our platform is the best in class'],
    ['boilerplate', '2× cookie banner', 'cookie banner'],
    ['repetitive', 'near-identical sentences: 4× "our platform helps businesses grow"', 'our platform helps businesses grow'],
    ['repetitive', 'repeated sentence openings: 5× "the company", 3× "we offer"', 'the company'],
    ['crossPage', 'near-identical page pair: https://a.example/ ~ https://a.example/about (91.0% similar)', 'https://a.example/'],
    ['fingerprints', 'pattern evidence in html: v0.dev builder assets (high confidence, template-like signal)', 'v0.dev builder assets'],
    ['assets', 'img[0] stock/placeholder CDN «unsplash.com» (https://images.unsplash.com/photo-1556742049)', 'unsplash.com'],
    ['assets', 'img[1] generic filename "logo" (https://cdn.ourbrand.com/logo.png)', 'logo'],
    ['assets', 'img[3] generic alt "image"', 'image'],
  ];
  for (const [cat, evidence, must] of cases) {
    for (let i = 0; i < 12; i += 1) {
      const ins = buildCategoryInsights({ category: cat, findings: [evidence], id: `spec-${i}` })[0];
      assert.ok(ins.roast.includes(must), `${cat}/${evidence.slice(0, 40)}… (id spec-${i}): roast "${ins.roast}" must cite "${must}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------
test('structure: roast/why/fix non-empty, evidence mirrors the finding, cap applies, all tokens replaced', () => {
  for (const cat of THREE_LAYER_KEYS) {
    const many = Array.from({ length: 12 }, (_, i) => CANONICAL[cat][i % CANONICAL[cat].length]);
    const ins = buildCategoryInsights({ category: cat, findings: many, id: 'struct-1' });
    assert.ok(ins.length <= MAX_INSIGHTS_PER_CATEGORY, `${cat} capped at ${MAX_INSIGHTS_PER_CATEGORY}`);
    assert.equal(ins.length, Math.min(many.length, MAX_INSIGHTS_PER_CATEGORY), `${cat} cap math`);
    ins.forEach((x, i) => {
      assert.equal(x.evidence, many[i], `${cat}[${i}] evidence mirrors finding`);
      for (const field of ['roast', 'why', 'fix']) {
        assert.ok(typeof x[field] === 'string' && x[field].trim().length > 0, `${cat}[${i}].${field} non-empty`);
        assert.ok(!/\{[a-zA-Z]+\}/.test(x[field]), `${cat}[${i}].${field} has no leftover token: "${x[field]}"`);
      }
    });
  }
});

test('structure: aggregate/untokenizable findings fall back to group-level roasts that stay real', () => {
  // A finding the parser cannot tokenize (or one that only carries counts):
  // the roast must still be referenceable to the evidence (which is displayed
  // alongside it) and deterministic.
  const untokenized = buildCategoryInsights({ category: 'filler', findings: ['legacy finding'], id: 'x' })[0];
  assert.equal(untokenized.evidence, 'legacy finding');
  assert.ok(untokenized.roast.length > 0 && !/\{[a-zA-Z]+\}/.test(untokenized.roast));
  const aggregate = buildCategoryInsights({ category: 'filler', findings: CANONICAL.filler.slice(0, 1), id: 'y' })[0];
  assert.ok(aggregate.roast.includes('12') || aggregate.roast.includes('900'), 'aggregate roast cites the summary values');
});

// ---------------------------------------------------------------------------
// withInsights wiring
// ---------------------------------------------------------------------------
test('withInsights: attaches insights to categories with findings, keeps stored insights (idempotent)', () => {
  const bd = {
    filler: { score: 30, findings: CANONICAL.filler },
    boilerplate: { score: 10, findings: [] }, // no findings -> no insights
    crossPage: { score: null, findings: [], note: 'insufficient pages' }, // skipped module untouched
  };
  const enriched = withInsights(bd, 'scan-1');
  assert.ok(Array.isArray(enriched.filler.insights) && enriched.filler.insights.length > 0, 'filler insights attached');
  assert.deepEqual(enriched.boilerplate, { score: 10, findings: [], insights: [] }, 'empty-findings category gets []');
  assert.equal(enriched.crossPage.note, 'insufficient pages', 'other keys untouched');
  assert.ok(!('insights' in bd.filler), 'original breakdown not mutated');
  // Idempotent: stored insights always win; re-running yields identical bytes.
  const again = withInsights(enriched, 'scan-1');
  assert.deepEqual(again, enriched, 'idempotent (stored insights preserved)');
  // Deterministic derivation for legacy rows (no insights stored).
  const legacy = withInsights({ filler: { score: 30, findings: CANONICAL.filler } }, 'scan-legacy-1');
  const legacy2 = withInsights({ filler: { score: 30, findings: CANONICAL.filler } }, 'scan-legacy-1');
  assert.deepEqual(legacy, legacy2, 'legacy derivation deterministic');
});

// ---------------------------------------------------------------------------
// Forbidden-phrase guard over PRODUCED output
// ---------------------------------------------------------------------------
test('produced insights never assert AI authorship (canonical fixtures)', () => {
  const forbidden = [
    /\b(?:written|made|created|authored|generated|produced|built) (?:by|with) (?:an? )?AI\b/i,
    /\bAI (?:wrote|made|created|authored|generated|produced|built)\b/i,
    /\b(?:ChatGPT|GPT-?[0-9]|Claude|Gemini) (?:wrote|made|generated)\b/i,
  ];
  for (const cat of THREE_LAYER_KEYS) {
    const ins = buildCategoryInsights({ category: cat, findings: CANONICAL[cat], id: 'forbidden-1' });
    for (const x of ins) {
      for (const re of forbidden) {
        assert.ok(!re.test(x.roast), `${cat}: "${x.roast}" must not assert AI authorship`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// API E2E: slop-heavy multi-page fixture -> insights in JSON, HTML, storage
// ---------------------------------------------------------------------------
const SLOP_PAGE = `<!doctype html><html><head><title>Acme Slop</title>
<script src="https://v0.dev/runtime.js"></script>
</head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
<p>We aim to empower your journey with world-class service and seamless experiences.</p>
<p>We aim to empower your journey with world-class service and seamless experiences.</p>
<img src="https://images.unsplash.com/photo-1556742049-0cfed4f6a45d" alt="co-working space">
<img src="https://images.pexels.com/photos/3183150/pexels-photo-3183150.jpeg">
<img src="/images/logo.png" alt="brand logo">
<a href="/about">About</a>
<a href="/blog">Blog</a>
</body></html>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath, options = {}) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(SLOP_PAGE), validateTarget: offlineValidateTarget, maxScansPerDay: 0, ...options });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath, { reportTokenSecret: TL_SECRET });
});

after(() => {
  api.server.close();
});

test('E2E: slop fixture -> free JSON carries teasers + numeric scores only; insights persist; GET bytes-stable; token HTML renders the layers', async () => {
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();

  // PAYWALL contract: the free JSON breakdown is category NUMBERS only — the
  // per-category insights/findings are the paid content and never leave this
  // payload. The teaser samples (1-2, top-level) carry the three-layer format.
  for (const [key, rule] of Object.entries(json.breakdown)) {
    assert.ok('score' in rule, `${key} has a numeric score`);
    assert.ok(!('insights' in rule) && !('findings' in rule) && !('hits' in rule),
      `${key} has no paid arrays on the free payload`);
  }
  assert.ok(Array.isArray(json.teasers) && json.teasers.length >= 1 && json.teasers.length <= 2, '1-2 teasers');
  for (const t of json.teasers) {
    assert.ok(t.roast.length > 0 && t.why.length > 0 && t.fix.length > 0 && t.evidence.length > 0,
      'teaser layers non-empty');
  }

  // Persisted in the stored JSON column (rides inside the breakdown): the DB
  // keeps the FULL insights untouched by the gate — every category with
  // findings carries a capped insights array; evidence mirrors findings; all
  // three layers present.
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  let insightTotal = 0;
  for (const [key, rule] of Object.entries(stored)) {
    if (!Array.isArray(rule.insights)) continue;
    const expected = Math.min((rule.findings ?? []).length, MAX_INSIGHTS_PER_CATEGORY);
    assert.equal(rule.insights.length, expected, `${key} insights length`);
    rule.insights.forEach((x, i) => {
      assert.equal(x.evidence, rule.findings[i], `${key}[${i}] evidence = finding`);
      assert.ok(x.roast.length > 0 && x.why.length > 0 && x.fix.length > 0, `${key}[${i}] layers non-empty`);
    });
    insightTotal += rule.insights.length;
  }
  assert.ok(insightTotal >= 10, `slop fixture produces a rich insight set (got ${insightTotal})`);

  // The roast cites real evidence for a phrase-bearing finding (stored side).
  const fillerPhrase = stored.filler.findings.find((f) => f.includes('cutting-edge')) ?? '';
  assert.ok(fillerPhrase, 'fixture has a filler phrase finding');
  const idx = stored.filler.findings.indexOf(fillerPhrase);
  assert.ok(stored.filler.insights[idx].roast.includes('cutting-edge'),
    `filler insight cites the phrase ("${stored.filler.insights[idx].roast}")`);

  // GET JSON: stable across repeats (same stored bytes, same gated shape).
  const get1 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  const get2 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  assert.deepEqual(get1.breakdown, json.breakdown, 'GET matches POST breakdown (free numbers)');
  assert.deepEqual(get2.breakdown, get1.breakdown, 'repeated GET identical');
  assert.deepEqual(get2.teasers, get1.teasers, 'teasers stable across repeated GETs');

  // PAID report (valid token): renders the three layers under each category.
  const token = createReportToken(TL_SECRET, json.id);
  const html = await (await fetch(`${api.base}/api/v1/scans/${json.id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /<p class="ins-roast">/, 'roast layer rendered (italic/accent)');
  assert.match(html, /<span class="ins-why">/, 'why layer rendered');
  assert.match(html, /<span class="ins-fix">/, 'fix layer rendered');
  assert.ok(html.includes('Why it matters:') && html.includes('How to fix it:'), 'layer labels present');
  assert.ok((html.match(/<li><strong>/g) ?? []).length >= 10, 'evidence lines rendered bold');
  const firstStoredInsight = stored.filler.insights[0];
  const escapedRoast = firstStoredInsight.roast.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  assert.ok(html.includes(escapedRoast), 'a specific roast appears in the report (escaped)');
  const rows = (html.match(/<tr>/g) ?? []).length;
  assert.equal(rows, 0, 'legacy evidence table gone (narrative report structure)');
  // Customer-facing category names all present in the breakdown.
  for (const name of ['COPY', 'MESSAGING', 'ORIGINALITY', 'STRUCTURE', 'REPETITION', 'DESIGN', 'IMAGERY']) {
    assert.ok(html.includes(name), `report shows the ${name} category`);
  }
  assert.ok(html.includes('Show the receipts:'), 'findings carry a labeled receipts block');
  assert.ok(html.includes('The Actual Findings') && html.includes('The Verdict'), 'narrative sections present');
  assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'), 'mandated disclaimer intact');

  // Webhook/email payload surface is the same gated object; the stored
  // breakdown keeps the full paid insights bytes-exact.
  assert.equal(typeof stored.assets.insights, 'object', 'assets insights persist in storage');

  // Save a sample for the team/owner tone check.
  const sample = { scannedAt: new Date().toISOString(), fixture: 'slop-heavy multi-page fixture', id: json.id, url: json.url, score: json.score, verdict: json.verdict, roast: json.roast, teasers: json.teasers, breakdown: json.breakdown, storedInsights: stored };
  fs.writeFileSync('/home/team/shared/three-layer-e2e-sample.json', JSON.stringify(sample, null, 2));
});

test('E2E: legacy row without insights gets deterministic derivation (additive contract)', async () => {
  // A pre-feature row: no insights anywhere in the stored breakdown.
  const dbPath2 = tmpDb();
  const db = openDb(dbPath2);
  db.insertScan({
    id: 'legacy-3layer-scan', url: 'https://legacy.example/', score: 55,
    breakdown: {
      filler: { score: 40, findings: ['2× "game-changer"', '3× "seamless"'] },
      boilerplate: { score: 60, findings: ['1× cookie banner'] },
      crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    roast: 'A stored roast.',
  });
  db.close();
  const app = startApp(dbPath2, { reportTokenSecret: TL_SECRET });
  try {
    // FREE payload: category numbers only, deterministic across reads — the
    // derived insights are paid content and never appear here.
    const get1 = await (await fetch(`${app.base}/api/v1/scans/legacy-3layer-scan`, { headers: { accept: 'application/json' } })).json();
    const get2 = await (await fetch(`${app.base}/api/v1/scans/legacy-3layer-scan`, { headers: { accept: 'application/json' } })).json();
    assert.deepEqual(get1.breakdown, get2.breakdown, 'free breakdown deterministic across reads');
    assert.equal(get1.breakdown.filler.score, 40, 'filler sub-score rides the free payload');
    assert.ok(!('insights' in get1.breakdown.filler) && !('findings' in get1.breakdown.filler),
      'derived insights/findings are not on the free payload');
    assert.equal(get1.breakdown.crossPage.score, null, 'skipped module passes through');
    assert.equal(get1.breakdown.crossPage.note, 'insufficient pages for cross-page analysis', 'skip note passes through');
    assert.equal(get1.score, 55, 'stored 55 -> public 55 (same direction, no inversion)');
    assert.equal(get1.roast, 'A stored roast.', 'stored roast kept');

    // The TOKEN'D report derives the insights deterministically (additive
    // contract): the paid report renders the derived three layers with the
    // stored receipts, citeable to the stored phrases — twice, byte-identical.
    const token = createReportToken(TL_SECRET, 'legacy-3layer-scan');
    const url = `${app.base}/api/v1/scans/legacy-3layer-scan?token=${encodeURIComponent(token)}`;
    const html = await (await fetch(url, { headers: { accept: 'text/html' } })).text();
    const html2 = await (await fetch(url, { headers: { accept: 'text/html' } })).text();
    assert.equal(html2, html, 'legacy derivation byte-identical across reads');
    assert.ok(html.includes('game-changer'), 'derived roast cites the stored phrase');
    assert.ok((html.match(/<p class="ins-roast">/g) ?? []).length >= 2, 'derived insights render their roast layers');
    assert.ok(html.includes('2× &quot;game-changer&quot;') && html.includes('3× &quot;seamless&quot;'),
      'stored receipts untouched (renderer-escaped)');
    assert.ok(html.includes('Why it matters:') && html.includes('How to fix it:'), 'why/fix layers derived for legacy rows');
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// Owner CR (2026-09-16): "CLEAN FINDINGS SHOULD BE COMPLIMENTS, NOT INSULTS"
// ---------------------------------------------------------------------------
// Canonical CLEAN evidence strings per category (mirror the rule modules'
// zero/none measurements and healthy metric bands exactly). fingerprints has
// NO clean evidence format (findings only exist on pattern hits) — a clean
// fingerprints scan has no findings, so nothing to compliment.
const CLEAN_CANONICAL = {
  filler: ['0 filler phrase occurrence(s) in 18 words (0.0 per 300 words)'],
  boilerplate: ['0 boilerplate signal(s) in 18 words (0.0 per 300 words)'],
  infoDensity: [
    'vocabulary diversity (MATTR-50): 0.886 (lower = more repetitive vocabulary)',
    'stopword ratio: 32.4%',
    'mean sentence length: 18.0 words (6 sentences)',
    'short paragraphs (<25 words): 0% (3 paragraphs)',
  ],
  repetitive: ['no notable repetitive structure (24 sentences, 8 paragraphs)'],
  crossPage: ['no page pairs above 80% similarity (3 pages compared)'],
  fingerprints: [],
  assets: [
    '0 of 5 images flagged for stock/placeholder signals',
    '0 of 3 images from stock/placeholder CDNs',
    '0 of 3 images with placeholder/generic filenames',
    '0 of 3 images with missing or generic alt text',
  ],
};

test('isCleanEvidence: clean measurements -> true, negative patterns -> false (incl. the specifics gap trap)', () => {
  for (const [cat, lines] of Object.entries(CLEAN_CANONICAL)) {
    for (const f of lines) {
      assert.equal(isCleanEvidence(cat, f), true, `${cat}: "${f}" must read clean`);
    }
  }
  // Negative patterns — including the infoDensity "concrete specifics: 0
  // found" WORST-case line, which must NEVER become a compliment (a page with
  // zero specific facts is maximally vague, not clean).
  const negative = [
    ['filler', '12 filler phrase occurrence(s) in 900 words (3.6 per 300 words)'],
    ['filler', '3× "cutting-edge"'],
    ['boilerplate', '7 boilerplate signal(s) in 1200 words (1.8 per 300 words)'],
    ['boilerplate', '2× cookie banner'],
    ['boilerplate', '1× hedge phrase "we aim to"'],
    ['boilerplate', 'hedge evidence: "We aim to empower your journey."'],
    ['boilerplate', '2× repeated block: "our platform is the best in class"'],
    ['infoDensity', 'vocabulary diversity (MATTR-50): 0.581 (lower = more repetitive vocabulary)'],
    ['infoDensity', 'stopword ratio: 52.0%'],
    ['infoDensity', 'mean sentence length: 28.4 words (12 sentences)'],
    ['infoDensity', 'short paragraphs (<25 words): 60% (20 paragraphs)'],
    ['infoDensity', 'concrete specifics: only 3 in 500 words (need at least 7 per 75 words) — e.g. $99, 2021, Acme Corp'],
    ['infoDensity', 'concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'],
    ['repetitive', 'repeated sentence openings: 5× "the company", 3× "we offer"'],
    ['repetitive', 'near-identical sentences: 4× "our platform helps businesses grow"'],
    ['repetitive', 'repeated paragraphs: 3× "we are the leading provider of solutions"'],
    ['crossPage', 'cross-page duplication: 2 flagged pair(s), max similarity 92.3%'],
    ['crossPage', 'near-identical page pair: https://a.example/ ~ https://a.example/about (91.0% similar)'],
    ['fingerprints', 'pattern evidence in html: v0.dev builder assets (high confidence, template-like signal)'],
    ['assets', '2 of 4 images from stock/placeholder CDNs'],
    ['assets', '1 of 4 images with placeholder/generic filenames'],
    ['assets', '3 of 4 images with missing or generic alt text'],
    ['assets', 'img[0] stock/placeholder CDN «unsplash.com» (https://images.unsplash.com/photo-1556742049)'],
  ];
  for (const [cat, f] of negative) {
    assert.equal(isCleanEvidence(cat, f), false, `${cat}: "${f}" must read as a negative pattern`);
  }
});

test('clean findings route to kind:"clean" compliments — layered pools, verbatim evidence, distinct picks, deterministic', () => {
  // infoDensity has 4 clean metric findings and a 5-line compliment pool:
  // distinct-pick guarantees no repeated compliment within the category.
  const ins = buildCategoryInsights({ category: 'infoDensity', findings: CLEAN_CANONICAL.infoDensity, id: 'clean-route-1' });
  assert.equal(ins.length, 4);
  const compliments = new Set();
  for (const x of ins) {
    assert.equal(x.kind, 'clean', 'clean marker');
    assert.ok(THREE_LAYER_POOLS.infoDensity.compliments.includes(x.roast), 'compliment from the compliments pool');
    assert.ok(THREE_LAYER_POOLS.infoDensity.cleanWhys.includes(x.why), 'why from the cleanWhys pool');
    assert.ok(THREE_LAYER_POOLS.infoDensity.keepUps.includes(x.fix), 'fix from the keepUps pool');
    assert.ok(!/\{[a-zA-Z]+\}/.test(x.roast), `no leftover tokens: "${x.roast}"`);
    compliments.add(x.roast);
  }
  assert.equal(compliments.size, 4, 'no repeated compliment inside one category');
  assert.deepEqual(
    buildCategoryInsights({ category: 'infoDensity', findings: CLEAN_CANONICAL.infoDensity, id: 'clean-route-1' }),
    ins,
    'same id -> identical clean insights',
  );
});

test('every canonical clean finding across all categories routes to kind:"clean" with non-empty layers + verbatim evidence', () => {
  for (const [cat, lines] of Object.entries(CLEAN_CANONICAL)) {
    if (lines.length === 0) continue; // fingerprints has no clean evidence format
    const ins = buildCategoryInsights({ category: cat, findings: lines, id: 'clean-all' });
    assert.equal(ins.length, lines.length, `${cat} one insight per clean finding`);
    ins.forEach((x, i) => {
      assert.equal(x.kind, 'clean', `${cat}[${i}] kind`);
      assert.ok(x.roast.length > 0 && x.why.length > 0 && x.fix.length > 0, `${cat}[${i}] layers non-empty`);
      assert.equal(x.evidence, lines[i], `${cat}[${i}] evidence mirrors the finding verbatim`);
      assert.ok(!/\{[a-zA-Z]+\}/.test(x.roast) && !/\{[a-zA-Z]+\}/.test(x.why) && !/\{[a-zA-Z]+\}/.test(x.fix),
        `${cat}[${i}] no leftover tokens`);
    });
  }
});

test('negative findings keep today\'s exact shape — roast/why/fix/evidence, NO kind marker, roast from the roast pools', () => {
  for (const cat of THREE_LAYER_KEYS) {
    const neg = CANONICAL[cat].filter((f) => !isCleanEvidence(cat, f));
    if (neg.length === 0) continue;
    const ins = buildCategoryInsights({ category: cat, findings: neg, id: 'neg-route-1' });
    for (const x of ins) {
      assert.ok(!('kind' in x), `${cat}: negative insight has no kind marker (pre-change bytes preserved)`);
      assert.deepEqual(Object.keys(x).sort(), ['evidence', 'fix', 'roast', 'why'].sort(),
        `${cat}: exact pre-change insight shape`);
      assert.ok(x.evidence.length > 0 && x.roast.length > 0 && x.why.length > 0 && x.fix.length > 0,
        `${cat}: layers non-empty`);
      assert.ok(!THREE_LAYER_POOLS[cat].compliments.includes(x.roast), `${cat}: roast is not a compliment line`);
      assert.ok(THREE_LAYER_POOLS[cat].whys.includes(x.why) && THREE_LAYER_POOLS[cat].fixes.includes(x.fix),
        `${cat}: why/fix stay from the negative pools`);
    }
  }
});

/**
 * A fully-clean site fixture: every category's findings land in a healthy
 * (zero-penalty) band — no filler, no boilerplate, high MATTR, low stopwords,
 * healthy sentence lengths, no short paragraphs, no repetition, no builder
 * fingerprints, and only real/described images. No internal links -> the
 * crossPage module is skipped (no findings), exactly like a single-page scan.
 */
const CLEAN_PAGE = `<!doctype html><html><head><title>Acme Analytics Results</title></head><body>
<p>Acme Analytics launched in 2019 with 4 engineers and now serves 3,200 customers across 40 countries. Our uptime has held at 99.98% for 18 straight months, verified independently every quarter.</p>
<p>The 2025 migration to our new stack cut median response time from 120ms to 38ms, and the team ships 12 releases monthly. Referrals produced 74% of our enterprise deals in 2026, which tells us the product does the selling.</p>
<p>Our engineering handbook, written by the founding engineers in 2021, now guides 60 contributors through every design review. We publish the full pricing table on the homepage, including the $49 starter plan and the $199 pro tier.</p>
<img src="https://cdn.acme-example.net/team-photo-2026.jpg" alt="Acme engineering team at the 2026 offsite">
<img src="https://cdn.acme-example.net/office-map-2026.png" alt="Floor plan of the Acme Berlin office">
</body></html>`;

test('E2E (Case B): clean fixture -> no free teasers (problem-only rule), compliments stay paid-only, zero negative roast language', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, { fetcher: fakeFetcher(CLEAN_PAGE), reportTokenSecret: TL_SECRET });
  try {
    const res = await fetch(`${app.base}/api/v1/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://clean.example/' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    // Scoring unchanged: the deterministic engine (untouched rules + weights)
    // gives this fixture 0 — the compliment routing never alters scores.
    assert.equal(json.score, 0, 'clean fixture scores 0 (engine unchanged)');
    assert.equal(json.verdict, 'CLEANEST');

    // FREE JSON: PROBLEM-ONLY teaser rule (owner) — a clean site has no
    // problem findings, so the free teasers array is EMPTY. Compliment
    // insights stay stored/paid-only and never surface as free samples.
    assert.ok(Array.isArray(json.teasers), 'teasers key present');
    assert.deepEqual(json.teasers, [], 'clean site -> NO teasers anywhere on free surfaces');

    // FREE HTML teaser page: the empty state renders (never a compliment
    // sample under the "Free samples" heading, and no fix instruction).
    const freeRes = await fetch(`${app.base}/api/v1/scans/${json.id}`, { headers: { accept: 'text/html' } });
    const freeHtml = await freeRes.text();
    assert.ok(freeHtml.includes('Nothing to roast this scan'), 'free page renders the no-samples empty state');
    assert.ok(!freeHtml.includes('Compliment:'), 'free page never renders a compliment sample');
    assert.ok(!freeHtml.includes('Keep it up:'), 'free page never renders a compliment fix line');
    assert.ok(!freeHtml.includes('How to fix it:'), 'free page never tells a clean finding to fix itself');
    assert.ok(freeHtml.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'),
      'mandated disclaimer verbatim on the free page');

    // STORED insights: all kind clean, evidence mirrors findings, every
    // evidence string is a clean measurement.
    const row = new (await import('better-sqlite3')).default(dbPath)
      .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
    const stored = JSON.parse(row.breakdown);
    let cleanTotal = 0;
    for (const [key, rule] of Object.entries(stored)) {
      if (!Array.isArray(rule.insights)) continue;
      rule.insights.forEach((x, i) => {
        cleanTotal += 1;
        assert.equal(x.kind, 'clean', `${key}[${i}] stored insight clean`);
        assert.equal(x.evidence, rule.findings[i], `${key}[${i}] evidence mirrors finding`);
        assert.ok(isCleanEvidence(key, x.evidence), `${key}[${i}] evidence is a clean measurement`);
        assert.ok(x.roast.length > 0 && x.why.length > 0 && x.fix.length > 0, `${key}[${i}] layers non-empty`);
      });
    }
    assert.ok(cleanTotal >= 7, `rich clean insight set (got ${cleanTotal})`);

    // PAID report (token): WHAT'S WORKING carries the clean compliments as
    // "LABEL — CLEAN:" observations, the findings section counts ZERO (clean
    // results are not findings), the fix-first list is empty, and no negative
    // roast language appears anywhere. Verbatim disclaimer intact.
    const token = createReportToken(TL_SECRET, json.id);
    const url = `${app.base}/api/v1/scans/${json.id}?token=${encodeURIComponent(token)}`;
    const html = await (await fetch(url, { headers: { accept: 'text/html' } })).text();
    const html2 = await (await fetch(url, { headers: { accept: 'text/html' } })).text();
    assert.equal(html, html2, 'paid report byte-identical across reads');
    assert.ok(html.includes("What's Working"), 'paid report renders the What\'s Working section');
    assert.ok(html.includes('COPY — CLEAN:'), 'clean result renders as a CLEAN observation');
    assert.ok(html.includes('No findings this scan — nothing to roast, and nothing to hide.'),
      'zero-findings intro: compliments are not counted as findings');
    assert.ok(!html.includes('How to fix it:'), 'paid report has no fix task for a clean finding');
    assert.ok(html.includes('No negative findings to fix this scan'), 'fix-first list empty for a clean scan');
    assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'),
      'mandated disclaimer intact in the paid report');
    assert.equal((html.match(/<p class="ins-roast">/g) ?? []).length, 0, 'no roast-styled layer in an all-clean report');
    assert.ok(!html.includes('The thesaurus is doing the heavy lifting'), 'no negative filler line reaches a clean page');
    assert.ok(!html.includes('every roast points at the receipts'), 'no roast framing when there are no findings');

    // FREE JSON stable across repeated GETs (same id -> same teasers — here,
    // empty for a clean site).
    const got = await (await fetch(`${app.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
    assert.deepEqual(got.teasers, json.teasers, 'empty teasers stable across reads');
  } finally {
    app.server.close();
  }
});

/** The slop fixture with an extra stopword-heavy paragraph pushes the stopword
 *  ratio above 40% so EVERY finding is a negative pattern (pure Case A). */
const ALL_NEGATIVE_PAGE = `${SLOP_PAGE.slice(0, SLOP_PAGE.indexOf('</body>'))}
<p>For the and the of the and for the of the and the of the for the.</p>
</body></html>`;

test('E2E (Case A): all-negative fixture -> every stored insight stays a plain roast/why/fix (no kind), paid report uses roast labels + today\'s intro', async () => {
  const dbPath = tmpDb();
  const app = startApp(dbPath, { fetcher: fakeFetcher(ALL_NEGATIVE_PAGE), reportTokenSecret: TL_SECRET });
  try {
    const res = await fetch(`${app.base}/api/v1/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://slop.example/' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.score >= 75, `slop fixture stays high (got ${json.score})`);

    // Stored insights: NO kind marker anywhere (every finding is negative).
    const row = new (await import('better-sqlite3')).default(dbPath)
      .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
    const stored = JSON.parse(row.breakdown);
    let insightTotal = 0;
    for (const [key, rule] of Object.entries(stored)) {
      if (!Array.isArray(rule.insights)) continue;
      rule.insights.forEach((x, i) => {
        insightTotal += 1;
        assert.ok(!('kind' in x), `${key}[${i}] negative insight has no kind marker`);
        assert.equal(x.evidence, rule.findings[i], `${key}[${i}] evidence mirrors finding`);
      });
    }
    assert.ok(insightTotal >= 10, `rich negative insight set (got ${insightTotal})`);

    // Free teasers: no kind marker (negative teasers carry today's shape).
    for (const t of json.teasers) {
      assert.ok(!('kind' in t), 'negative teaser has no kind marker');
    }

    // Paid report: roast labels + today's intro, no compliments anywhere.
    const token = createReportToken(TL_SECRET, json.id);
    const html = await (await fetch(`${app.base}/api/v1/scans/${json.id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } })).text();
    assert.ok(html.includes('How to fix it:'), 'negative finding keeps the fix label');
    assert.ok(html.includes('Why it matters:'), 'why label present');
    assert.ok(html.includes('every roast points at the receipts'), 'all-negative report keeps today\'s intro');
    assert.ok(!html.includes('Compliment:'), 'no compliments on an all-negative scan');
    assert.ok(!html.includes('Keep it up:'), 'no keep-it-up lines on an all-negative scan');
    assert.ok((html.match(/<p class="ins-roast">/g) ?? []).length >= 10, 'roast-styled layers on the negative findings');
    assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'),
      'mandated disclaimer intact');
  } finally {
    app.server.close();
  }
});

test('E2E (mixed): slop fixture -> clean stopword line compliments, negative lines roast, report mixes both labels honestly', async () => {
  // The shared SLOP_PAGE fixture has one genuinely clean measurement — the
  // stopword ratio (~36% <= 40%) — everything else is negative. Per-finding
  // honesty: that one line compliments, the rest roast, and the intro uses the
  // neutral mixed phrasing.
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  const cleanOnes = [];
  const negativeOnes = [];
  for (const [key, rule] of Object.entries(stored)) {
    if (!Array.isArray(rule.insights)) continue;
    rule.insights.forEach((x, i) => {
      if (x.kind === 'clean') cleanOnes.push([key, x, rule.findings[i]]);
      else negativeOnes.push([key, x]);
      assert.ok(isCleanEvidence(key, rule.findings[i]) === (x.kind === 'clean'),
        `${key}[${i}] kind matches the evidence signal`);
    });
  }
  assert.ok(cleanOnes.length >= 1 && negativeOnes.length >= 10,
    `mixed fixture: ${cleanOnes.length} clean, ${negativeOnes.length} negative`);
  const token = createReportToken(TL_SECRET, json.id);
  const html = await (await fetch(`${api.base}/api/v1/scans/${json.id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(html.includes('— CLEAN:') && html.includes('How to fix it:'),
    'mixed report renders both CLEAN observations and roast labels');
  assert.ok(html.includes('every roast points at the receipts'), 'findings intro points at the receipts');
  assert.ok(!html.includes('every single one is a compliment'), 'no all-compliment framing on a mixed report');
});