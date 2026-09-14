import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { verdictFor, verdictLabel, scoreColor } from '../src/verdict.js';
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
    [19, 'Cleanest', 'CLEANEST'],
    [34, 'Cleanest', 'CLEANEST'],
    [35, 'Mildly generic', 'MILDLY GENERIC'],
    [54, 'Mildly generic', 'MILDLY GENERIC'],
    [55, 'Very ass', 'VERY ASS'],
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

test('scoreColor: green for low/good bands -> red for high/bad, band-changing at boundaries', () => {
  assert.equal(scoreColor(10), '#4ade80', 'low (clean/good) -> green');
  assert.equal(scoreColor(25), '#4ade80');
  assert.equal(scoreColor(60), '#facc15', 'mid -> amber (VERY ASS)');
  assert.equal(scoreColor(90), '#f87171', 'high (bad) -> red');
  assert.equal(scoreColor(100), scoreColor(90));
  assert.notEqual(scoreColor(34), scoreColor(35), 'color flips at the band boundary');
  assert.match(scoreColor(73), /^#[0-9a-f]{6}$/i);
});

test('escapeXml: escapes & < > " \' and strips XML-invalid control chars', () => {
  assert.equal(escapeXml('<a href="x&y">\'z\'</a>\u0000\u0001'),
    '&lt;a href=&quot;x&amp;y&quot;&gt;&apos;z&apos;&lt;/a&gt;');
  // Control chars that ARE valid in XML 1.0 (tab, LF, CR) survive:
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('displayUrl: host + path, root "/" dropped, long tails elided, host kept', () => {
  assert.equal(displayUrl('https://example.com/'), 'example.com');
  assert.equal(displayUrl('https://example.com/about'), 'example.com/about');
  assert.equal(displayUrl('https://example.com/a?b=1&c=it\'s'), "example.com/a?b=1&c=it%27s");
  assert.equal(displayUrl('http://localhost:4000/'), 'localhost:4000');
  const long = displayUrl('https://example.com/' + 'x'.repeat(400));
  assert.ok(long.startsWith('example.com/'), 'host always kept');
  assert.ok(long.endsWith('…') && long.length < 55, 'tail elided to fit one line');
  assert.equal(displayUrl('not a url at all'), 'not a url at all');
});

test('buildCardSvg: escaped URL, verdict, footer + disclaimer verbatim, deterministic', () => {
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
  assert.ok(svgA.includes('&apos;y&apos;'), "apostrophes escaped (attr- and text-safe)");
  // Score + verdict + branding + disclaimer verbatim (HIGHER = WORSE scale:
  // 73 = "VERY ASS", shown as the uppercase grade label):
  assert.ok(svgA.includes('>73<tspan'), 'score rendered as text');
  assert.ok(svgA.includes('/ 100'), 'scale rendered');
  assert.ok(svgA.includes('VERY ASS'), 'uppercase verdict label embedded');
  assert.ok(svgA.includes('A.S.S. SCORE') && svgA.includes('ass-score.com'), 'product branding');
  assert.ok(svgA.includes('ass-score.com · A.S.S. Score (AI Slop Score)'), 'footer line');
  // Score bar: fills proportionally, colored by the score's band.
  assert.ok(svgA.includes(`width="${Math.round((1072 * 73) / 100)}"`), 'score bar fill width matches score/100');
  assert.ok(svgA.includes(scoreColor(73)), 'score bar + verdict use the band color');
  // Mandated disclaimer, verbatim — the SVG wraps it onto two fixed footer
  // lines; assert both appear and the join is WORDPERFECT (not reworded):
  const dl1 = 'This tool identifies writing and design patterns commonly associated with generic or templated content.';
  const dl2 = 'It does not detect AI authorship and is not proof that any content was AI-generated.';
  assert.ok(svgA.includes(dl1), 'disclaimer line 1 verbatim');
  assert.ok(svgA.includes(dl2), 'disclaimer line 2 verbatim');
  assert.equal(`${dl1} ${dl2}`, DISCLAIMER, 'footer split is the verbatim disclaimer');
  assert.ok(svgA.includes('73 out of 100'), 'aria-label carries the score');
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

test('POST scan -> GET /card: 200 image/png, PNG magic, 1200x630, >20KB, deterministic', async () => {
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

test('POST scan -> GET /card: pixel check — the rendered PNG shows the score in its band color', async () => {
  // The card fixture scores internal 75 (slop-heavy) -> PUBLIC 75, which is
  // in the orange "extremely ass" band (75-89). If the route passed an
  // inverted score (100 - 75 = 25 -> green "cleanest" band), the number +
  // verdict would render in a green band color instead.
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();
  assert.equal(created.score, 75, 'fixture scores 75 (higher = worse)');
  assert.equal(created.verdict, 'EXTREMELY ASS');

  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/card`);
  assert.equal(res.status, 200);
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, CARD_WIDTH);
  assert.equal(info.height, CARD_HEIGHT);

  // Count pixels inside the score-number region that match the orange band
  // color #fb923c (tolerance ±10/channel) — the big digits + verdict text + bar fill.
  const target = [0xfb, 0x92, 0x3c];
  let orangePixels = 0;
  for (let y = 250; y < 480; y += 1) {
    for (let x = 64; x < 1000; x += 1) {
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
  assert.ok(orangePixels > 500, `expected the orange band color in the score region, got ${orangePixels} px`);
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