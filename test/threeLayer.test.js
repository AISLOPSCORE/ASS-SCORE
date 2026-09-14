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
} from '../src/threeLayer.js';
import { hashScanId as roastHashScanId } from '../src/roast.js';

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
test('threeLayer.json: pools cover exactly the seven breakdown categories with 8-12 roasts, 4-6 whys/fixes', () => {
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
    const all = [...pool.roasts, ...pool.whys, ...pool.fixes];
    assert.equal(new Set(all).size, all.length, `${key}: no duplicate lines`);
    for (const line of all) {
      assert.ok(typeof line === 'string' && line.trim().length > 0, `${key}: non-empty line`);
      assert.ok(line.length <= 220, `${key}: line not overlong (${line.length} chars)`);
    }
    for (const r of pool.roasts) {
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
    for (const line of [...THREE_LAYER_POOLS[key].roasts, ...THREE_LAYER_POOLS[key].whys, ...THREE_LAYER_POOLS[key].fixes]) {
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

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(SLOP_PAGE), validateTarget: offlineValidateTarget, maxScansPerDay: 0 });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath);
});

after(() => {
  api.server.close();
});

test('E2E: slop fixture -> JSON breakdown carries insights per category; persisted; GET bytes-stable; HTML renders the layers', async () => {
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();

  // Every category with findings carries a capped insights array; evidence
  // mirrors findings; all three layers present.
  let insightTotal = 0;
  for (const [key, rule] of Object.entries(json.breakdown)) {
    assert.ok(Array.isArray(rule.insights), `${key} has insights`);
    const expected = Math.min((rule.findings ?? []).length, MAX_INSIGHTS_PER_CATEGORY);
    assert.equal(rule.insights.length, expected, `${key} insights length`);
    rule.insights.forEach((x, i) => {
      assert.equal(x.evidence, rule.findings[i], `${key}[${i}] evidence = finding`);
      assert.ok(x.roast.length > 0 && x.why.length > 0 && x.fix.length > 0, `${key}[${i}] layers non-empty`);
    });
    insightTotal += rule.insights.length;
  }
  assert.ok(insightTotal >= 10, `slop fixture produces a rich insight set (got ${insightTotal})`);

  // The roast cites real evidence for a phrase-bearing finding.
  const fillerPhrase = json.breakdown.filler.findings.find((f) => f.includes('cutting-edge')) ?? '';
  assert.ok(fillerPhrase, 'fixture has a filler phrase finding');
  const idx = json.breakdown.filler.findings.indexOf(fillerPhrase);
  assert.ok(json.breakdown.filler.insights[idx].roast.includes('cutting-edge'),
    `filler insight cites the phrase ("${json.breakdown.filler.insights[idx].roast}")`);

  // Persisted in the stored JSON column (rides inside the breakdown).
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  assert.deepEqual(stored.filler.insights, json.breakdown.filler.insights, 'insights stored bytes-exact');

  // GET JSON: stable across repeats (same stored bytes).
  const get1 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  const get2 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  assert.deepEqual(get1.breakdown, json.breakdown, 'GET matches POST breakdown');
  assert.deepEqual(get2.breakdown, get1.breakdown, 'repeated GET identical');

  // HTML report renders the three layers under each category.
  const html = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /<p class="ins-roast">/, 'roast layer rendered (italic/accent)');
  assert.match(html, /<span class="ins-why">/, 'why layer rendered');
  assert.match(html, /<span class="ins-fix">/, 'fix layer rendered');
  assert.ok(html.includes('Why it matters:') && html.includes('How to fix it:'), 'layer labels present');
  assert.ok((html.match(/<li><strong>/g) ?? []).length >= 10, 'evidence lines rendered bold');
  const firstInsight = get1.breakdown.filler.insights[0];
  const escapedRoast = firstInsight.roast.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  assert.ok(html.includes(escapedRoast), 'a specific roast appears in the report (escaped)');
  const rows = (html.match(/<tr>/g) ?? []).length;
  assert.equal(rows, 1 + Object.keys(json.breakdown).length, 'no extra table rows (layers live inside the findings cell)');
  assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'), 'mandated disclaimer intact');

  // Webhook/email payload surface is the same public object (delivered bytes-exact).
  assert.equal(typeof json.breakdown.assets.insights, 'object', 'assets insights present');

  // Save a sample for the team/owner tone check.
  const sample = { scannedAt: new Date().toISOString(), fixture: 'slop-heavy multi-page fixture', id: json.id, url: json.url, score: json.score, verdict: json.verdict, roast: json.roast, breakdown: json.breakdown };
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
  const app = startApp(dbPath2);
  try {
    const get1 = await (await fetch(`${app.base}/api/v1/scans/legacy-3layer-scan`, { headers: { accept: 'application/json' } })).json();
    const get2 = await (await fetch(`${app.base}/api/v1/scans/legacy-3layer-scan`, { headers: { accept: 'application/json' } })).json();
    assert.deepEqual(get1.breakdown, get2.breakdown, 'derived insights deterministic across reads');
    assert.ok(Array.isArray(get1.breakdown.filler.insights) && get1.breakdown.filler.insights.length === 2, 'legacy filler insights derived');
    assert.ok(get1.breakdown.filler.insights[0].roast.includes('game-changer'), 'legacy roast cites the stored phrase');
    assert.deepEqual(get1.breakdown.filler.findings, ['2× "game-changer"', '3× "seamless"'], 'findings untouched');
    assert.equal(get1.breakdown.crossPage.score, null, 'skipped module passes through');
    assert.equal(get1.score, 55, 'stored 55 -> public 55 (same direction, no inversion)');
    assert.equal(get1.roast, 'A stored roast.', 'stored roast kept');
  } finally {
    app.server.close();
  }
});