import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { validateBranding, isHttpUrl } from '../src/branding.js';
import sharp from 'sharp';
import { buildCardSvg, renderCardPng } from '../src/card.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-brand-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
// Blows up if called — proves invalid branding fails BEFORE any scanning I/O.
const neverFetcher = {
  fetchHtml: async () => { throw new Error('fetcher must not be called for invalid branding'); },
};

/** Stub deliverer that records the webhook payload (proves branding rides along). */
function stubDeliverer() {
  const calls = [];
  const deliver = async (payload, webhookUrl) => { calls.push({ payload, webhookUrl }); return { ok: true, attempts: 1 }; };
  deliver.calls = calls;
  return deliver;
}

// Route-level SSRF guard, DNS-skipping variant (see webhookFulfillment.test.js).
const offlineValidateTarget = async (raw) => validateUrl(raw);

// Fixed paywall secret so tests can mint report tokens. Branding is PAID
// content: the agency chrome renders ONLY on the token'd full report.
const TOKEN_SECRET = 'branding-test-secret';

function startApp(dbPath, fetcher, webhookDeliverer, options = {}) {
  const app = createApp({ dbPath, fetcher, webhookDeliverer, validateTarget: offlineValidateTarget, reportTokenSecret: TOKEN_SECRET, ...options });
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

const getHtml = (base, id) =>
  fetch(`${base}/api/v1/scans/${id}`, { headers: { accept: 'text/html' } }).then((r) => r.text());

/** Fetch the token'd full report HTML (the only surface branding renders on). */
const getPaidHtml = (base, id) =>
  fetch(`${base}/api/v1/scans/${id}?token=${createReportToken(TOKEN_SECRET, id)}`, { headers: { accept: 'text/html' } }).then((r) => r.text());

const DISCLAIMER =
  'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';

// ------------------------------------------------------------- unit: validator

test('validateBranding: missing / null / empty object -> no branding', () => {
  for (const v of [undefined, null, {}]) {
    const r = validateBranding(v);
    assert.deepEqual(r, { ok: true, branding: null }, `value ${JSON.stringify(v)}`);
  }
  // Only unknown keys -> nothing to apply -> treated as no branding.
  assert.deepEqual(validateBranding({ foo: 'bar', nope: 42 }), { ok: true, branding: null });
});

test('validateBranding: valid branding normalized (trimmed, URL normalized, unknown keys dropped)', () => {
  const r = validateBranding({
    agencyName: '   Acme Agency  ',
    logoUrl: '  https://acme.example/logo.png  ',
    accentColor: '#33AA66',
    footerText: '  Audit by Acme  ',
    unknownKey: 'ignored',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.branding, {
    agencyName: 'Acme Agency',
    logoUrl: 'https://acme.example/logo.png',
    accentColor: '#33AA66',
    footerText: 'Audit by Acme',
  });
});

test('validateBranding: invalid values rejected (wrong types/shapes -> 400 invalid_branding upstream)', () => {
  const bad = [
    ['not an object', 'branding must be an object'],
    [42, 'branding must be an object'],
    [['https://x'], 'branding must be an object'],
    [{ agencyName: 42 }, 'branding.agencyName must be a string'],
    [{ agencyName: '   ' }, 'branding.agencyName must not be empty'],
    [{ agencyName: 'x'.repeat(121) }, 'branding.agencyName must be at most 120 characters'],
    [{ logoUrl: 'javascript:alert(1)' }, 'branding.logoUrl must be an http(s) URL with a host'],
    [{ logoUrl: 'ftp://example.com/x' }, 'branding.logoUrl must be an http(s) URL with a host'],
    [{ logoUrl: 'file:///etc/passwd' }, 'branding.logoUrl must be an http(s) URL with a host'],
    [{ logoUrl: 'http://' }, 'branding.logoUrl must be an http(s) URL with a host'],
    [{ logoUrl: 42 }, 'branding.logoUrl must be a string'],
    [{ logoUrl: '   ' }, 'branding.logoUrl must not be empty'],
    [{ accentColor: 'red' }, /hex color/],
    [{ accentColor: 'red;}</style><script>x</script>' }, /hex color/],
    [{ accentColor: '#fff000;color:red' }, /hex color/],
    [{ accentColor: '##336699' }, /hex color/],
    [{ accentColor: 123 }, 'branding.accentColor must be a string'],
    [{ footerText: 42 }, 'branding.footerText must be a string'],
    [{ footerText: '' }, 'branding.footerText must not be empty'],
    [{ footerText: 'x'.repeat(201) }, 'branding.footerText must be at most 200 characters'],
  ];
  for (const [value, expect] of bad) {
    const r = validateBranding(value);
    assert.equal(r.ok, false, `expected rejection: ${JSON.stringify(value)}`);
    if (expect instanceof RegExp) assert.match(r.message, expect);
    else assert.equal(r.message, expect);
  }
});

test('isHttpUrl: only http(s) with a host counts', () => {
  assert.equal(isHttpUrl('https://x.example/logo.png'), true);
  assert.equal(isHttpUrl('http://x.example/'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('ftp://x.example/'), false);
  assert.equal(isHttpUrl('https://'), false);
  assert.equal(isHttpUrl(42), false);
});

// ------------------------------------------------------------------ app wiring

let api;        // fake fetcher + stub webhook (records delivered payloads)
let apiDbPath;  // DB the success-path app uses (for direct row assertions)
let stub;       // api's webhook deliverer
let strictApi;  // neverFetcher + stub deliverer (fail-fast validation)
let strictStub;

before(() => {
  apiDbPath = tmpDb();
  stub = stubDeliverer();
  api = startApp(apiDbPath, fakeFetcher(SLOP_HTML), stub, { maxScansPerDay: 100 }); // shared app scans 5x; default 3/IP/day would 429
  strictStub = stubDeliverer();
  strictApi = startApp(tmpDb(), neverFetcher, strictStub);
});

after(() => {
  api.server.close();
  strictApi.server.close();
});

test('POST /api/v1/scan: invalid branding -> 400 invalid_branding WITHOUT scanning', async () => {
  const cases = [
    { branding: 'nope' },
    { branding: ['https://x'] },
    { branding: { agencyName: 42 } },
    { branding: { logoUrl: 'javascript:alert(1)' } },
    { branding: { accentColor: 'red;}</style>' } },
    { branding: { footerText: '' } },
    { branding: { logoUrl: 'https://' } },
    { branding: { agencyName: 'x'.repeat(200) } },
  ];
  for (const c of cases) {
    const res = await post(strictApi.base, { url: 'https://example.com/', ...c });
    assert.equal(res.status, 400, JSON.stringify(c));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_branding', JSON.stringify(c));
    assert.ok(json.error.message.length > 0);
  }
  // neverFetcher would 500 if the scan pipeline ran; a 400 proves the request
  // failed before any scanning I/O.
  assert.equal(strictStub.calls.length, 0, 'no delivery for failed validation');
});

const AGENCY = {
  agencyName: 'Acme Agency',
  logoUrl: 'https://acme.example/logo.png',
  accentColor: '#33AA66',
  footerText: 'Audit prepared by Acme Agency',
};

test('POST /api/v1/scan: valid branding -> 200, NOT leaked on the free payload, stored in sqlite, rendered by the paid report', async () => {
  const res = await post(api.base, { url: 'https://example.com/', branding: AGENCY, webhookUrl: 'https://hooks.example.com/x' });
  assert.equal(res.status, 200);
  const json = await res.json();
  // PAYWALL: branding is PAID content (agency config for the full report) —
  // the free response and the free webhook payload never carry it.
  assert.ok(!('branding' in json), 'branding is stripped from the free response payload');

  // Persisted in SQLite (branding TEXT/JSON column) — survives the gate.
  const row = new Database(apiDbPath).prepare('SELECT branding FROM scans WHERE id = ?').get(json.id);
  assert.ok(row, 'row should exist in sqlite');
  assert.deepEqual(JSON.parse(row.branding), AGENCY);

  // GET /api/v1/scans/:id JSON (free) also strips branding.
  const got = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
  assert.ok(!('branding' in got), 'stored scan JSON does not leak branding to the free tier');

  // Webhook payload is the exact gated free response object (bytes-exact).
  assert.equal(stub.calls.length, 1);
  const { payload, webhookUrl } = stub.calls[0];
  assert.equal(webhookUrl, 'https://hooks.example.com/x');
  assert.deepEqual(payload, json);
  assert.ok(!('branding' in payload), 'webhook payload carries the gated free object (no branding)');

  // The paid report (token route) DOES render the stored branding.
  const paid = await getPaidHtml(api.base, json.id);
  assert.ok(paid.includes('Acme Agency'), 'paid report renders the agency name');
  assert.ok(paid.includes('Audit prepared by Acme Agency'), 'paid report renders the agency footer');
});

test('branded scan -> HTML report (token) renders agency name, logo, accent, footer; A.S.S. Score + disclaimer intact', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/', branding: AGENCY })).json();
  const html = await getPaidHtml(api.base, created.id);

  // White-label chrome:
  assert.match(html, /<h1[^>]*>Acme Agency<\/h1>/, 'agency name in the header');
  assert.ok(html.includes('A.S.S. Score report · powered by'), 'metric stays visible when branded');
  assert.ok(html.includes('<img src="https://acme.example/logo.png"'), 'agency logo rendered');
  assert.ok(html.includes('color:#33AA66'), 'accent color applied via inline style');
  assert.ok(html.includes('<p class="footer">Audit prepared by Acme Agency</p>'), 'footerText rendered');

  // ALWAYS-keep invariants: metric label, customer category names, disclaimer.
  assert.ok(html.includes('A.S.S. Score: '), 'metric label present');
  assert.ok(html.includes('MESSAGING'), 'customer category names present');
  assert.ok(html.includes('Your Breakdown'), 'breakdown section present');
  assert.ok(html.includes(DISCLAIMER), 'mandated disclaimer present verbatim');
  assert.ok(html.includes('<title>A.S.S. Score report</title>'), 'title keeps the metric name');

  // The FREE page never shows the agency chrome.
  const free = await getHtml(api.base, created.id);
  assert.ok(!free.includes('Acme Agency'), 'free teaser page carries no agency branding');
});

test('missing branding -> 200 and the default report is unchanged (no white-label chrome)', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/' })).json();
  assert.equal('branding' in created, false, 'no branding key on a plain scan response');
  const html = await getPaidHtml(api.base, created.id);

  assert.match(html, /<h1>A\.S\.S\. Score report<\/h1>/, 'default header');
  assert.ok(!html.includes('powered by'), 'no powered-by line');
  // Agency logos are absolute http(s) URLs; the ONLY <img> the default report
  // may carry is the approved mascot analyst (relative /assets/… path).
  assert.ok(!html.includes('<img src="http'), 'no agency logo img');
  assert.ok(html.includes('src="/assets/donkey-dashboard.png"'), 'approved mascot analyst image present');
  assert.ok(!html.includes('class="footer"'), 'no agency footer');
  assert.ok(!html.includes('color:#'), 'no accent inline color');
  assert.ok(html.includes(DISCLAIMER), 'disclaimer still present');
  assert.ok(html.includes('A.S.S. Score: '), 'metric label still present');
});

// ------------------------------------------------------------------ injection

const HOSTILE = {
  agencyName: '"><img src=x onerror=alert(1)>',
  logoUrl: 'https://evil.example/a?b="><script>/',
  accentColor: '#fff000',
  footerText: '</p><script>window.pwned=1</script>',
};

test('hostile branding values are HTML-escaped in the paid report (no markup injection)', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/', branding: HOSTILE })).json();
  // PAYWALL: branding never rides the free payload (not even normalized).
  assert.ok(!('branding' in created), 'hostile branding is not echoed on the free payload');
  const html = await getPaidHtml(api.base, created.id);

  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'agency name escaped in the h1');
  assert.ok(!html.includes('"><'), 'no raw quote-bracket sequence (no attribute/value breakout)');
  assert.ok(!html.includes('<img src=x'), 'no raw injected img tag');
  // The report carries EXACTLY ONE script — its own inline Phase 2C view
  // toggle (owner-sanctioned: dependency-free, inline). Hostile branding
  // must never add a second one, and its payloads stay escaped.
  assert.equal((html.match(/<script\b/g) ?? []).length, 1,
    "exactly the report's own inline 2C script — hostile branding cannot inject another");
  assert.ok(html.includes('<script>\n/* Phase 2C category drill-down'), "the single script is the report's own 2C view toggle");
  assert.ok(html.includes('&lt;script&gt;window.pwned=1&lt;/script&gt;'), 'footerText escaped');
  assert.ok(html.includes('#fff000'), 'valid accent color still applied');
  // Even under hostile branding the mandated content survives:
  assert.ok(html.includes('A.S.S. Score: '));
  assert.ok(html.includes(DISCLAIMER));
});

// ----------------------------------------------------------------------- card

test('card: agency branding is NEVER rendered (owner hard-drop); card stays deterministic', () => {
  // The 1600x900 poster is a standalone brand artifact — agency/whitelabel names are a HARD
  // DROP (owner re-spec 2026-09-15). Passing agencyName is tolerated but ignored; the
  // rendered SVG never contains it.
  const base = { score: 30, url: 'https://example.com/' };
  const plain = buildCardSvg(base);
  const branded = buildCardSvg({ ...base, agencyName: 'Acme Agency' });
  const hostile = buildCardSvg({ ...base, agencyName: '<svg onload=alert(1)>' });
  assert.equal(plain, branded, 'agencyName does not change the card (ignored)');
  assert.ok(!plain.includes('Acme'), 'agency name not rendered on the poster');
  assert.ok(!hostile.includes('<svg onload='), 'no raw SVG injection from agency input');
  assert.equal(plain, buildCardSvg(base), 'card remains deterministic');
});

test('card: branded scan -> GET /card returns a real 1600x900 PNG (agency ignored)', async () => {
  const created = await (await post(api.base, { url: 'https://example.com/', branding: AGENCY })).json();
  const res = await fetch(`${api.base}/api/v1/scans/${created.id}/card`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/png/);
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic');
  assert.ok(png.length > 20_000, 'card is a real rendered image');
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 900);
  // The poster rasterizes fine even with agency input present (ignored).
  const svg = buildCardSvg({ score: created.score, url: created.url, agencyName: AGENCY.agencyName });
  assert.ok(!svg.includes('Acme'), 'agency name never reaches the poster SVG');
  const out = await renderCardPng(svg);
  assert.ok(Buffer.isBuffer(out) && out.length > 20_000);
});