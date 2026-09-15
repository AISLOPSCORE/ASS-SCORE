import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
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
  assert.match(r.findings[0], /0 of 2 images flagged/);
});

test('assets: no <img> tags -> score 0, empty findings', () => {
  const r = analyzeAssets(page(''));
  assert.equal(r.score, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(analyzeAssets(''), { score: 0, findings: [] }, 'empty html defensive');
});

test('assets: every configured stock CDN origin is detected (config-driven, no code change)', () => {
  assert.ok(STOCK_IMAGE_HOSTS.length >= 10, `stock list has ${STOCK_IMAGE_HOSTS.length} origins`);
  for (const origin of STOCK_IMAGE_HOSTS) {
    // Test both the bare origin and a subdomain CDN form (images.<origin>).
    const bare = analyzeAssets(page(img(`https://${origin}/photo-2026.jpg`, { alt: 'a stock scene' })));
    assert.equal(bare.score, 50, `${origin}: bare origin should give stockRatio 1.0 -> 50`);
    assert.match(bare.findings[0], /^1 of 1 images from stock\/placeholder CDNs/);

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
  assert.match(r.findings[1], /^8 of 8 images with placeholder\/generic filenames/);
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
  assert.match(r.findings[2], /^5 of 6 images with missing or generic alt text/);
  // score = round(100 * 0.25 * (5/6)) = round(20.83) = 21
  assert.equal(r.score, 21, 'round(100 * 0.25 * 5/6) = 21');
  for (const f of ['missing alt attribute', 'empty alt attribute', 'generic alt "image"', 'generic alt "photo"']) {
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
  assert.equal(r.findings.length, 3 + 8 + 8, '3 summary lines + capped 8+8 details');
  assert.match(r.findings[0], /^40 of 40 images from stock\/placeholder CDNs/);
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

test('scoring: single-page scan (crossPage null) excludes assets like fingerprints — v1 reproduced', () => {
  const single = computeSlopScore({
    filler: { score: 50 }, boilerplate: { score: 50 }, infoDensity: { score: 50 },
    repetitive: { score: 50 }, crossPage: { score: null, findings: [], note: 'insufficient pages' },
    fingerprints: { score: 100 }, assets: { score: 100 },
  });
  assert.equal(single.components.assets.weight, 0, 'assets excluded from the single-page composite');
  assert.equal(single.slopScore, computeSlopScore({
    filler: { score: 50 }, boilerplate: { score: 50 }, infoDensity: { score: 50 }, repetitive: { score: 50 },
  }).slopScore, 'single-page score == pure v1 score');
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
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget });
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

test('POST scan: breakdown has the assets key with score+findings; persisted bytes-exact; GET matches', async () => {
  const res = await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();

  // assets breakdown key present and well-formed
  assert.ok(json.breakdown.assets, 'breakdown.assets key present in POST response');
  assert.ok(Number.isInteger(json.breakdown.assets.score) && json.breakdown.assets.score >= 0 && json.breakdown.assets.score <= 100);
  assert.ok(Array.isArray(json.breakdown.assets.findings));
  // This fixture: 2/4 stock CDN (0.5*0.5=0.25), 2/4 bad alts (0.25*0.5=0.125),
  // 2/4 placeholder filenames (0.25*0.5=0.125) -> 0.50 total -> score 50.
  assert.equal(json.breakdown.assets.score, 50, JSON.stringify(json.breakdown.assets));
  assert.match(json.breakdown.assets.findings[0], /^2 of 4 images from stock\/placeholder CDNs/);
  assert.ok(json.breakdown.assets.findings.some((f) => f.includes('generic alt "image"')));
  assert.ok(json.breakdown.assets.findings.some((f) => f.includes('generic filename "logo"')));

  assert.ok(Number.isInteger(json.score) && json.score >= 0 && json.score <= 100, 'overall public score in 0-100');
  assert.equal(typeof json.verdict, 'string', 'verdict grade label present');

  // persisted identically (slop direction at rest == public direction)
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  assert.equal(stored.assets.score, json.breakdown.assets.score, 'assets score equal at rest (no inversion)');
  assert.deepEqual(stored.assets.findings, json.breakdown.assets.findings, 'assets findings stored bytes-exact');

  // GET JSON returns the same assets breakdown
  const get1 = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  assert.deepEqual(get1.breakdown, json.breakdown);
});

test('GET HTML report: renders the IMAGERY category with its findings (no layout breakage)', async () => {
  const created = await (await fetch(`${api.base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  })).json();
  const html = await (await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } })).text();
  // The assets category renders under its customer-facing name IMAGERY,
  // with its sub-score and the NEEDS ATTENTION classification (score 50).
  assert.ok(html.includes('IMAGERY'), 'assets row renders under its customer name IMAGERY');
  assert.match(html, /<strong>IMAGERY<\/strong> — 50\/100 <em>\(NEEDS ATTENTION\)<\/em>/, 'IMAGERY row shows score + classification');
  assert.ok(html.includes('2 of 4 images from stock/placeholder CDNs'), 'stock finding rendered as a receipt');
  assert.ok(html.includes('generic alt'), 'alt finding rendered as a receipt');
  assert.ok(html.includes('Nothing meaningful to roast here.'), 'clean category line rendered (single-page scan leaves REPETITION skipped)');
  assert.ok(html.includes('Single page scanned — this page IS the site.'), 'single-page worst-page line rendered');
  // The mandated disclaimer and score line still present (report intact).
  assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'));
  assert.match(html, /A\.S\.S\. Score: \d+ \/ 100/);
  // New narrative structure: no legacy evidence table.
  assert.equal((html.match(/<tr>/g) ?? []).length, 0, 'legacy evidence table gone');
});