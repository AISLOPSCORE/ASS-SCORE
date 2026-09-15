import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import {
  ROAST_POOLS,
  ROAST_POOL_KEYS,
  hashScanId,
  pickSlopPool,
  selectRoast,
  selectRoastInfo,
  CATEGORY_ORDER,
  CLEAN_SCORE_THRESHOLD,
} from '../src/roast.js';
import { buildCardSvg, renderCardPng, escapeXml, CARD_WIDTH, CARD_HEIGHT } from '../src/card.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-roast-')), 'test.db');

// A sloppy page (filler-heavy, low information density) for integration tests.
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

// Route-level SSRF guard, DNS-skipping variant (see webhookFulfillment.test.js).
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath, options = {}) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(SLOP_HTML), validateTarget: offlineValidateTarget, ...options });
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, body) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Build a breakdown dict mirroring the rule-result shape. */
const breakdown = (scores, { crossPage = null } = {}) => {
  const b = {};
  for (const key of CATEGORY_ORDER) {
    if (key === 'crossPage') {
      b.crossPage = crossPage === null
        ? { score: null, findings: [], note: 'insufficient pages for cross-page analysis' }
        : { score: crossPage, findings: [], pairs: [], pages: [] };
    } else {
      b[key] = { score: scores[key] ?? 0, findings: [] };
    }
  }
  return b;
};

// ---------------------------------------------------------------- data checks

test('roasts.json: exactly the seven breakdown pools + clean, 15–20 lines each', () => {
  assert.deepEqual([...ROAST_POOL_KEYS].sort(),
    [...CATEGORY_ORDER, 'clean'].sort(), 'pool keys = seven breakdown keys + clean');
  for (const key of ROAST_POOL_KEYS) {
    const pool = ROAST_POOLS[key];
    assert.ok(pool, `pool ${key}`);
    assert.ok(pool.emoji && typeof pool.emoji === 'string', `${key} has emoji`);
    assert.ok(pool.label && typeof pool.label === 'string', `${key} has label`);
    assert.ok(Array.isArray(pool.lines), `${key} lines is an array`);
    assert.ok(pool.lines.length >= 15 && pool.lines.length <= 20,
      `${key} has ${pool.lines.length} lines (need 15–20)`);
    for (const line of pool.lines) {
      assert.ok(typeof line === 'string' && line.trim().length > 0, `${key}: non-empty line`);
      assert.ok(line.length <= 180, `${key}: line not overlong (${line.length} chars)`);
      // 1–2 sentences: 1–3 sentence terminators (ellipses/rhetoric allowed).
      const terminators = (line.match(/[.!?]+(?:["'’”]|$)/g) ?? []).length;
      assert.ok(terminators >= 1 && terminators <= 3,
        `${key}: "${line}" has ${terminators} sentence endings (want 1–2 sentences)`);
    }
  }
});

test('roasts.json: copy is pattern-based — no factual AI-authorship claims', () => {
  const forbidden = [
    /\b(?:written|made|created|authored|generated|produced|built) (?:by|with) (?:an? )?AI\b/i,
    /\bAI (?:wrote|made|created|generated|authored|produced|built)\b/i,
    /\b(?:ChatGPT|GPT-?[0-9]|Claude|Gemini) (?:wrote|made|generated)\b/i,
  ];
  for (const key of ROAST_POOL_KEYS) {
    for (const line of ROAST_POOLS[key].lines) {
      for (const re of forbidden) {
        assert.ok(!re.test(line), `${key}: "${line}" must not assert AI authorship`);
      }
    }
  }
});

// --------------------------------------------------------------- roast module

test('hashScanId: deterministic, uint32, distinct ids differ', () => {
  const id = '7d5f2b1a-1111-4222-8333-444444444444';
  assert.equal(hashScanId(id), hashScanId(id), 'same id -> same hash');
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) seen.add(hashScanId(`scan-${i}`));
  assert.ok(seen.size > 60, 'hash spreads across ids');
  for (const h of seen) assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
});

test('pickSlopPool: score below threshold -> clean pool, whatever the breakdown', () => {
  const severe = breakdown({ filler: 100, boilerplate: 100, infoDensity: 100, repetitive: 100, fingerprints: 100 });
  assert.equal(pickSlopPool({ slopScore: CLEAN_SCORE_THRESHOLD - 1, breakdown: severe }), 'clean');
  assert.equal(pickSlopPool({ slopScore: 0, breakdown: breakdown({}) }), 'clean');
});

test('pickSlopPool: the highest weighted contributor wins', () => {
  const fillerWins = breakdown({ filler: 100, boilerplate: 20, infoDensity: 20, repetitive: 20, fingerprints: 0 }, { crossPage: 20 });
  // full-table weights: filler 0.15*100=15 wins vs crossPage 0.30*20=6.
  assert.equal(pickSlopPool({ slopScore: 29, breakdown: fillerWins }), 'filler');

  const crossWins = breakdown({ filler: 0, boilerplate: 0, infoDensity: 0, repetitive: 0, fingerprints: 0 }, { crossPage: 100 });
  assert.equal(pickSlopPool({ slopScore: 30, breakdown: crossWins }), 'crossPage');
});

test('pickSlopPool: infoDensity high = thin content = a real slop category', () => {
  // In this rule set a HIGH infoDensity score means MORE slop (low information
  // density: "higher score = more slop" per src/rules/infoDensity.js). When
  // thin content genuinely dominates, the site gets the infoDensity roast.
  const thin = breakdown({ filler: 0, boilerplate: 0, infoDensity: 100, repetitive: 0, fingerprints: 0 }, { crossPage: 0 });
  assert.equal(pickSlopPool({ slopScore: 20, breakdown: thin }), 'infoDensity');
});

test('pickSlopPool: diffuse slop (no category above the dominance floor) -> clean', () => {
  // Full-table (crossPage present). Every category lands <= 4 weighted points
  // (nothing dominates) and the total is a mid score -> "clean" pool.
  const diffuse = breakdown({ filler: 26, boilerplate: 33, infoDensity: 22, repetitive: 26 }, { crossPage: 13 });
  // filler 3.25, boilerplate 3.30, infoDensity 3.30, repetitive 3.25,
  // crossPage 3.90 -> winner (crossPage) 3.90 <= DOMINANCE_MIN_WEIGHTED.
  assert.equal(pickSlopPool({ slopScore: 20, breakdown: diffuse }), 'clean');

  // Near-tie where the winner does clear the floor -> deterministic winner.
  const nearTie = breakdown({ filler: 27, boilerplate: 34, infoDensity: 22, repetitive: 27 }, { crossPage: 14 });
  // filler 3.375, boilerplate 3.40, infoDensity 3.30, repetitive 3.375,
  // crossPage 4.20 -> crossPage wins (4.2 > 4).
  assert.equal(pickSlopPool({ slopScore: 20, breakdown: nearTie }), 'crossPage');

  // v1 (crossPage skipped): winner clears the floor and picks the leading v1
  // category (phase-2 preserved v1 weighting for single-page scans).
  const uniform = breakdown({ filler: 30, boilerplate: 35, infoDensity: 25, repetitive: 30 }, { crossPage: null });
  // v1 table: filler 7.5, boilerplate 7.0, infoDensity 7.5, repetitive 7.5 ->
  // winner (filler, tie-break) 7.5 > 4.
  assert.equal(pickSlopPool({ slopScore: 20, breakdown: uniform }), 'filler');
});

test('pickSlopPool: fingerprints can only win when crossPage participates', () => {
  // Full table: fingerprints 0.10 weight can dominate when other categories
  // stay under it and the total clears the score threshold.
  const fpOnly = breakdown({ filler: 34, boilerplate: 0, infoDensity: 0, repetitive: 0, fingerprints: 100 }, { crossPage: 30 });
  // fingerprints 10.0 > crossPage 9.0 (0.30*30), filler 5.1 -> fingerprints.
  assert.equal(pickSlopPool({ slopScore: 24, breakdown: fpOnly }), 'fingerprints');
  // Single-page scan (crossPage null -> v1 table; fingerprints weight 0).
  const fpSingle = breakdown({ filler: 0, boilerplate: 100, infoDensity: 0, repetitive: 0, fingerprints: 100 });
  assert.equal(pickSlopPool({ slopScore: 20, breakdown: fpSingle }), 'boilerplate');
});

test('selectRoast: seeded by scan id — same id same line, different ids can differ', () => {
  const b = breakdown({ filler: 100, boilerplate: 0, infoDensity: 0, repetitive: 0 }, { crossPage: 0 });
  const idA = '00000000-0000-4000-8000-000000000001';
  const infoA1 = selectRoastInfo({ id: idA, slopScore: 40, breakdown: b });
  const infoA2 = selectRoastInfo({ id: idA, slopScore: 40, breakdown: b });
  assert.equal(infoA1.pool, 'filler');
  assert.equal(infoA1.line, infoA2.line, 'same id -> identical line');
  assert.equal(selectRoast({ id: idA, slopScore: 40, breakdown: b }), infoA1.line);
  assert.ok(ROAST_POOLS.filler.lines.includes(infoA1.line), 'line drawn from the winner pool');

  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    lines.push(selectRoast({ id: `id-${i}`, slopScore: 60, breakdown: b }));
  }
  assert.ok(new Set(lines).size > 5, 'different scan ids pick varied lines from the pool');
  assert.equal(selectRoast({ id: 'x', slopScore: 5, breakdown: b }),
    selectRoast({ id: 'x', slopScore: 5, breakdown: b }), 'deterministic again');
});

test('selectRoast: low score -> clean pool always', () => {
  const b = breakdown({ filler: 100 }, { crossPage: 100 });
  const info = selectRoastInfo({ id: 'clean-id-1', slopScore: 12, breakdown: b });
  assert.equal(info.pool, 'clean');
  assert.equal(info.emoji, '✨');
  assert.ok(ROAST_POOLS.clean.lines.includes(info.line));
});

// ------------------------------------------------------------- integration

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath);
});

after(() => {
  api.server.close();
});

test('POST scan -> roast in JSON, stored in SQLite, identical across repeated GETs', async () => {
  const res = await post(api.base, { url: 'https://example.com/' });
  assert.equal(res.status, 200);
  const created = await res.json();
  assert.ok(typeof created.roast === 'string' && created.roast.trim().length > 0,
    'POST response carries a roast line');
  assert.ok(created.roast.length <= 180, 'roast is 1–2 sentences worth of text');

  // Stored in the scan record (the `roast` column), not just returned.
  const row = new (await import('better-sqlite3')).default(dbPath)
    .prepare('SELECT roast FROM scans WHERE id = ?').get(created.id);
  assert.equal(row.roast, created.roast, 'roast persisted in sqlite');

  // GET JSON: same roast, twice (deterministic surface).
  const get1 = await (await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'application/json' } })).json();
  const get2 = await (await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'application/json' } })).json();
  assert.equal(get1.roast, created.roast, 'GET JSON roast matches POST');
  assert.equal(get2.roast, get1.roast, 'repeated GETs -> identical roast string');
  assert.equal(get1.slopScore, created.slopScore); // existing fields untouched
});

test('GET HTML report: roast lives in The Verdict, emoji-tagged, escape-safe when stored value is hostile', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();
  const html = await (await fetch(`${api.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /<h2>The Verdict<\/h2>/, 'report has a The Verdict section (the narrative IA replaces the old Slop Roast section)');
  // The HTML renderer (esc() in scans.js) escapes & < > " but leaves
  // apostrophes LITERAL — browsers show a real ' to the user, which is the
  // correct surface. Assert the renderer-escaped form so the test stays
  // deterministic for every pool line, whether or not it contains an
  // apostrophe (the JSON + DB surface carries the raw string; see above).
  const rendererEscaped = created.roast
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  assert.ok(html.includes(rendererEscaped), 'report shows the roast line in its renderer-escaped form (apostrophes literal)');
  const emoji = /<p class="roast">(\p{Extended_Pictographic})/u.exec(html);
  assert.ok(emoji, 'roast is emoji-tagged like other findings');

  // Escape safety: a hostile stored roast cannot inject markup into the report.
  const dbPath2 = tmpDb();
  const db = openDb(dbPath2);
  db.insertScan({
    id: 'hostile-roast-scan', url: 'https://x.test/', score: 60,
    breakdown: breakdown({ filler: 100, boilerplate: 0, infoDensity: 0, repetitive: 0 }, { crossPage: 0 }),
    createdAt: '2026-01-01T00:00:00.000Z',
    roast: '<script>alert(1)</script> & "quoted"',
  });
  db.close();
  const app2 = startApp(dbPath2);
  try {
    const html2 = await (await fetch(`${app2.base}/api/v1/scans/hostile-roast-scan`, { headers: { accept: 'text/html' } })).text();
    assert.ok(!html2.includes('<script>alert(1)</script>'), 'hostile roast not rendered as markup');
    assert.ok(html2.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'hostile roast entity-escaped');
  } finally {
    app2.server.close();
  }
});

test('card PNG: brand poster regenerates WITHOUT the roast (owner re-spec)', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();

  // The 1600x900 brand poster carries NO report content — the Slop Roast is
  // not rendered on the card (owner re-spec 2026-09-15). buildCardSvg ignores
  // the roast arg, and the roast text must never reach the poster.
  const svg = buildCardSvg({ score: created.slopScore, url: created.url, roast: created.roast });
  assert.ok(!svg.includes(escapeXml(created.roast.slice(0, 40))), 'roast text not on the poster');
  assert.ok(!svg.includes('x="64" y="514"'), 'old roast line position gone');

  // The poster renders a valid 1600x900 PNG, byte-deterministic per scan.
  const png = Buffer.from(await (await fetch(`${api.base}/api/v1/scans/${created.id}/card`)).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, CARD_WIDTH);
  assert.equal(meta.height, CARD_HEIGHT);
  const again = Buffer.from(await (await fetch(`${api.base}/api/v1/scans/${created.id}/card`)).arrayBuffer());
  assert.ok(png.equals(again), 'card bytes deterministic per scan');
  // Save a copy for the team to review.
  fs.writeFileSync('/home/team/shared/ass-score-card-no-roast.png', png);
});

test('roast stays deterministic for hand-inserted scans (pre-roast rows)', async () => {
  // Simulate a row written before the roast column existed (roast NULL): the
  // read path must derive the roast deterministically, not fail or return null.
  const dbPath2 = tmpDb();
  const db = openDb(dbPath2);
  const b = breakdown({ filler: 60, boilerplate: 30, infoDensity: 40, repetitive: 20 }, { crossPage: 0 });
  db.insertScan({
    id: 'pre-roast-scan-0001', url: 'https://legacy.example/', score: 31,
    breakdown: b, createdAt: '2026-01-01T00:00:00.000Z',
  });
  db.close();

  const app = startApp(dbPath2);
  try {
    const get1 = await (await fetch(`${app.base}/api/v1/scans/pre-roast-scan-0001`, { headers: { accept: 'application/json' } })).json();
    const get2 = await (await fetch(`${app.base}/api/v1/scans/pre-roast-scan-0001`, { headers: { accept: 'application/json' } })).json();
    assert.equal(typeof get1.roast, 'string');
    assert.ok(get1.roast.length > 0, 'old row still gets a roast');
    assert.equal(get1.roast, get2.roast, 'derived roast is deterministic');
    assert.equal(get1.roast, selectRoast({ id: 'pre-roast-scan-0001', slopScore: 31, breakdown: b }),
      'derived roast matches the scan-time function');
    assert.equal(get1.score, 31, 'stored 31 -> public 31 (same direction, no inversion)');
    assert.equal(get1.verdict, 'GETTING ASSY');
    assert.equal(get1.url, 'https://legacy.example/', 'existing fields intact');
  } finally {
    app.server.close();
  }
});

test('webhook payload carries the roast (bytes-exact with the response)', async () => {
  const calls = [];
  const stubDeliverer = async (payload) => { calls.push(payload); return { ok: true }; };
  const app = startApp(tmpDb(), { webhookDeliverer: stubDeliverer });
  try {
    const res = await post(app.base, { url: 'https://example.com/', webhookUrl: 'https://hooks.example.com/x' });
    const json = await res.json();
    // Wait for the async best-effort delivery.
    const deadline = Date.now() + 2000;
    while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 1, 'deliverer invoked');
    assert.equal(calls[0].roast, json.roast, 'webhook payload roast === response roast');
  } finally {
    app.server.close();
  }
});