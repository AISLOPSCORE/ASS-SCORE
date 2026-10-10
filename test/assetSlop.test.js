import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { analyzeAssets, STOCK_IMAGE_HOSTS } from '../src/rules/assets.js';
import {
  computeSlopScore,
  RULE_WEIGHTS,
  FULL_RULE_WEIGHTS,
} from '../src/scorer.js';
import { ROAST_POOLS, ROAST_POOL_KEYS, CATEGORY_ORDER } from '../src/roast.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-assets-')), 'test.db');

/** Route-level SSRF guard (no DNS) so the fixture scan stays offline. */
const offlineValidateTarget = async (raw) => validateUrl(raw);

// ------------------------------------------------------------------ fixtures

/** One <img> helper: src + alt (+ optional extra attrs). */
const img = (src, opts = {}) =>
  `<img src="${src}"${opts.alt !== undefined ? ` alt="${opts.alt}"` : ''}${opts.srcset ? ` srcset="${opts.srcset}"` : ''}${opts.dataSrc ? ` data-src="${opts.dataSrc}"` : ''} />`;

const page = (imgs, body = '<p>The team page introduces the founders and describes our process in detail.</p>') =>
  `<!doctype html><html><head><title>Team</title></head><body>${imgs}${body}</body></html>`;

// A clean page: real alt texts, own-host images, descriptive filenames.
const CLEAN_IMG = img('https://cdn.ourbrand.com/images/team-photo-2026.jpg', { alt: 'our co-founders at the office' });
const CLEAN_PAGE = page(CLEAN_IMG + img('/images/product-shot.jpg', { alt: 'the product in use' }));

// ------------------------------------------------------------------ unit: rule

test('assets: clean page -> score 0 and zero findings', () => {
  const r = analyzeAssets(CLEAN_PAGE);
  assert.equal(r.score, 0);
  assert.ok(Array.isArray(r.findings));
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /0 of 2 images look generic or placeholder/);
});

test('assets: no <img> tags -> score 0, empty findings', () => {
  const r = analyzeAssets(page(''));
  assert.equal(r.score, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(analyzeAssets(''), { score: 0, findings: [] }, 'empty html defensive');
});

test('assets: PARTIAL hit (5 of 53 placeholder filenames, owner case) emits ONLY the non-zero aggregate + details — never zero-sibling lines', () => {
  // publishyoursaas.com repro (owner defect 2026-10-07): 53 images, 5 with
  // placeholder/generic filenames, 0 stock-CDN, 0 bad alt. Score stays
  // round(100 * 0.25 * 5/53) = 2 — the score is count-derived, independent of
  // which lines are emitted.
  const flagged = Array.from({ length: 5 }, (_, i) =>
    img(`/assets/image${i + 1}.jpg`, { alt: `the team member ${i + 1}` }));
  const clean = Array.from({ length: 48 }, (_, i) =>
    img(`/assets/team-${String(i + 1).padStart(4, '0')}.jpg`, { alt: `the product ${i + 1}` }));
  const r = analyzeAssets(page(flagged.join('') + clean.join('')));
  assert.equal(r.score, 2, 'round(100 * 0.25 * 5/53) = 2');
  assert.equal(r.findings.length, 1 + 5, '1 aggregate line + 5 detail lines');
  assert.match(r.findings[0], /^5 of 53 images with placeholder\/generic filenames$/);
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(r.findings.some((f) => f.includes(`generic filename "image${i}"`)), `detail for image${i}`);
  }
  // The contradiction source is gone: no "0 of 53 …" zero siblings at all.
  assert.equal(r.findings.filter((f) => /^0 of \d+ images /.test(f)).length, 0,
    `zero-sibling aggregates must not exist on a flagged page: ${r.findings.join(' | ')}`);
  assert.ok(!r.findings.some((f) => f.includes('come from stock photo sites')), 'no stock aggregate line emitted');
  assert.ok(!r.findings.some((f) => f.includes('missing or generic alt text')), 'no alt aggregate line emitted');
  // And the all-clean path is untouched: same page, no flagged filenames ->
  // the single combined "0 of N images look generic or placeholder" line.
  const allClean = analyzeAssets(page(clean.join('')));
  assert.equal(allClean.score, 0);
  assert.equal(allClean.findings.length, 1);
  assert.match(allClean.findings[0], /0 of 48 images look generic or placeholder/);
});

test('assets: every configured stock CDN origin is detected (config-driven, no code change)', () => {
  assert.ok(STOCK_IMAGE_HOSTS.length >= 10, `stock list has ${STOCK_IMAGE_HOSTS.length} origins`);
  for (const origin of STOCK_IMAGE_HOSTS) {
    // Test both the bare origin and a subdomain CDN form (images.<origin>).
    const bare = analyzeAssets(page(img(`https://${origin}/photo-2026.jpg`, { alt: 'a stock scene' })));
    assert.equal(bare.score, 50, `${origin}: bare origin should give stockRatio 1.0 -> 50`);
    assert.match(bare.findings[0], /^1 of 1 images come from stock photo sites/);

    const sub = analyzeAssets(page(img(`https://images.${origin}/photo-2026.jpg`, { alt: 'a stock scene' })));
    assert.equal(sub.score, 50, `${origin}: images.${origin} subdomain should also match`);
  }
});

test('assets: host matching is suffix-exact — no false positives on lookalike domains or relative paths', () => {
  const tricky = page(
    img('https://images.unsplash.com.evil.test/photo.jpg', { alt: 'real alt' }) +
      img('/images/pexels.com-local-copy.jpg', { alt: 'real alt' }) +
      img('https://cdn.ourbrand.com/team.jpg', { alt: 'real alt' }),
  );
  const r = analyzeAssets(tricky);
  assert.equal(r.score, 0, 'lookalike domain + relative path + own CDN are not stock');
});

test('assets: srcset and data-src are honored (lazy-load / responsive images)', () => {
  const viaSrcset = analyzeAssets(page(img('', { alt: 'hero', srcset: 'https://images.unsplash.com/photo-1.jpg 1200w, https://images.unsplash.com/photo-1-small.jpg 400w' })));
  assert.equal(viaSrcset.score, 50, 'first srcset candidate host detected');
  const viaDataSrc = analyzeAssets(page(img('', { alt: 'hero', dataSrc: 'https://img.freepik.com/free-photo/x.jpg' })));
  assert.equal(viaDataSrc.score, 50, 'data-src host detected');
});

test('assets: placeholder/generic filenames are flagged (filename stem, any src form)', () => {
  const html = page([
    'image1.jpg',         // ^image\d+
    'photo2.png',         // ^photo\d+
    'placeholder-300.webp', // ^placeholder
    'dummy-width.png',    // ^dummy
    'logo.png',           // bare "logo"
    'spacer.gif',         // spacer
    '1x1.gif',            // ^1x1
    'blank.png',          // blank
  ].map((f) => img(`https://cdn.ourbrand.com/${f}`, { alt: 'real alt' })).join(''));
  const r = analyzeAssets(html);
  assert.equal(r.score, 25, 'all 8/8 filenames flagged -> 0.25 * 100');
  // Emission rule (report-contradiction fix 2026-10-07): the ONLY emitted
  // aggregate is the non-zero filename line — no zero-sibling "0 of 8 …" stock
  // or alt lines (so a report can never compliment a dimension it flags).
  assert.equal(r.findings.length, 1 + 8, '1 aggregate line + 8 detail lines');
  assert.match(r.findings[0], /^8 of 8 images with placeholder\/generic filenames/);
  assert.ok(!r.findings.some((f) => /^0 of \d+ images come from stock photo sites$/.test(f)),
    'no zero-sibling stock aggregate on a filename-flagged page');
  assert.ok(!r.findings.some((f) => /^0 of \d+ images with missing or generic alt text$/.test(f)),
    'no zero-sibling alt aggregate on a filename-flagged page');
  for (const f of ['image1', 'photo2', 'placeholder', 'dummy', 'logo', 'spacer', '1x1', 'blank']) {
    assert.ok(r.findings.some((x) => x.includes(`"${f}`)), `finding names ${f}: ${r.findings.join(' | ')}`);
  }
});

test('assets: missing / empty / generic alt text is flagged (decorative logic deliberately not applied)', () => {
  const html = page(
    img('https://cdn.ourbrand.com/a.jpg') +  // missing alt
      img('https://cdn.ourbrand.com/b.jpg', { alt: '' }) + // empty alt
      img('https://cdn.ourbrand.com/c.jpg', { alt: '   ' }) + // whitespace alt counts as empty
      img('https://cdn.ourbrand.com/d.jpg', { alt: 'image' }) + // generic (lowercase)
      img('https://cdn.ourbrand.com/e.jpg', { alt: 'Photo' }) + // generic (case-insensitive)
      img('https://cdn.ourbrand.com/f.jpg', { alt: 'real descriptive alt' }),
  );
  const r = analyzeAssets(html);
  // Emission rule (2026-10-07): the ONLY aggregate is the non-zero alt line —
  // no zero-sibling "0 of 6 …" stock/filename lines on an alt-flagged page.
  assert.match(r.findings[0], /^5 of 6 images with missing or generic alt text/);
  assert.ok(!r.findings.some((f) => /^0 of \d+ images come from stock photo sites$/.test(f)),
    'no zero-sibling stock aggregate on an alt-flagged page');
  assert.ok(!r.findings.some((f) => /^0 of \d+ images with placeholder\/generic filenames$/.test(f)),
    'no zero-sibling filename aggregate on an alt-flagged page');
  // score = round(100 * 0.25 * (5/6)) = round(20.83) = 21
  assert.equal(r.score, 21, 'round(100 * 0.25 * 5/6) = 21');
  for (const f of ['missing alt text', 'empty alt text', 'generic alt "image"', 'generic alt "photo"']) {
    assert.ok(r.findings.some((x) => x.includes(f)), `finding: ${f}`);
  }
});

test('assets: mixed signals compound deterministically — stock + bad alts -> 75', () => {
  const html = page(
    img('https://images.unsplash.com/photo-1556742049-0cfed4f6a45d', { alt: 'image' }) + // stock + generic alt
      img('https://img.freepik.com/free-photo/x.jpg'), // stock + missing alt
  );
  const r = analyzeAssets(html);
  // stock 2/2 = 1.0 (weight 0.5), alt 2/2 = 1.0 (weight 0.25), filename 0
  // -> 100 * (0.5 + 0.25) = 75
  assert.equal(r.score, 75, `composite stock+alt score: ${r.score}`);
});

test('assets: findings detail cap keeps the report bounded', () => {
  const many = Array.from({ length: 40 }, (_, i) => img(`https://images.unsplash.com/photo-${i}.jpg`, { alt: 'image' })).join('');
  const r = analyzeAssets(page(many));
  // stock 40/40 (0.5) + alt 40/40 (0.25) = 0.75; filenames 'photo-N' do NOT
  // match ^photo\d+ (hyphen) so the filename ratio stays 0 -> score 75.
  assert.equal(r.score, 75);
  assert.ok(r.findings.length <= 3 + 8 * 3, `bounded findings (${r.findings.length})`);
  // Emission rule (2026-10-07): only the two non-zero aggregates (stock + alt)
  // emit — the zero filename aggregate is gone, so 2 + capped 8+8 details.
  assert.equal(r.findings.length, 2 + 8 + 8, '2 non-zero summary lines + capped 8+8 details');
  assert.ok(!r.findings.some((f) => /^0 of \d+ images with placeholder\/generic filenames$/.test(f)),
    'no zero-sibling filename aggregate when only stock+alt flag');
  assert.match(r.findings[0], /^40 of 40 images come from stock photo sites/);
});

// ------------------------------------------------------------------ unit: scoring

test('scoring: assets is a full-table category with weight 0.10, comparable to fingerprints', () => {
  const total = Object.values(FULL_RULE_WEIGHTS).reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(total - 1.0) < 1e-9, `full weights sum ${total}`);
  assert.equal(FULL_RULE_WEIGHTS.assets, 0.10);
  assert.equal(FULL_RULE_WEIGHTS.crossPage, 0.30, 'crossPage stays the largest');
  for (const [k, w] of Object.entries(FULL_RULE_WEIGHTS)) {
    assert.ok(w <= FULL_RULE_WEIGHTS.crossPage, `${k}: ${w} <= crossPage`);
  }
  // v1 categories keep their exact relative ratios (5:4:6:5) in the full table.
  const v1Ratio = Object.keys(RULE_WEIGHTS).map((k) => FULL_RULE_WEIGHTS[k] / RULE_WEIGHTS[k]);
  assert.ok(v1Ratio.every((r) => Math.abs(r - v1Ratio[0]) < 1e-9), 'v1 relative weights preserved');
});

test('scoring: assets contributes to the composite when crossPage runs, never outside 0–100', () => {
  // Full table: assets 100 * 0.10 = 10 points.
  const withCross = computeSlopScore({
    filler: { score: 0 }, boilerplate: { score: 0 }, infoDensity: { score: 0 },
    repetitive: { score: 0 }, crossPage: { score: 0 }, fingerprints: { score: 0 }, assets: { score: 100 },
  });
  assert.equal(withCross.slopScore, 10, 'assets-only contributes its 0.10 weight');
  assert.equal(withCross.components.assets.weight, 0.10);

  const allSlop = computeSlopScore({
    filler: { score: 100 }, boilerplate: { score: 100 }, infoDensity: { score: 100 },
    repetitive: { score: 100 }, crossPage: { score: 100 }, fingerprints: { score: 100 }, assets: { score: 100 },
  });
  assert.equal(allSlop.slopScore, 100);
  assert.ok(Number.isInteger(allSlop.slopScore) && allSlop.slopScore >= 0 && allSlop.slopScore <= 100);
});

test('scoring: single-page scan (crossPage null) excludes assets like fingerprints — v1 reproduced, minus the approved C1 credit', () => {
  const single = computeSlopScore({
    filler: { score: 50 }, boilerplate: { score: 50 }, infoDensity: { score: 50 },
    repetitive: { score: 50 }, crossPage: { score: null, findings: [], note: 'insufficient pages' },
    fingerprints: { score: 100 }, assets: { score: 100 },
  });
  assert.equal(single.components.assets.weight, 0, 'assets excluded from the single-page composite');
  // Phase-2 C1 (owner 2026-10-05): on this branch infoDensity AND fingerprints
  // SCORES still exist (only fingerprints' WEIGHT is 0), so i 50 /\ fp 100
  // fires the +4 template-stack corroboration credit — the single-page score
  // is now v1 + 4 exactly, and drops back to v1 the moment either bar falls.
  const v1Only = computeSlopScore({
    filler: { score: 50 }, boilerplate: { score: 50 }, infoDensity: { score: 50 }, repetitive: { score: 50 },
  });
  assert.equal(single.slopScore, v1Only.slopScore + 4, 'single-page score == v1 score + 4 (C1 fires on i>=45 /\ fp>=15 in the fallback branch)');
  const subBar = computeSlopScore({
    filler: { score: 50 }, boilerplate: { score: 50 }, infoDensity: { score: 50 },
    repetitive: { score: 50 }, crossPage: { score: null, findings: [], note: 'insufficient pages' },
    fingerprints: { score: 14 }, assets: { score: 100 },
  });
  assert.equal(subBar.slopScore, v1Only.slopScore, 'fingerprints 14 -> C1 does not fire -> exact v1 parity');
});

// ------------------------------------------------------------------ roast pools

test('roast: assets pool exists with 15–20 pattern-based lines, enumerated in CATEGORY_ORDER', () => {
  const pool = ROAST_POOLS.assets;
  assert.ok(pool, 'assets pool present');
  assert.ok(pool.emoji && typeof pool.emoji === 'string');
  assert.ok(pool.lines.length >= 15 && pool.lines.length <= 20, `assets lines: ${pool.lines.length}`);
  assert.ok(ROAST_POOL_KEYS.includes('assets'));
  assert.ok(CATEGORY_ORDER.includes('assets'));
  for (const line of pool.lines) {
    assert.ok(typeof line === 'string' && line.trim().length > 0);
    assert.ok(line.length <= 180);
    assert.ok(!/\b(?:written|made|created|generated|produced|built) by (?:an? )?AI\b/i.test(line), 'no AI-authorship claim');
  }
});

// ------------------------------------------------------------ integration (API)

const STOCK_PAGE = page(
  img('https://images.unsplash.com/photo-1556742049-0cfed4f6a45d', { alt: 'co-working space' }) +
    img('https://images.pexels.com/photos/3183150/pexels-photo-3183150.jpeg') +
    img('/images/logo.png', { alt: 'brand logo' }) +
    img('https://cdn.ourbrand.com/image1.jpg', { alt: 'image' }),
);

const fakeFetcher = () => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: STOCK_PAGE }),
});

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, reportTokenSecret: 'asset-test-secret' });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Fetch the token'd full report HTML for a scan id. */
const paidHtml = (base, id) =>
  fetch(`${base}/api/v1/scans/${id}?token=${createReportToken('asset-test-secret', id)}`, { headers: { accept: 'text/html' } }).then((r) => r.text());

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath);
});

after(() => {
  api.server.close();
});

test('POST scan: breakdown has the assets key with a numeric score; findings persist in DB + paid report, GET matches', async () => {
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();

  // assets breakdown key present and well-formed (FREE contract: number only).
  assert.ok(json.breakdown.assets, 'breakdown.assets key present in POST response');
  assert.ok(Number.isInteger(json.breakdown.assets.score) && json.breakdown.assets.score >= 0 && json.breakdown.assets.score <= 100);
  // This fixture: 2/4 stock CDN (0.5*0.5=0.25), 2/4 bad alts (0.25*0.5=0.125),
  // 2/4 placeholder filenames (0.25*0.5=0.125) -> 0.50 total -> score 50.
  assert.equal(json.breakdown.assets.score, 50, JSON.stringify(json.breakdown.assets));
  assert.ok(!('findings' in json.breakdown.assets), 'assets findings are PAID content — not on the free payload');
  assert.ok(!('insights' in json.breakdown.assets), 'assets insights are PAID content — not on the free payload');

  assert.ok(Number.isInteger(json.score) && json.score >= 0 && json.score <= 100, 'overall public score in 0-100');
  assert.equal(typeof json.verdict, 'string', 'verdict grade label present');

  // persisted identically (slop direction at rest == public direction) — the
  // findings LIVE in the DB row (paid content), untouched by the gate.
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  assert.equal(stored.assets.score, json.breakdown.assets.score, 'assets score equal at rest (no inversion)');
  assert.ok(Array.isArray(stored.assets.findings) && stored.assets.findings.length > 0, 'assets findings stored in the DB');
  assert.match(stored.assets.findings[0], /^2 of 4 images come from stock photo sites/);
  assert.ok(stored.assets.findings.some((f) => f.includes('generic alt "image"')));
  assert.ok(stored.assets.findings.some((f) => f.includes('generic filename "logo"')));

  // GET JSON returns the same FREE breakdown (numeric, gated identically).
  const get1 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  assert.deepEqual(get1.breakdown, json.breakdown);

  // The actual asset findings surface ONLY inside the token'd paid report.
  const paid = await paidHtml(api.base, json.id);
  assert.ok(paid.includes('2 of 4 images come from stock photo sites'), 'stock finding rendered in the paid report');
  assert.ok(paid.includes('generic alt'), 'alt finding rendered in the paid report');
});

test('GET HTML: free page shows the IMAGERY number; paid report renders findings + classification (no layout breakage)', async () => {
  const created = await (await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  })).json();
  // Free teaser page: the IMAGERY category renders as its NUMBER (50/100).
  const freeHtml = await (await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(freeHtml.includes('IMAGERY'), 'assets row renders under its customer name IMAGERY on the free page');
  assert.match(freeHtml, /<strong>IMAGERY<\/strong> — 50\/100/, 'free page shows the IMAGERY number');
  assert.ok(!freeHtml.includes('NEEDS ATTENTION'), 'classification is paid-report content, not on the free page');

  // Paid report: sub-score + NEEDS ATTENTION classification (score 50) +
  // verbatim receipts.
  const html = await paidHtml(api.base, created.id);
  assert.ok(html.includes('IMAGERY'), 'assets row renders under its customer name IMAGERY');
  // Phase 2A dashboard shell: the same sub-score + classification now render
  // on the IMAGERY category CARD (score number + state pill) — existing
  // classification, values unchanged (50/100 NEEDS ATTENTION).
  assert.ok(html.includes('<span class="cat-score">50<span class="cat-den">/100</span></span>'), 'IMAGERY card shows the existing 50/100');
  assert.ok(html.includes('<span class="cat-state">NEEDS ATTENTION</span>'), 'IMAGERY card shows the existing NEEDS ATTENTION classification');
  assert.ok(html.includes('2 of 4 images come from stock photo sites'), 'stock finding rendered as a receipt');
  assert.ok(html.includes('generic alt'), 'alt finding rendered as a receipt');
  assert.ok(html.includes('Nothing meaningful to roast here.'), 'clean category line rendered (single-page scan leaves REPETITION skipped)');
  assert.ok(!html.includes('this is the only page scanned.'), 'no single-page worst-page line (panel removed — the page line is multi-page-only)');
  // The mandated disclaimer and score line still present (report intact).
  assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'));
  assert.match(html, /A\.S\.S\. Score: \d+ \/ 100/);
  // New narrative structure: no legacy evidence table.
  assert.equal((html.match(/<tr>/g) ?? []).length, 0, 'legacy evidence table gone');
});