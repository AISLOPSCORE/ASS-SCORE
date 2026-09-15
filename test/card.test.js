import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    [0, 'Cleanest', 'CLEANEST'],
    [9, 'Cleanest', 'CLEANEST'],
    [10, 'Clean', 'CLEAN'],
    [24, 'Clean', 'CLEAN'],
    [25, 'Getting assy', 'GETTING ASSY'],
    [49, 'Getting assy', 'GETTING ASSY'],
    [50, 'Very ass', 'VERY ASS'],
    [74, 'Very ass', 'VERY ASS'],
    [75, 'Extremely ass', 'EXTREMELY ASS'],
    [89, 'Extremely ass', 'EXTREMELY ASS'],
    [90, 'Catastrophically ass', 'CATASTROPHICALLY ASS'],
    [100, 'Catastrophically ass', 'CATASTROPHICALLY ASS'],
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
  assert.equal(verdictFor(-5), 'Cleanest');
  assert.equal(verdictFor(150), 'Catastrophically ass');
  assert.equal(verdictFor(73.6), 'Very ass'); // rounds to 74
  assert.equal(verdictFor('59'), 'Very ass');
  assert.equal(verdictFor(NaN), 'Cleanest');
});

test('scoreColor: green for low/good bands -> red for high/bad, color flips at every boundary', () => {
  assert.equal(scoreColor(5), '#4ade80', 'low (cleanest/good) -> green');
  assert.equal(scoreColor(10), '#a3e635', 'clean -> lime');
  assert.equal(scoreColor(25), '#facc15', 'getting assy -> yellow');
  assert.equal(scoreColor(60), '#fb923c', 'mid -> orange (VERY ASS)');
  assert.equal(scoreColor(90), '#f87171', 'high (bad) -> red');
  assert.equal(scoreColor(100), scoreColor(90));
  // Color flips at EVERY band boundary (9/10, 24/25, 49/50, 74/75, 89/90):
  for (const [low, high] of [[9, 10], [24, 25], [49, 50], [74, 75], [89, 90]]) {
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
  assert.ok(svgA.includes('VERY ASS'), 'exact band name embedded (73 -> VERY ASS)');
  assert.ok(svgA.includes('WE NEED TO TALK.'), 'donkey line 1 for VERY ASS');
  assert.ok(svgA.includes('(SERIOUSLY.)'), 'donkey line 2 for VERY ASS');
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

test('QA anchors: 7 -> CLEANEST/GOOD JOB., 50 -> VERY ASS/WE NEED TO TALK., 93 -> CATASTROPHICALLY ASS/YIKES.', () => {
  const s7 = buildCardSvg({ score: 7, url: 'https://handbuiltgoods.example.com' });
  assert.ok(s7.includes('CLEANEST'), '7 stamp = CLEANEST');
  assert.ok(s7.includes('GOOD JOB.'), '7 donkey line1 = GOOD JOB.');
  assert.ok(s7.includes('(RARE THESE DAYS)'), '7 donkey line2 = (RARE THESE DAYS)');
  assert.ok(s7.includes('#4ade80'), '7 uses the green band color');
  assert.equal(verdictBand(7).treat, 'celebrate');

  const s50 = buildCardSvg({ score: 50, url: 'https://brightsparkagency.example.com' });
  assert.ok(s50.includes('VERY ASS'), '50 stamp = VERY ASS');
  assert.ok(s50.includes('WE NEED TO TALK.'), '50 donkey line1 = WE NEED TO TALK.');
  assert.ok(s50.includes('(SERIOUSLY.)'), '50 donkey line2 = (SERIOUSLY.)');
  assert.ok(s50.includes('#fb923c'), '50 uses the orange band color');
  assert.equal(verdictBand(50).treat, 'warn');

  const s93 = buildCardSvg({ score: 93, url: 'https://supergrowth-ai.example.com' });
  assert.ok(s93.includes('CATASTROPHICALLY ASS'), '93 stamp = CATASTROPHICALLY ASS');
  assert.ok(s93.includes('YIKES.'), '93 donkey line1 = YIKES.');
  assert.ok(s93.includes('THIS IS BAD.'), '93 donkey line2 = THIS IS BAD.');
  assert.ok(s93.includes('#f87171'), '93 uses the red band color');
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
  assert.equal(json.url, `https://ass-score.com/scan/${created.id}`);
  assert.ok(json.text.includes(`${created.score}/100`), 'text carries the PUBLIC score');
  assert.ok(json.text.includes('A.S.S. Score (AI Slop Score)'), 'text carries the branded metric name');
  assert.ok(json.text.includes(json.url), 'text carries the public share URL');
  assert.ok(json.text.startsWith('My website scored '), 'pre-filled social post shape');
});

test('POST scan -> GET /card: pixel check — the poster shows the score in its band color', async () => {
  // The card fixture scores internal 75 (slop-heavy) -> PUBLIC 75, which is
  // in the deep-orange "extremely ass" band (75-89, #f97316). If the route
  // passed an inverted score (100 - 75 = 25 -> yellow "getting assy" band),
  // the giant number + stamp would render in a yellow band color instead.
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();
  assert.equal(created.score, 75, 'fixture scores 75 (higher = worse)');
  assert.equal(created.verdict, 'EXTREMELY ASS');

  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/card`);
  assert.equal(res.status, 200);
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, CARD_WIDTH);
  assert.equal(info.height, CARD_HEIGHT);

  // Count pixels inside the giant-number region that match the deep-orange
  // band color #f97316 (tolerance ±10/channel) — the big digits + stamp.
  const target = [0xf9, 0x73, 0x16];
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
  assert.ok(orangePixels > 500, `expected the deep-orange band color on the poster, got ${orangePixels} px`);
});

test('publicBaseUrl option overrides the share-link base', async () => {
  const app = startApp(tmpDb(), { publicBaseUrl: 'https://results.example.com' });
  try {
    const created = await (await post(app.base, { url: 'https://example.com/' })).json();
    const json = await (await fetch(`${app.base}/api/v1/scans/${created.id}/share`)).json();
    assert.equal(json.url, `https://results.example.com/scan/${created.id}`);
    assert.ok(json.text.includes('https://results.example.com/scan/'));
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
