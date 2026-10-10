import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { FetchError } from '../src/fetch/client.js';
import { createReportToken } from '../src/paywall.js';
import { verdictLabel } from '../src/verdict.js';

// ---------------------------------------------------------------------------
// Admin "Generate Share Card" tool (owner request 2026-10-01).
// Conventions mirrored from adminStats.test.js / api.test.js: tmp DB per test,
// injectable clocks, real HTTP against a local listen(0), fake fetcher with no
// DNS (offline validateTarget), fixed paywall secret so tests can mint VALID
// report tokens (createReportToken) for the internal-row 404 proof.
// ---------------------------------------------------------------------------
delete process.env.ADMIN_PASSWORD; // unset => every admin route 403, deterministic

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-admin-card-')), 'test.db');
const PASSWORD = 'hunter2-secret-key';
const TOKEN_SECRET = 'admin-share-card-test-secret';
const TICK = '2026-09-23T12:00:00.000Z'; // an injected "now" (UTC, app convention)

// Deterministic slop fixture: generic marketing filler -> a real nonzero score.
const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

// Fake fetcher: lets the pipeline run without touching the network. Discovery
// finds no <a> links in SLOP_HTML, so the scan is one page + deterministic.
const fakeFetcher = (html = SLOP_HTML) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});
// Transport-level failure (for the 502 fetch_failed mapping).
const throwingFetcher = {
  fetchHtml: async () => { throw new FetchError('connection refused'); },
};
// Route-level SSRF guard, DNS-skipping variant (same convention as
// api.test.js): the fake fetcher owns all network behavior, so the guard must
// reject blocked shapes without resolving hostnames. A private-IP literal is
// rejected by validateUrl itself (blocked range check).
const offlineValidateTarget = async (raw) => validateUrl(raw);

const rawDb = (dbPath) => new Database(dbPath, { readonly: true });
const countRows = (dbPath, table) => rawDb(dbPath).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function startApp(opts = {}) {
  const app = createApp({
    adminPassword: PASSWORD,
    reportTokenSecret: TOKEN_SECRET,
    fetcher: fakeFetcher(),
    validateTarget: offlineValidateTarget,
    scanBudgetMs: 2000,
    now: () => TICK,
    ...opts,
  });
  const server = app.listen(0); // no-host form: address() is available synchronously
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** POST /admin/share-card exactly like the HTML form would (urlencoded body). */
const adminScan = (base, { url = 'https://example.com/', accept, headers = {} } = {}) => {
  const h = { 'content-type': 'application/x-www-form-urlencoded', ...headers };
  if (accept) h.accept = accept;
  return fetch(`${base}/admin/share-card`, { method: 'POST', headers: h, body: `url=${encodeURIComponent(url)}` });
};

/** Run one admin scan (header auth) and return its scan id from the result page. */
async function adminScanId(base) {
  const r = await adminScan(base, { accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
  assert.equal(r.status, 200);
  const html = await r.text();
  const m = html.match(/\/admin\/share-card\/([0-9a-f-]+)\/card/);
  assert.ok(m, 'result page references the gated card route');
  return m[1];
}

// ---------------------------------------------------------------------------
// 1. Gate — missing/wrong password is ALWAYS a 403 JSON, never HTML
// ---------------------------------------------------------------------------
test('admin share-card: GET form, POST and card route 403 JSON with missing/wrong password (never HTML)', async () => {
  const app = startApp({ dbPath: tmpDb() });
  try {
    // GET form: no pw / wrong header / wrong query / HTML accept — all JSON 403.
    for (const r of [
      await fetch(`${app.base}/admin/share-card`),
      await fetch(`${app.base}/admin/share-card`, { headers: { 'x-admin-password': 'wrong' } }),
      await fetch(`${app.base}/admin/share-card?pw=${encodeURIComponent('wrong')}`),
      await fetch(`${app.base}/admin/share-card`, { headers: { accept: 'text/html' } }),
    ]) {
      assert.equal(r.status, 403);
      assert.ok(!(r.headers.get('content-type') || '').includes('text/html'), '403 is never HTML');
      assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
    }
    // POST: no pw / wrong header — JSON 403 even with HTML accept.
    for (const headers of [{ accept: 'text/html' }, { accept: 'text/html', 'x-admin-password': 'wrong' }]) {
      const r = await adminScan(app.base, { headers });
      assert.equal(r.status, 403);
      assert.ok(!(r.headers.get('content-type') || '').includes('text/html'), '403 is never HTML');
      assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
    }
    // Card route: no pw / wrong pw — JSON 403 (a scan id that does not exist must
    // still be gated BEFORE the lookup, so the gate is observable either way).
    const r = await fetch(`${app.base}/admin/share-card/no-such-scan/card`);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
    const rw = await fetch(`${app.base}/admin/share-card/no-such-scan/card`, { headers: { 'x-admin-password': 'wrong' } });
    assert.equal(rw.status, 403);
    assert.deepEqual(await rw.json(), { error: { code: 'forbidden' } });
  } finally {
    app.server.close();
  }
});
test('admin share-card: routes are disabled (403 JSON) while ADMIN_PASSWORD is unset', async () => {
  const app = createApp({ dbPath: tmpDb(), now: () => TICK });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    for (const target of [
      `/admin/share-card`,
      `/admin/share-card/no-such-scan/card`,
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${target}`, { headers: { accept: 'text/html' } });
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
    }
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Valid URL — full scan, internal row, audit trail, NO public counter moves
// ---------------------------------------------------------------------------
test('admin share-card: HTML result shows score + verdict + card + download; row internal; audit written; no counters move', async () => {
  const dbp = tmpDb();
  // One PUBLIC fixture scan beforehand — the counts must keep counting it and
  // exclude the admin scan (requirement #4).
  const seedDb = openDb(dbp);
  seedDb.insertScan({ id: 'public-1', url: 'https://acme.example/', score: 42, breakdown: {}, createdAt: TICK });
  seedDb.close();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'), 'browser form gets HTML');
    const html = await r.text();
    const scanId = html.match(/\/admin\/share-card\/([0-9a-f-]+)\/card/)[1];

    const db = openDb(dbp);
    const scan = db.getScan(scanId);
    assert.ok(scan, 'admin scan row persisted');
    assert.equal(scan.internal, true, 'admin row marked internal');
    assert.equal(scan.url, 'https://example.com/', 'the fetcher\'s page.url is stored');
    // Score + verdict rendered on the result page (band-colored number + label).
    assert.ok(html.includes(String(scan.score)), `score ${scan.score} rendered`);
    assert.ok(html.includes(verdictLabel(scan.score)), `verdict label ${verdictLabel(scan.score)} rendered`);

    // Audit row: who (admin), when, what URL, resulting score + verdict.
    const audit = db.raw.prepare('SELECT * FROM admin_audit').all();
    assert.equal(audit.length, 1, 'exactly one audit row');
    assert.equal(audit[0].actor, 'admin');
    assert.equal(audit[0].scan_id, scanId);
    assert.equal(audit[0].url, 'https://example.com/');
    assert.equal(audit[0].score, scan.score);
    assert.equal(audit[0].verdict, verdictLabel(scan.score));
    assert.match(audit[0].ip, /127\.0\.0\.1$/, 'req.ip recorded');
    assert.equal(audit[0].created_at, TICK, 'audit timestamp = injected clock');

    // scan_events ledger has NO row for the admin scan (the tool never POSTs
    // /api/v1/scan — requirement #4).
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM scan_events').get().n, 0, 'admin scan leaves no scan_events row');

    // Admin-stats counts exclude the admin row but still count the public one.
    assert.equal(db.countScansTotal(), 1, 'total excludes admin scan');
    assert.equal(db.countScansToday(TICK.slice(0, 10)), 1, 'today excludes admin scan');
    const days = db.scanDayCounts('2020-01-01');
    assert.equal(days.length, 1, 'day series has exactly the public row bucket');
    assert.equal(days[0].count, 1);

    // page_views untouched — no beacon was ever fired.
    assert.equal(db.countPageViews(), 0, 'page_views unchanged');
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM page_views').get().n, 0);
    db.close();
  } finally {
    app.server.close();
  }
});
test('admin share-card: result page embeds the card image + Download button with the download attribute', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    const m = html.match(/\/admin\/share-card\/([0-9a-f-]+)\/card/);
    assert.ok(m, 'result page references the gated card route');
    const scanId = m[1];
    // The img tag points at the gated card route, carrying ?pw= so the
    // browser's headerless <img> fetch passes the card route's gate (the
    // POST was header-authenticated, so candidate = PASSWORD).
    assert.ok(html.includes(`src="/admin/share-card/${scanId}/card?pw=${encodeURIComponent(PASSWORD)}"`), 'card <img> present with ?pw= embedded');
    assert.ok(html.includes('alt="A.S.S. Score share card for example.com"'), 'card alt text');
    // The Download button mirrors the site semantics: rc-ghost class + anchor
    // with the download attribute naming ass-score-<domainSlug>.png. The href
    // may carry the optional ?pw= query after /card.
    const dl = html.match(/<a class="rc-ghost" href="\/admin\/share-card\/[^"]+\/card(?:\?pw=[^"]*)?" download="([^"]+)">Download Share Card<\/a>/);
    assert.ok(dl, 'Download Share Card anchor with download attribute present');
    assert.equal(dl[1], 'ass-score-example-com.png', 'download filename = ass-score-<host slug>.png');
  } finally {
    app.server.close();
  }
});
test('admin share-card: browser flow end-to-end (owner-reported bug) — ?pw= POST embeds the auth in the card URL and the headerless <img> fetch succeeds with image/png bytes', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    // The exact reported flow: open /admin/share-card?pw=… in a browser; the
    // form action carries ?pw=, and the POST carries NO x-admin-password
    // header (browsers cannot set it). Here candidate = req.query.pw.
    const r = await fetch(`${app.base}/admin/share-card?pw=${encodeURIComponent(PASSWORD)}`, {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent('https://example.com/')}`,
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    const src = html.match(/<img class="card-img" src="([^"]+)"/);
    assert.ok(src, 'card <img> with src present');
    const scanId = src[1].match(/\/([0-9a-f-]+)\/card\?/)[1];
    assert.equal(src[1], `/admin/share-card/${scanId}/card?pw=${encodeURIComponent(PASSWORD)}`, 'src carries ?pw= so the headerless browser fetch passes the gate');
    // Fetch EXACTLY what the browser <img> would: the src URL, no custom
    // headers — this is the request that used to 403 into a broken image box.
    const img = await fetch(new URL(src[1], app.base).href);
    assert.equal(img.status, 200);
    assert.ok((img.headers.get('content-type') || '').includes('image/png'), 'card served as image/png');
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic bytes');
    assert.ok(bytes.length > 20_000, `real rendered PNG (${bytes.length} bytes)`);
    // Download button reuses the SAME working URL (single cardPath).
    assert.ok(html.includes(`href="${src[1]}" download=`), 'download href = the same ?pw= card URL');
  } finally {
    app.server.close();
  }
});
test('admin share-card: "Generate another" carries ?pw= on the result page (query-auth POST, owner-reported bug), and the link actually works while the gate stays intact', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    // The exact reported flow: open /admin/share-card?pw=… in a browser; the
    // POST carries NO x-admin-password header (browsers cannot set it), so
    // candidate = req.query.pw. The result page's "Generate another" link
    // must carry the same ?pw= (it used to be hardcoded to /admin/share-card,
    // which dropped the auth and 403'd the GET form — the owner's bug).
    const r = await fetch(`${app.base}/admin/share-card?pw=${encodeURIComponent(PASSWORD)}`, {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent('https://example.com/')}`,
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    const again = `<a class="again" href="/admin/share-card?pw=${encodeURIComponent(PASSWORD)}">← Generate another</a>`;
    assert.ok(html.includes(again), 'result page has the exact Generate-another link with ?pw=');
    assert.ok(!html.includes('<a class="again" href="/admin/share-card">'), 'the old hardcoded auth-less link is gone');

    // The link is functional: follow it exactly like the browser would (GET,
    // no custom headers) and the pw-carrying form renders (not a 403).
    const viaLink = await fetch(new URL(`/admin/share-card?pw=${encodeURIComponent(PASSWORD)}`, app.base).href, {
      headers: { accept: 'text/html' },
    });
    assert.equal(viaLink.status, 200);
    assert.ok((await viaLink.text()).includes('Generate Share Card'), 'following the link lands on the pw-carrying form');

    // Gate unchanged: a bare GET with no auth still 403s JSON.
    const bare = await fetch(`${app.base}/admin/share-card`, { headers: { accept: 'text/html' } });
    assert.equal(bare.status, 403);
    assert.deepEqual(await bare.json(), { error: { code: 'forbidden' } });
  } finally {
    app.server.close();
  }
});
test('admin share-card: "Generate another" mirrors cardPath — header-authenticated POST (no query) still embeds the password in ?pw=', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    // Header auth, no query: candidate = the x-admin-password header value,
    // so the again href must carry THAT value in ?pw= (exactly like the card
    // <img>/Download cardPath already does). Without it, the browser's plain
    // navigation would 403 on the GET form.
    const r = await adminScan(app.base, { accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(`<a class="again" href="/admin/share-card?pw=${encodeURIComponent(PASSWORD)}">← Generate another</a>`), 'again href carries the header value in ?pw=, mirroring cardPath');
    assert.ok(!html.includes('<a class="again" href="/admin/share-card">'), 'no auth-less hardcoded link');
  } finally {
    app.server.close();
  }
});
test('admin share-card: the card URL WITHOUT any auth still 403s (gate intact) and succeeds with only ?pw=', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanId = await adminScanId(app.base);
    // No header, no query — the gate must still reject; the fix must not
    // have weakened the card route's auth.
    const bare = await fetch(`${app.base}/admin/share-card/${scanId}/card`);
    assert.equal(bare.status, 403);
    assert.deepEqual(await bare.json(), { error: { code: 'forbidden' } });
    // The exact browser request (query only, no header) succeeds.
    const viaQuery = await fetch(`${app.base}/admin/share-card/${scanId}/card?pw=${encodeURIComponent(PASSWORD)}`);
    assert.equal(viaQuery.status, 200);
    assert.ok((viaQuery.headers.get('content-type') || '').includes('image/png'));
  } finally {
    app.server.close();
  }
});
test('admin share-card: download filename strips www. and joins with dashes (mirrors site domainSlug)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { url: 'https://www.example.com/', accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    const html = await r.text();
    const dl = html.match(/download="([^"]+)"/);
    assert.ok(dl, 'download attribute present');
    assert.equal(dl[1], 'ass-score-example-com.png', 'leading www. dropped, dots -> dashes');
  } finally {
    app.server.close();
  }
});
test('admin share-card: JSON accept returns { scanId, url, score, verdict } with no card URL', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { url: 'https://www.example.com/', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('application/json'), 'API-style accept keeps JSON');
    const json = await r.json();
    assert.deepEqual(Object.keys(json).sort(), ['scanId', 'score', 'url', 'verdict']);
    assert.equal(json.url, 'https://www.example.com/');
    assert.ok(Number.isInteger(json.score) && json.score >= 0 && json.score <= 100);
    assert.equal(json.verdict, verdictLabel(json.score));
    assert.ok(!('cardUrl' in json), 'no card URL on the JSON shape (admin-only surface)');
    // row is internal + audited here too (same code path, just different accept)
    const db = openDb(dbp);
    assert.equal(db.getScan(json.scanId).internal, true);
    const audit = db.raw.prepare('SELECT * FROM admin_audit').all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].score, json.score);
    db.close();
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Invalid/blocked target — mapped 4xx, NO scan row, NO audit row
// ---------------------------------------------------------------------------
test('admin share-card: blocked target (private-IP literal) -> 400 blocked, no scan/audit rows', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { url: 'http://127.0.0.1/', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.code, 'blocked');
    assert.match(json.error.message, /blocked/i, 'guard message surfaces');
    // HTML accept re-renders the form with the error inline (still 4xx).
    const rh = await adminScan(app.base, { url: 'http://127.0.0.1/', accept: 'text/html', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(rh.status, 400);
    const html = await rh.text();
    assert.ok(html.includes('Generate Share Card'), 'form re-rendered');
    assert.ok(html.includes('blocked') || html.includes('not allowed'), 'inline error present');
    // NO scan row, NO audit row.
    assert.equal(countRows(dbp, 'scans'), 0, 'blocked target persists nothing');
    assert.equal(countRows(dbp, 'admin_audit'), 0);
  } finally {
    app.server.close();
  }
});
test('admin share-card: malformed URL -> 400 (invalid_request shape is JSON for API accept)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await adminScan(app.base, { url: 'not a url', headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.ok(['blocked', 'invalid_request'].includes(json.error.code), `code ${json.error.code}`);
    assert.equal(countRows(dbp, 'scans'), 0);
    assert.equal(countRows(dbp, 'admin_audit'), 0);
  } finally {
    app.server.close();
  }
});
test('admin share-card: fetch failure maps to 502 fetch_failed with no rows', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, fetcher: throwingFetcher });
  try {
    const r = await adminScan(app.base, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 502);
    const json = await r.json();
    assert.equal(json.error.code, 'fetch_failed');
    assert.equal(countRows(dbp, 'scans'), 0, 'failed scan persists nothing');
    assert.equal(countRows(dbp, 'admin_audit'), 0);
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Internal rows 404 on ALL public read surfaces (valid token included)
// ---------------------------------------------------------------------------
test('admin share-card: internal row 404s on all five public surfaces, even with a VALID report token', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanId = await adminScanId(app.base);
    const token = createReportToken(TOKEN_SECRET, scanId);
    const notFound = { error: { code: 'not_found', message: `No scan found with id "${scanId}"` } };

    // GET /api/v1/scans/:id — JSON and HTML accept both 404 JSON (the current
    // missing-id branch is always JSON).
    for (const headers of [{}, { accept: 'text/html' }]) {
      const r = await fetch(`${app.base}/api/v1/scans/${scanId}`, { headers });
      assert.equal(r.status, 404, `scans/:id ${JSON.stringify(headers)}`);
      assert.deepEqual(await r.json(), notFound);
    }
    // ...including with a VALID token (guard BEFORE the hasValidToken branch).
    const withToken = await fetch(`${app.base}/api/v1/scans/${scanId}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
    assert.equal(withToken.status, 404, 'valid token on internal row is still 404, never the report');
    assert.deepEqual(await withToken.json(), notFound);

    // GET /api/v1/report/:id — the one surface that would otherwise 403/200
    // with a VALID token: must be 404, never 403, never 200.
    const report = await fetch(`${app.base}/api/v1/report/${scanId}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
    assert.equal(report.status, 404, 'token\'d report route treats internal rows as missing');
    assert.deepEqual(await report.json(), notFound);
    const reportPlain = await fetch(`${app.base}/api/v1/report/${scanId}`);
    assert.equal(reportPlain.status, 404);
    assert.deepEqual(await reportPlain.json(), notFound);

    // GET /report/:id alias.
    const alias = await fetch(`${app.base}/report/${scanId}`, { headers: { accept: 'text/html' } });
    assert.equal(alias.status, 404);
    assert.deepEqual(await alias.json(), notFound);

    // GET /api/v1/scans/:id/card.
    const card = await fetch(`${app.base}/api/v1/scans/${scanId}/card`);
    assert.equal(card.status, 404);
    assert.deepEqual(await card.json(), notFound);

    // GET /api/v1/scans/:id/share.
    const share = await fetch(`${app.base}/api/v1/scans/${scanId}/share`);
    assert.equal(share.status, 404);
    assert.deepEqual(await share.json(), notFound);

    // The admin-gated card route still works (the tool itself is unaffected).
    const gated = await fetch(`${app.base}/admin/share-card/${scanId}/card`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(gated.status, 200);
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Public regression — normal scans keep counting + serving on every surface
// ---------------------------------------------------------------------------
test('admin share-card: public scans still count in the three queries, 200 on all five surfaces, ledger untouched', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanRes = await fetch(`${app.base}/api/v1/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    assert.equal(scanRes.status, 200, 'public scan unaffected by the internal flag');
    const { id } = await scanRes.json();

    const db = openDb(dbp);
    // Counts include the public row.
    assert.equal(db.countScansTotal(), 1);
    assert.equal(db.countScansToday(TICK.slice(0, 10)), 1);
    assert.equal(db.scanDayCounts('2020-01-01').length, 1);
    // scan_events ledger has the completed public scan (rate-limit path intact).
    const event = db.raw.prepare('SELECT * FROM scan_events WHERE scan_id = ?').get(id);
    assert.ok(event, 'public scan ledgered in scan_events');
    assert.equal(event.status, 'completed');
    assert.equal(db.getScan(id).internal, false, 'public rows are NOT internal');

    // All five public surfaces serve the public row.
    const token = createReportToken(TOKEN_SECRET, id);
    const s = await fetch(`${app.base}/api/v1/scans/${id}`);
    assert.equal(s.status, 200);
    const sh = await fetch(`${app.base}/api/v1/scans/${id}`, { headers: { accept: 'text/html' } });
    assert.equal(sh.status, 200);
    const rep = await fetch(`${app.base}/api/v1/report/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
    assert.equal(rep.status, 200, 'paid report path unchanged for public rows');
    const alias = await fetch(`${app.base}/report/${id}`, { headers: { accept: 'text/html' } });
    assert.equal(alias.status, 200);
    const card = await fetch(`${app.base}/api/v1/scans/${id}/card`);
    assert.equal(card.status, 200);
    assert.ok((card.headers.get('content-type') || '').includes('image/png'));
    const cardBytes = Buffer.from(await card.arrayBuffer());
    assert.ok(cardBytes.length > 5000, 'public card PNG renders');
    const share = await fetch(`${app.base}/api/v1/scans/${id}/share`);
    assert.equal(share.status, 200);
    const shareJson = await share.json();
    assert.ok(shareJson.url.includes(id));
    db.close();
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Card determinism — same admin scan -> identical PNG bytes
// ---------------------------------------------------------------------------
test('admin share-card: gated card route renders identical PNG bytes for the same scan', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanId = await adminScanId(app.base);
    const fetchCard = () => fetch(`${app.base}/admin/share-card/${scanId}/card`, { headers: { 'x-admin-password': PASSWORD } });
    const a = await fetchCard();
    const b = await fetchCard();
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok((a.headers.get('content-type') || '').includes('image/png'));
    assert.equal(a.headers.get('cache-control'), 'private, max-age=300', 'admin card cache is private');
    const bufA = Buffer.from(await a.arrayBuffer());
    const bufB = Buffer.from(await b.arrayBuffer());
    assert.ok(bufA.length > 5000, 'card PNG has real bytes');
    assert.deepEqual(bufA, bufB, 'deterministic: identical bytes');
  } finally {
    app.server.close();
  }
});
test('admin share-card: gated card route 404s (JSON) for a scan id that does not exist', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const r = await fetch(`${app.base}/admin/share-card/no-such-scan/card`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: { code: 'not_found', message: 'No scan found with id "no-such-scan"' } });
  } finally {
    app.server.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Download button semantics (mirrors the site's downloadCard + rc-ghost)
// ---------------------------------------------------------------------------
test('admin share-card: the form page renders with noindex, the URL input and the Generate button', async () => {
  const app = startApp({ dbPath: tmpDb() });
  try {
    const r = await fetch(`${app.base}/admin/share-card`, { headers: { accept: 'text/html', 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store', 'admin pages are never cached');
    const html = await r.text();
    assert.ok(html.includes('noindex, nofollow'), 'noindex meta present');
    assert.ok(html.includes('Generate Share Card'), 'heading present');
    assert.ok(html.includes('name="url"'), 'URL input present');
    assert.ok(html.includes('>Generate</button>'), 'Generate submit present');
    assert.ok(html.match(/~30 seconds/), 'scan duration note present');
    // ?pw= auth embeds the password into the form action so the browser form works.
    const rq = await fetch(`${app.base}/admin/share-card?pw=${encodeURIComponent(PASSWORD)}`, { headers: { accept: 'text/html' } });
    assert.equal(rq.status, 200);
    const htmlq = await rq.text();
    assert.ok(htmlq.includes(`action="/admin/share-card?pw=${encodeURIComponent(PASSWORD)}"`), 'form action carries ?pw=');
    assert.ok(!htmlq.includes('No password embedded'), 'pw-carrying form skips the header-only hint');
  } finally {
    app.server.close();
  }
});// ---------------------------------------------------------------------------
// 8. Admin full report (owner request 2026-10-07) — GET /admin/report/:scanId
// ---------------------------------------------------------------------------
test('admin report: gate — no/wrong auth on GET /admin/report/:scanId is 403 JSON (real internal id AND junk id)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanId = await adminScanId(app.base); // a REAL internal row exists
    // Gate runs BEFORE the row lookup: bare and wrong-auth requests 403 JSON
    // for the real id and a junk id alike (never HTML, never an oracle).
    for (const id of [scanId, 'no-such-scan']) {
      const bare = await fetch(`${app.base}/admin/report/${id}`, { headers: { accept: 'text/html' } });
      assert.equal(bare.status, 403);
      assert.ok(!(bare.headers.get('content-type') || '').includes('text/html'), '403 is never HTML');
      assert.deepEqual(await bare.json(), { error: { code: 'forbidden' } });
      const wrong = await fetch(`${app.base}/admin/report/${id}`, { headers: { accept: 'text/html', 'x-admin-password': 'wrong' } });
      assert.equal(wrong.status, 403);
      assert.deepEqual(await wrong.json(), { error: { code: 'forbidden' } });
    }
  } finally {
    app.server.close();
  }
});
test('admin report: disabled (403 JSON) while ADMIN_PASSWORD is unset', async () => {
  const app = createApp({ dbPath: tmpDb(), now: () => TICK });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/admin/report/whatever`, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: { code: 'forbidden' } });
  } finally {
    server.close();
  }
});
test('admin report: share-card result page links "View full report" with ?pw=, and the link serves the FULL report (three layers, not the share-card page)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    // Generate a scorecard exactly like the owner does (?pw= browser flow —
    // POST carries NO x-admin-password header, candidate = req.query.pw).
    const r = await fetch(`${app.base}/admin/share-card?pw=${encodeURIComponent(PASSWORD)}`, {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent('https://example.com/')}`,
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    const scanId = html.match(/\/admin\/share-card\/([0-9a-f-]+)\/card/)[1];
    // The new owner entry point: rc-ghost "View full report" next to the
    // Download button, carrying the auth exactly like cardPath/againHref.
    const link = `<a class="rc-ghost" href="/admin/report/${scanId}?pw=${encodeURIComponent(PASSWORD)}">View full report</a>`;
    assert.ok(html.includes(link), 'result page has the exact View-full-report link with ?pw=');
    assert.ok(!html.includes(`href="/admin/report/${scanId}">`), 'no auth-less report link emitted');
    // rc-ghost styling is reused (same class the Download button uses).
    assert.equal((html.match(/class="rc-ghost"/g) ?? []).length, 2, 'Download + View full report both rc-ghost');
    // Follow the link exactly like the browser would (GET, no custom headers):
    // the FULL report renders — NO token needed, NO 30-day gate.
    const viaLink = await fetch(new URL(`/admin/report/${scanId}?pw=${encodeURIComponent(PASSWORD)}`, app.base).href, {
      headers: { accept: 'text/html' },
    });
    assert.equal(viaLink.status, 200);
    assert.ok((viaLink.headers.get('content-type') || '').includes('text/html'), 'report served as HTML');
    assert.equal(viaLink.headers.get('cache-control'), 'no-store', 'admin report is never cached');
    const report = await viaLink.text();
    // Core full-report sections (owner reorder 2026-10-10 — the same sequence
    // the paid report asserts: breakdown → fix → working → findings →
    // final → methodology).
    for (const marker of ['Your Breakdown', 'What To Fix First',
      "What's Working", '<div class="cat-sources" hidden>', 'Final Verdict', 'Methodology']) {
      assert.ok(report.includes(marker), `full report contains ${marker}`);
    }
    // Three-layer finding structure: THE ROAST / WHY IT MATTERS / HOW TO FIX
    // IT layers with receipts (the slop fixture produces real findings).
    assert.ok(report.includes('How to fix it:'), 'HOW TO FIX IT label present');
    assert.ok((report.match(/<p class="ins-roast">/g) ?? []).length >= 1, 'at least one THE ROAST layer');
    assert.ok((report.match(/class="ins-why"/g) ?? []).length >= 1, 'WHY IT MATTERS layer present');
    assert.ok((report.match(/class="ins-fix"/g) ?? []).length >= 1, 'HOW TO FIX IT layer present');
    // It is the REPORT page, NOT the share-card result page.
    assert.ok(!report.includes('Share card generated'), 'not the share-card result page');
    assert.ok(!report.includes('class="card-img"'), 'no share-card image markup in the report');
    // No token, no expiry: the paid-report gate does not apply here (the
    // admin route never looks at ?token — a report even renders for a scan
    // whose created_at is far outside the 30-day buyer window).
    const db = openDb(dbp);
    db.raw.prepare('UPDATE scans SET created_at = ? WHERE id = ?').run('2025-01-01T00:00:00.000Z', scanId);
    const viaLinkStale = await fetch(new URL(`/admin/report/${scanId}?pw=${encodeURIComponent(PASSWORD)}`, app.base).href);
    assert.equal(viaLinkStale.status, 200, 'admin report has no 30-day access window');
    assert.ok((await viaLinkStale.text()).includes('Your Breakdown'));
    db.close();
  } finally {
    app.server.close();
  }
});
test('admin report: a scan that is NOT internal (plain public scan) is 404 JSON — never rendered on the admin surface', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const scanRes = await fetch(`${app.base}/api/v1/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    assert.equal(scanRes.status, 200);
    const { id } = await scanRes.json();
    const db = openDb(dbp);
    assert.equal(db.getScan(id).internal, false, 'public rows are NOT internal');
    db.close();
    const r = await fetch(`${app.base}/admin/report/${id}`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: { code: 'not_found', message: `No scan found with id "${id}"` } });
    // header-auth AND ?pw= behave the same (the branch is the same 404).
    const rq = await fetch(`${app.base}/admin/report/${id}?pw=${encodeURIComponent(PASSWORD)}`);
    assert.equal(rq.status, 404);
    assert.deepEqual(await rq.json(), { error: { code: 'not_found', message: `No scan found with id "${id}"` } });
  } finally {
    app.server.close();
  }
});
test('admin report: missing scan id is 404 JSON; internal row still 404s on the paid route even with a valid token (no access-model leak)', async () => {
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp });
  try {
    const missing = await fetch(`${app.base}/admin/report/no-such-scan`, { headers: { 'x-admin-password': PASSWORD } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'No scan found with id "no-such-scan"' } });
    // The admin-created row serves on /admin/report/... but remains invisible
    // to the PUBLIC token'd report route (valid token included) — the two
    // access models do not bleed into each other.
    const scanId = await adminScanId(app.base);
    const token = createReportToken(TOKEN_SECRET, scanId);
    const pub = await fetch(`${app.base}/api/v1/report/${scanId}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
    assert.equal(pub.status, 404, 'internal row still hole-shaped on the public paid route');
    assert.deepEqual(await pub.json(), { error: { code: 'not_found', message: `No scan found with id "${scanId}"` } });
  } finally {
    app.server.close();
  }
});
