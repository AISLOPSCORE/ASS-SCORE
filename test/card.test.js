import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { verdictFor, verdictLabel, scoreColor, verdictBand } from '../src/verdict.js';
import {
  escapeXml,
  displayUrl,
  buildCardSvg,
  renderCardPng,
  DISCLAIMER,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '../src/card.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-card-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
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

// ---------------------------------------------------------------- unit tests

test('verdict bands: HIGHER = WORSE scale with exact boundary labels', () => {
  const cases = [
    [0, 'Clean', 'CLEAN'],
    [9, 'Clean', 'CLEAN'],
    [10, 'Mostly clean', 'MOSTLY CLEAN'],
    [19, 'Mostly clean', 'MOSTLY CLEAN'],
    [20, 'Slightly assy', 'SLIGHTLY ASSY'],
    [29, 'Slightly assy', 'SLIGHTLY ASSY'],
    [30, 'Assy', 'ASSY'],
    [39, 'Assy', 'ASSY'],
    [40, 'Pretty assy', 'PRETTY ASSY'],
    [49, 'Pretty assy', 'PRETTY ASSY'],
    [50, 'Very assy', 'VERY ASSY'],
    [59, 'Very assy', 'VERY ASSY'],
    [60, 'Heavily assy', 'HEAVILY ASSY'],
    [69, 'Heavily assy', 'HEAVILY ASSY'],
    [70, 'Extremely assy', 'EXTREMELY ASSY'],
    [79, 'Extremely assy', 'EXTREMELY ASSY'],
    [80, 'Catastrophically assy', 'CATASTROPHICALLY ASSY'],
    [89, 'Catastrophically assy', 'CATASTROPHICALLY ASSY'],
    [90, 'Beyond ass', 'BEYOND ASS'],
    [100, 'Beyond ass', 'BEYOND ASS'],
  ];
  for (const [score, label, shortLabel] of cases) {
    assert.equal(verdictFor(score), label, `score ${score}`);
    assert.equal(verdictLabel(score), shortLabel, `score ${score} short`);
  }
  // Every integer score 0-100 lands in exactly one band, no gaps:
  const labels = new Set(cases.map(([, v]) => v));
  for (let s = 0; s <= 100; s += 1) {
    assert.ok(labels.has(verdictFor(s)), `score ${s} mapped to unlisted verdict "${verdictFor(s)}"`);
  }
  // Out-of-range / non-integer inputs clamp deterministically (public scale):
  assert.equal(verdictFor(-5), 'Clean');
  assert.equal(verdictFor(150), 'Beyond ass');
  assert.equal(verdictFor(73.6), 'Extremely assy'); // rounds to 74
  assert.equal(verdictFor('59'), 'Very assy');
  assert.equal(verdictFor(NaN), 'Clean');
});

test('scoreColor: green for low/good bands -> dark red for high/bad, color flips at every boundary', () => {
  assert.equal(scoreColor(5), '#4ade80', 'low (clean/good) -> green');
  assert.equal(scoreColor(10), '#a3e635', 'mostly clean -> lime');
  assert.equal(scoreColor(25), '#facc15', 'slightly assy -> yellow');
  assert.equal(scoreColor(35), '#eab308', 'assy -> dark yellow');
  assert.equal(scoreColor(45), '#fb923c', 'pretty assy -> orange');
  assert.equal(scoreColor(55), '#f97316', 'very assy -> deep orange');
  assert.equal(scoreColor(65), '#f87171', 'heavily assy -> red');
  assert.equal(scoreColor(75), '#ef4444', 'extremely assy -> deeper red');
  assert.equal(scoreColor(85), '#dc2626', 'catastrophically assy -> dark red');
  assert.equal(scoreColor(90), '#b91c1c', 'high (bad) -> darkest red');
  assert.equal(scoreColor(100), scoreColor(90));
  // Color flips at EVERY band boundary (9/10, 19/20, 29/30, 39/40, 49/50,
  // 59/60, 69/70, 79/80, 89/90):
  for (const [low, high] of [[9, 10], [19, 20], [29, 30], [39, 40], [49, 50], [59, 60], [69, 70], [79, 80], [89, 90]]) {
    assert.notEqual(scoreColor(low), scoreColor(high), `color must flip at ${low}/${high}`);
  }
  assert.match(scoreColor(73), /^#[0-9a-f]{6}$/i);
});

test('escapeXml: escapes & < > " \' and strips XML-invalid control chars', () => {
  assert.equal(escapeXml('<a href="x&y">\'z\'</a>\u0000\u0001'),
    '&lt;a href=&quot;x&amp;y&quot;&gt;&apos;z&apos;&lt;/a&gt;');
  // Control chars that ARE valid in XML 1.0 (tab, LF, CR) survive:
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('displayUrl: host only, www. kept, scheme/path/query never rendered', () => {
  assert.equal(displayUrl('https://example.com/'), 'example.com');
  assert.equal(displayUrl('https://www.example.com/'), 'www.example.com', 'www. kept');
  assert.equal(displayUrl('https://example.com/about?q=1'), 'example.com', 'path/query dropped on the card');
  assert.equal(displayUrl('http://localhost:4000/'), 'localhost:4000');
  assert.equal(displayUrl('not a url at all'), 'not a url at all');
});

test('buildCardSvg: escaped URL, exact band name, messages, scale + disclaimer, deterministic', () => {
  const hostile = 'https://example.com/p<q"r&x=\'y\'';
  const svgA = buildCardSvg({ score: 73, url: hostile });
  const svgB = buildCardSvg({ score: 73, url: hostile });
  assert.equal(svgA, svgB, 'same inputs -> identical SVG');
  assert.ok(svgA.startsWith('<svg') && svgA.endsWith('</svg>'));
  assert.ok(svgA.includes(`width="${CARD_WIDTH}"`) && svgA.includes(`height="${CARD_HEIGHT}"`));
  // XML-injection safety: no raw tag/quotes from the URL survive anywhere.
  assert.ok(!svgA.includes('<q"r'), 'raw hostile fragment must not appear');
  assert.ok(svgA.includes('&lt;q&quot;r'), 'hostile fragment must be entity-escaped');
  assert.ok(svgA.includes("&amp;x="), '& escaped as entity');
  // Host-only URL on the display node (scheme/path dropped); the full url
  // still appears once in the aria-label (score + url, required).
  assert.ok(svgA.includes('>example.com<'), 'host rendered as the scanned label');
  assert.ok(!svgA.includes('>example.com/p&lt;q<'), 'path not rendered in the host display node');
  assert.ok(svgA.includes('/p&lt;q&quot;r'), 'full url kept only in the aria-label (escaped)');
  assert.ok(svgA.includes('>73<'), 'score rendered as text');
  assert.ok(svgA.includes('/ 100'), 'scale rendered');
  assert.ok(svgA.includes('EXTREMELY ASSY'), 'exact band name embedded (73 -> EXTREMELY ASSY)');
  assert.ok(svgA.includes('YIKES.'), 'donkey line 1 for EXTREMELY ASSY');
  assert.ok(svgA.includes('(GET THE FIRE EXTINGUISHER.)'), 'donkey line 2 for EXTREMELY ASSY');
  assert.ok(svgA.includes('A.S.S. SCORE') && svgA.includes('ass-score.com'), 'product branding');
  assert.ok(svgA.includes('0 = LEAST ASS') && svgA.includes('100 = MAX ASS'), 'ass-scale strip cue');
  assert.ok(svgA.includes('you are here'), 'scale marker present');
  assert.ok(svgA.includes('data:image/png;base64,'), 'donkey mascot embedded as data-URI');
  assert.ok(!svgA.includes('feTurbulence') && !svgA.includes('feDisplacementMap'), 'no SVG filters (determinism)');
  // NO report content on the poster:
  for (const banned of ['breakdown', 'insights', 'findings', 'receipts', 'pricing', '$12', 'Get Roasted']) {
    assert.ok(!svgA.includes(banned), `poster must not include "${banned}"`);
  }
  // Mandated disclaimer, verbatim — split across two fixed footer lines;
  // the join must be WORDPERFECT (never reworded) and match DISCLAIMER.
  const dl1 = 'This tool identifies writing and design patterns commonly associated with generic or templated content.';
  const dl2 = 'It does not detect AI authorship and is not proof that any content was AI-generated.';
  assert.ok(svgA.includes(dl1), 'disclaimer line 1 verbatim');
  assert.ok(svgA.includes(dl2), 'disclaimer line 2 verbatim');
  assert.equal(`${dl1} ${dl2}`, DISCLAIMER, 'footer split is the verbatim disclaimer');
  // aria-label carries score + url.
  assert.ok(svgA.includes('73 out of 100'), 'aria-label carries the score');
  assert.ok(svgA.includes('for https://example.com/p&lt;q&quot;r'), 'aria-label carries the raw url (escaped)');
});

test('QA anchors: 7 -> CLEAN/GOOD JOB., 50 -> VERY ASSY/OK, THIS IS A LOT., 93 -> BEYOND ASS/ABANDON HOPE.', () => {
  const s7 = buildCardSvg({ score: 7, url: 'https://handbuiltgoods.example.com' });
  assert.ok(s7.includes('CLEAN'), '7 stamp = CLEAN');
  assert.ok(s7.includes('GOOD JOB.'), '7 donkey line1 = GOOD JOB.');
  assert.ok(s7.includes('(RARE THESE DAYS)'), '7 donkey line2 = (RARE THESE DAYS)');
  assert.ok(s7.includes('#4ade80'), '7 uses the green band color');
  assert.equal(verdictBand(7).treat, 'celebrate');

  const s50 = buildCardSvg({ score: 50, url: 'https://brightsparkagency.example.com' });
  assert.ok(s50.includes('VERY ASSY'), '50 stamp = VERY ASSY (the hinge)');
  assert.ok(s50.includes('OK, THIS IS A LOT.'), '50 donkey line1 = OK, THIS IS A LOT.');
  assert.ok(s50.includes('(OF ASS.)'), '50 donkey line2 = (OF ASS.)');
  assert.ok(s50.includes('#f97316'), '50 uses the deep-orange band color');
  assert.equal(verdictBand(50).treat, 'warn');

  const s93 = buildCardSvg({ score: 93, url: 'https://supergrowth-ai.example.com' });
  assert.ok(s93.includes('BEYOND ASS'), '93 stamp = BEYOND ASS');
  assert.ok(s93.includes('ABANDON HOPE.'), '93 donkey line1 = ABANDON HOPE.');
  assert.ok(s93.includes('(EVERYTHING IS ASS.)'), '93 donkey line2 = (EVERYTHING IS ASS.)');
  assert.ok(s93.includes('#b91c1c'), '93 uses the darkest-red band color');
  assert.equal(verdictBand(93).treat, 'alarm');
});

test('renderCardPng: valid PNG, right size, byte-identical across renders', async () => {
  const svg = buildCardSvg({ score: 30, url: 'https://example.com/' });
  const a = await renderCardPng(svg);
  const b = await renderCardPng(svg);
  assert.ok(Buffer.isBuffer(a) && a.length > 0);
  assert.ok(a.equals(b), 'two renders of the same SVG -> identical bytes');
  assert.deepEqual([...a.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const meta = await sharp(a).metadata();
  assert.equal(meta.width, CARD_WIDTH);
  assert.equal(meta.height, CARD_HEIGHT);
  // A hostile URL must still render (no XML-injection crash in the rasterizer):
  await renderCardPng(buildCardSvg({ score: 73, url: 'https://example.com/p<q"r&x=\'y\'' }));
});

// -------------------------------------------------------- integration tests

let api;
let dbPath;

before(() => {
  dbPath = tmpDb();
  api = startApp(dbPath);
});

after(() => {
  api.server.close();
});

test('POST scan -> GET /card: 200 image/png, PNG magic, 1600x900, >20KB, deterministic', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();

  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/card`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/png/);
  assert.match(res.headers.get('cache-control'), /public/, 'card is publicly cacheable');
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic bytes');
  assert.ok(png.length > 20_000, `card is a real rendered image (${png.length} bytes)`);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, CARD_WIDTH);
  assert.equal(meta.height, CARD_HEIGHT);

  // Determinism: a second HTTP render is byte-for-byte identical (sha256-equal).
  const again = Buffer.from(await (await fetch(`${api.base}/api/v1/scans/${created.id}/card`)).arrayBuffer());
  assert.ok(png.equals(again), 'two HTTP renders -> identical PNG bytes');
});

test('POST scan -> GET /share: pre-filled text + public result URL (public score)', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();

  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/share`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.url, `https://www.ass-score.com/scan/${created.id}`);
  // Share text is the bare-homepage sentence with the PUBLIC score — no deep link.
  assert.equal(
    json.text,
    `My website got an A.S.S. Score of ${created.score}/100 (low is good). Check yours at ass-score.com`,
  );
  assert.ok(!json.text.includes(json.url), 'share text carries NO /scan deep link');
  assert.ok(!json.text.includes('https://'), 'share text is the bare homepage, no scheme');
});

test('POST scan -> GET /card: pixel check — the poster shows the score in its band color', async () => {
  // The card fixture scores internal 75 (slop-heavy) -> PUBLIC 75, which is
  // in the red "extremely assy" band (70-79, #ef4444). If the route
  // passed an inverted score (100 - 75 = 25 -> yellow "slightly assy" band),
  // the giant number + stamp would render in a yellow band color instead.
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();
  assert.equal(created.score, 75, 'fixture scores 75 (higher = worse)');
  assert.equal(created.verdict, 'EXTREMELY ASSY');

  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/card`);
  assert.equal(res.status, 200);
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, CARD_WIDTH);
  assert.equal(info.height, CARD_HEIGHT);

  // Count pixels inside the giant-number region that match the red band
  // color #ef4444 (tolerance ±10/channel) — the big digits + stamp.
  const target = [0xef, 0x44, 0x44];
  let orangePixels = 0;
  for (let y = 380; y < 780; y += 1) {
    for (let x = 84; x < 700; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (
        Math.abs(data[i] - target[0]) <= 10 &&
        Math.abs(data[i + 1] - target[1]) <= 10 &&
        Math.abs(data[i + 2] - target[2]) <= 10
      ) {
        orangePixels += 1;
      }
    }
  }
  assert.ok(orangePixels > 500, `expected the red band color on the poster, got ${orangePixels} px`);
});

test('publicBaseUrl option overrides the share-link base', async () => {
  const app = startApp(tmpDb(), { publicBaseUrl: 'https://results.example.com' });
  try {
    const created = await (await post(app.base, { url: 'https://example.com/' })).json();
    const json = await (await fetch(`${app.base}/api/v1/scans/${created.id}/share`)).json();
    assert.equal(json.url, `https://results.example.com/scan/${created.id}`);
    // The share text is the fixed bare-homepage sentence (public score) — the
    // publicBaseUrl override affects the url field, not the social post copy.
    assert.equal(
      json.text,
      `My website got an A.S.S. Score of ${created.score}/100 (low is good). Check yours at ass-score.com`,
    );
  } finally {
    app.server.close();
  }
});

test('GET /card and /share for a missing id -> 404 with the same JSON error shape', async () => {
  for (const ep of ['card', 'share']) {
    const res = await fetch(`${api.base}/api/v1/scans/does-not-exist/${ep}`);
    assert.equal(res.status, 404, ep);
    const json = await res.json();
    assert.equal(json.error.code, 'not_found', ep);
    assert.ok(json.error.message.includes('does-not-exist'), ep);
  }
});

// ------------------------------------------------- card-polish region tests
// (owner polish pass 2026-09-24: TL accents removed, ass-score.com moved to
// the bottom-right, donkey zone shifted right / sign shifted left so the sign
// no longer covers the torso). All assertions live on the FINAL rendered PNG
// (or the committed donkey-sharecard.png itself) — never on SVG strings, so a
// layout regression that survives the SVG but shows up in pixels still fails.

const CARDS = [
  { score: 7, url: 'https://www.example.com', band: [0x4a, 0xde, 0x80], treat: 'celebrate' },
  { score: 50, url: 'https://www.example.com', band: [0xf9, 0x73, 0x16], treat: 'warn' },
  { score: 93, url: 'https://www.example.com', band: [0xb9, 0x1c, 0x1c], treat: 'alarm' },
];

async function cardRaw(svg) {
  const { data, info } = await sharp(svg).raw().toBuffer({ resolveWithObject: true });
  return { data, info, png: svg };
}

function countRegion(data, info, x0, y0, x1, y1, pred) {
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (pred(data[i], data[i + 1], data[i + 2])) n += 1;
    }
  }
  return n;
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const grayish = (r, g, b) => Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12 && Math.abs(r - b) <= 12 && r > 50;
const matchRgb = (r, g, b, [tr, tg, tb], tol = 14) =>
  Math.abs(r - tr) <= tol && Math.abs(g - tg) <= tol && Math.abs(b - tb) <= tol;

test('card polish (a): old top-left accent box (870-945, 92-135) is ink-empty for CLEAN / VERY ASSY / BEYOND ASS', async () => {
  const accentColors = { celebrate: null, warn: [0xfa, 0xcc, 0x15], alarm: [0xff, 0x3d, 0x8e] }; // old TL white / TLyellow / TLpink2
  for (const { score, treat } of CARDS) {
    const { data, info } = await cardRaw(await renderCardPng(buildCardSvg({ score, url: 'https://www.example.com' })));
    assert.equal(info.width, CARD_WIDTH);
    assert.equal(info.height, CARD_HEIGHT);
    const check = (pred) => countRegion(data, info, 870, 92, 945, 135, pred);
    assert.equal(check((r, g, b) => lum(r, g, b) > 180), 0, `score ${score}: no bright near-white tick strokes`);
    assert.equal(check((r, g, b) => r + g + b > 30), 0, `score ${score}: region holds NO ink at all`);
    const accent = accentColors[treat];
    if (accent) {
      assert.equal(
        check((r, g, b) => matchRgb(r, g, b, accent, 12)),
        0, `score ${score}: old TL accent color absent`);
    }
  }
});

test('card polish (b): ass-score.com URL moved out of the top-right text band into the bottom-right band', async () => {
  for (const { score } of CARDS) {
    const { data, info } = await cardRaw(await renderCardPng(buildCardSvg({ score, url: 'https://www.example.com' })));
    const topRight = countRegion(data, info, 1380, 70, 1520, 100, grayish);
    assert.equal(topRight, 0, `score ${score}: no URL-text (grayish-white) ink in the old top-right text band`);
    // The band is not vacuous: the treatment accent (lime star / pink ticks)
    // still lives top-right, so a missing text check is meaningful. The floors
    // are the accent's own color-matched core pixels. (Recalibrated for the
    // 2026-09-24 donkey swap: the old 372×580 head sat at card y≥66 and poked
    // bright sunglasses pixels into this band, inflating the old blanket
    // brightness count past 100; the 1191×1186 meet-fit head starts at y≈215,
    // so the band now measures the accent alone — measured 7: 132 lime px,
    // 50: 64 pink px, 93: 386 pink px.)
    const accentPreds = {
      7: (r, g, b2) => matchRgb(r, g, b2, [0xd4, 0xf0, 0x00]),
      50: (r, g, b2) => matchRgb(r, g, b2, [0xff, 0x3d, 0x8e]),
      93: (r, g, b2) => matchRgb(r, g, b2, [0xff, 0x3d, 0x8e]),
    };
    const accentFloors = { 7: 80, 50: 40, 93: 200 };
    const accentInk = countRegion(data, info, 1380, 70, 1520, 100, accentPreds[score]);
    assert.ok(accentInk > accentFloors[score], `score ${score}: top-right still carries accent ink (${accentInk} px)`);
    const bottomRight = countRegion(data, info, 1280, 852, 1520, 872, grayish);
    assert.ok(bottomRight > 200, `score ${score}: URL text present in the bottom-right band (${bottomRight} px)`);
  }
});

test('card polish (c): sign header fully visible — no donkey pixels cover the sign; sign clear of the torso', async () => {
  for (const { score, band } of CARDS) {
    const { data, info } = await cardRaw(await renderCardPng(buildCardSvg({ score, url: 'https://www.example.com' })));
    // Row band across the sign header (y 565-585, x 700-1100): the band-colored
    // header, the dark "A.S.S. SCORE / OFFICIAL" title text and the white paper
    // must all be present — the sign face renders unobstructed.
    const dark = countRegion(data, info, 700, 565, 1100, 585, (r, g, b2) => r < 60 && g < 60 && b2 < 60);
    const header = countRegion(data, info, 700, 565, 1100, 585, (r, g, b2) => matchRgb(r, g, b2, band));
    const paper = countRegion(data, info, 700, 565, 1100, 585, (r, g, b2) => matchRgb(r, g, b2, [0xf2, 0xf1, 0xea]));
    assert.ok(dark > 100, `score ${score}: dark title text visible on the sign (${dark} px)`);
    assert.ok(header > 2000, `score ${score}: band-colored header visible (${header} px)`);
    assert.ok(paper > 500, `score ${score}: white sign paper visible (${paper} px)`);
  }

  // Donkey-zone alpha coverage in the sign band (card y 538-774). The
  // committed donkey-sharecard.png is the near-square 1191×1186 cutout rendered
  // with preserveAspectRatio="xMidYMid meet": scale = min(510/1191, 795/1186)
  // ≈ 0.4282 → full-box footprint 510×508, vertically centered at card y
  // ≈ 209.5-717.5 (asset row 0 ↔ card y 209.5, asset row 1186 ↔ card y 717.5).
  // In asset coordinates the sign band (card y 538-717.5) spans asset y
  // 766-1186 (the donkey's lower body/legs) and the sign's right edge (card x
  // 1096) maps to asset x ≈ 61. The cutout's content starts at asset x 209, so
  // the whole sign-overlap sliver (card x 1070-1096 ↔ asset x 0-61, every row
  // of it) is donkey-free while the torso remains present to its right.
  const asset = fs.readFileSync(new URL('../src/assets/donkey-sharecard.png', import.meta.url));
  const { data: adata, info: ainfo } = await sharp(asset).raw().toBuffer({ resolveWithObject: true });
  assert.equal(ainfo.width, 1191, 'asset is the 1191px-wide approved share-card cutout');
  assert.equal(ainfo.height, 1186);
  const M_SCALE = Math.min(510 / ainfo.width, 795 / ainfo.height); // meet scale ≈ 0.4282
  const meetTop = 66 + (795 - ainfo.height * M_SCALE) / 2; // card y of asset row 0 ≈ 209.5
  const ax = (cardX) => (cardX - 1070) / M_SCALE; // card x -> asset x
  const ay = (cardY) => (cardY - meetTop) / M_SCALE; // card y -> asset y
  const sliverX = Math.ceil(ax(1096)); // sign right edge (card 1096) -> asset x ≈ 61
  const bandY0 = Math.floor(ay(538)); // sign top row (card 538) -> asset y ≈ 766
  const opaqueIn = (x0, x1) => {
    let n = 0;
    for (let y = bandY0; y < ainfo.height; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (adata[(y * ainfo.width + x) * 4 + 3] > 10) n += 1;
      }
    }
    return n;
  };
  assert.equal(opaqueIn(0, sliverX), 0, 'sign overlap sliver (asset x 0-61 across the whole sign band) contains no donkey pixels');
  const body = opaqueIn(sliverX, ainfo.width);
  assert.ok(body > 100000, `torso present right of the sign edge (${body} opaque px in band)`);
  // The body's left edge is well clear of the new sign right edge (asset x 61):
  let minX = ainfo.width;
  for (let y = bandY0; y < ainfo.height; y += 1) {
    for (let x = sliverX; x < ainfo.width; x += 1) {
      if (adata[(y * ainfo.width + x) * 4 + 3] > 10 && x < minX) minX = x;
    }
  }
  assert.ok(minX >= 470, `torso left edge at asset x ${minX} — clear of sign edge x ${sliverX}`);
});

test('donkey meet fit: committed asset byte-verbatim, footprint contained in the zone, meet math 510×508 centered', async () => {
  // (a) The committed asset is the owner-approved file, byte-for-byte, with a
  // durable sha256 pin (a later swap can't sneak in undetected even where the
  // source file isn't present on the machine running the tests).
  const committed = fs.readFileSync(new URL('../src/assets/donkey-sharecard.png', import.meta.url));
  const SOURCE = '/home/team/shared/NewSharecarddonkey.png';
  if (fs.existsSync(SOURCE)) {
    assert.ok(committed.equals(fs.readFileSync(SOURCE)), 'committed asset equals the owner-provided file byte-for-byte');
  }
  assert.equal(
    createHash('sha256').update(committed).digest('hex'),
    'e7a647c240cc77f3e97177bc8cf4b4a0e9dd7108df69274ce13289f68a611b78',
    'committed donkey-sharecard.png is the pinned approved cutout',
  );

  // (c) meet math: scale = min(510/1191, 795/1186) ≈ 0.4282 -> 510×508,
  // vertically centered inside the fixed zone (66..861).
  const { width, height } = await sharp(committed).metadata();
  assert.equal(width, 1191);
  assert.equal(height, 1186);
  const scale = Math.min(510 / width, 795 / height);
  const fitW = width * scale; // ≈ 510.0
  const fitH = height * scale; // ≈ 507.9
  assert.ok(Math.abs(fitW - 510) <= 2, `meet width ${fitW}`);
  assert.ok(Math.abs(fitH - 508) <= 2, `meet height ${fitH}`);
  const fitY = 66 + (795 - fitH) / 2; // ≈ 209.6
  const fitBottom = fitY + fitH; // ≈ 717.4
  assert.ok(fitY >= 66 && fitBottom <= 861, 'meet box fully inside the zone');
  assert.ok(Math.abs((fitY - 66) - (861 - fitBottom)) <= 1, 'vertically centered (equal top/bottom margins)');

  // (b) Rendered footprint: diff the card with vs without the <image> element.
  // The changed pixels are exactly the donkey's on-card content (everything
  // else is identical — the accents/sign/URL paint over or clear of the zone).
  // Assert the bbox stays inside x1070-1580 / y66-861 for every band.
  for (const { score } of CARDS) {
    const png = await renderCardPng(buildCardSvg({ score, url: 'https://www.example.com' }));
    const noDonkey = await renderCardPng(buildCardSvg({ score, url: 'https://www.example.com' }).replace(/<image [^>]*\/>/, ''));
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const dn = await sharp(noDonkey).raw().toBuffer();
    let changed = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, oob = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const i = (y * info.width + x) * 4;
        if (data[i] !== dn[i] || data[i + 1] !== dn[i + 1] || data[i + 2] !== dn[i + 2] || data[i + 3] !== dn[i + 3]) {
          changed += 1;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
          if (x < 1070 || x >= 1580 || y < 66 || y >= 861) oob += 1;
        }
      }
    }
    assert.ok(changed > 50000, `score ${score}: donkey footprint present on the card (${changed} px)`);
    assert.equal(oob, 0, `score ${score}: zero changed pixels outside the zone`);
    assert.ok(bx0 >= 1070 && by0 >= 66 && bx1 < 1580 && by1 < 861, `score ${score}: bbox ${bx0},${by0}-${bx1},${by1} inside x1070-1580 / y66-861`);
    const bh = by1 - by0 + 1;
    assert.ok(bh >= 470 && bh <= 510, `score ${score}: rendered content height ${bh} px (content ≈ 495, meet box ≈ 508)`);
  }
});

test('card polish (d): byte-determinism — two renders of the same inputs are identical PNGs (7 / 50 / 93)', async () => {
  for (const { score, url } of CARDS) {
    const a = await renderCardPng(buildCardSvg({ score, url }));
    const b = await renderCardPng(buildCardSvg({ score, url }));
    assert.ok(a.equals(b), `score ${score}: two renders -> identical PNG bytes`);
    const meta = await sharp(a).metadata();
    assert.equal(meta.width, CARD_WIDTH);
    assert.equal(meta.height, CARD_HEIGHT);
  }
});
