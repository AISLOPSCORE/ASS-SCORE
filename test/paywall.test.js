import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createEmailSender } from '../src/email.js';
import {
  buildFreePayload,
  pickTeasers,
  createReportToken,
  verifyReportToken,
  buildReportUrl,
  DISCLAIMER,
} from '../src/paywall.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-paywall-')), 'test.db');

const SLOP_HTML = `<!doctype html><html><head><title>Test</title></head><body>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy to unlock the potential of seamless experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the landscape. Furthermore, we are committed to leveraging robust synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

const fakeFetcher = (html = SLOP_HTML) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

const offlineValidateTarget = async (raw) => validateUrl(raw);

const TOKEN_SECRET = 'paywall-test-secret';
const PUBLIC_BASE = 'https://ass-score.com';

function startApp(opts = {}) {
  const app = createApp({
    validateTarget: offlineValidateTarget,
    reportTokenSecret: TOKEN_SECRET,
    publicBaseUrl: PUBLIC_BASE,
    ...opts,
  });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const postScan = (base, body = {}) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/', ...body }),
  });

const getJson = (base, id, qs = '') => fetch(`${base}/api/v1/scans/${id}${qs}`, { headers: { accept: 'application/json' } });
const getHtml = (base, id, qs = '') => fetch(`${base}/api/v1/scans/${id}${qs}`, { headers: { accept: 'text/html' } });
const getReport = (base, id, qs = '') => fetch(`${base}/api/v1/report/${id}${qs}`, { headers: { accept: 'text/html' } });

/** Recursively collect every object key in a JSON tree. */
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { out.add(k); allKeys(v[k], out); }
  }
  return out;
}

const PAID_KEYS = ['findings', 'insights', 'hits', 'pairs', 'pages', 'worstPage', 'branding'];

// ------------------------------------------------------------------ fixtures

let api;
let apiDb;

before(() => {
  apiDb = tmpDb();
  // maxScansPerDay raised: this suite scans repeatedly against the shared app.
  api = startApp({ dbPath: apiDb, fetcher: fakeFetcher(), maxScansPerDay: 100 });
});

after(() => {
  api.server.close();
});

// ------------------------------------------------------------------ (a) free shape

test('FREE contract: POST /scan and GET /scans/:id JSON expose teasers + numbers ONLY (no full findings)', async () => {
  const res = await postScan(api.base);
  assert.equal(res.status, 200);
  const json = await res.json();

  // Identity + score surface.
  for (const key of ['id', 'url', 'score', 'verdict', 'roast', 'createdAt', 'disclaimer']) {
    assert.ok(key in json, `free payload carries ${key}`);
  }
  assert.equal(json.disclaimer, DISCLAIMER, 'mandated disclaimer verbatim');

  // Breakdown: per-category NUMBERS (+note for skipped modules) only.
  for (const [key, entry] of Object.entries(json.breakdown)) {
    assert.ok('score' in entry, `breakdown.${key}.score`);
    assert.ok(!('findings' in entry) && !('insights' in entry) && !('hits' in entry),
      `breakdown.${key} has no paid arrays`);
  }

  // NO paid-side analysis anywhere in the free tree (deep walk).
  const keys = allKeys(json);
  for (const paid of PAID_KEYS) {
    assert.ok(!keys.has(paid), `free payload never contains "${paid}" (deep walk)`);
  }

  // Teasers: 1-2 samples, each in the full three-layer format with a receipt.
  assert.ok(Array.isArray(json.teasers) && json.teasers.length >= 1 && json.teasers.length <= 2, '1-2 teasers');
  for (const t of json.teasers) {
    assert.equal(typeof t.key, 'string');
    assert.ok(t.roast.length > 0, 'teaser roast layer');
    assert.ok(t.why.length > 0, 'teaser why layer');
    assert.ok(t.fix.length > 0, 'teaser fix layer');
    assert.ok(t.evidence.length > 0, 'teaser evidence/receipt layer');
  }

  // GET JSON is the same gated shape (and stable for the same id).
  const gotRes = await getJson(api.base, json.id);
  assert.equal(gotRes.status, 200);
  const got = await gotRes.json();
  assert.deepEqual(got.teasers, json.teasers, 'teasers stable across surfaces for the same scan id');
  assert.deepEqual(got.breakdown, json.breakdown, 'numeric breakdown stable');
  assert.ok(!allKeys(got).has('findings'), 'GET JSON has no findings either');

  // Free HTML teaser page: score + samples + CTA, never the paid sections.
  const freeHtml = await (await getHtml(api.base, json.id)).text();
  assert.ok(freeHtml.includes('A.S.S. Score: '), 'free page headline');
  assert.ok(freeHtml.includes('Free samples'), 'free page teaser block');
  assert.ok(freeHtml.includes('Unlock the full report — $12'), 'free page $12 CTA');
  assert.ok(freeHtml.includes(DISCLAIMER), 'free page disclaimer');
  assert.ok(!freeHtml.includes('The Actual Findings'), 'free page never renders the paid findings section');
});

// ------------------------------------------------------------------ (b) token -> full report

test('PAID contract: valid token on /scans/:id returns the full narrative report (all sections, verbatim disclaimer)', async () => {
  const created = await (await postScan(api.base)).json();
  const token = createReportToken(TOKEN_SECRET, created.id);

  const res = await getHtml(api.base, created.id, `?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  for (const section of ['The Verdict', "What's Working", 'Your Breakdown', 'The Actual Findings',
    'Page That Needs The Most Work', 'What To Fix First', 'Final Verdict', 'Methodology']) {
    assert.ok(html.includes(section), `paid report has ${section}`);
  }
  assert.ok(html.includes(DISCLAIMER), 'paid report carries the mandated disclaimer verbatim');
  assert.ok(html.includes(`A.S.S. Score: ${created.score} / 100`), 'paid report headline score');
});

// ------------------------------------------------------------------ (c) report route 403s

test('PAID contract: /api/v1/report/:id without a token = 403 (never the free page); valid token = 200', async () => {
  const created = await (await postScan(api.base)).json();
  const token = createReportToken(TOKEN_SECRET, created.id);

  // No token: 403 even when the client prefers HTML — never a free result.
  const noToken = await getReport(api.base, created.id);
  assert.equal(noToken.status, 403, 'no token -> 403');
  assert.ok(!(await noToken.text()).includes('A.S.S. Score:'), '403 body is NOT the free result page');

  // Garbage token: 403.
  const badToken = await getReport(api.base, created.id, '?token=v1.0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(badToken.status, 403, 'invalid token -> 403');

  // A supplied-but-invalid token on the FREE scans route is also a 403 —
  // it never degrades to the free page (that would hand the probe a 200).
  const scanRoute = await getHtml(api.base, created.id, '?token=v1.0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(scanRoute.status, 403, 'invalid token on /scans/:id -> 403');

  // Valid token: 200 full report.
  const ok = await getReport(api.base, created.id, `?token=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes('The Verdict'));
});

// ------------------------------------------------- report access window (30d)
// Owner-approved preserve-data/expire-access: the token'd report link expires
// 30 days after scan.created_at (src/ttl.js) — a VALID token on an older scan
// is a 410 report_expired. Missing scan -> 404 and missing/invalid token ->
// 403 stay unchanged and take precedence (a 410 must only be reachable by a
// valid-token holder). The FREE routes are not gated (free by construction).

test('report access window: valid token on a 29-day-old scan -> 200 HTML; 31-day-old scan -> 410 report_expired', async () => {
  const NOW = '2026-09-23T12:00:00.000Z';
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => NOW });
  try {
    const db = openDb(dbp);
    const youngId = 'scan-29d';
    const oldId = 'scan-31d';
    // 29 days before NOW (inside the window) and 31 days before NOW (past it).
    db.insertScan({ id: youngId, url: 'https://young.example/', score: 42, breakdown: {}, createdAt: '2026-08-25T12:00:00.000Z' });
    db.insertScan({ id: oldId, url: 'https://old.example/', score: 42, breakdown: {}, createdAt: '2026-08-23T12:00:00.000Z' });
    db.close();

    // 29 days old: NOT expired -> 200 full report.
    const young = await getReport(app.base, youngId, `?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, youngId))}`);
    assert.equal(young.status, 200, 'valid token on a 29-day-old scan renders the report');
    assert.match(young.headers.get('content-type'), /text\/html/);
    assert.ok((await young.text()).includes('The Verdict'), 'full report rendered for the in-window scan');

    // 31 days old: expired -> 410 with the branded expiry page (HTML accept).
    const oldHtmlRes = await getReport(app.base, oldId, `?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, oldId))}`);
    assert.equal(oldHtmlRes.status, 410, 'valid token on a 31-day-old scan -> 410');
    const oldHtml = await oldHtmlRes.text();
    assert.ok(oldHtml.includes('This report link has expired.'), 'expired page headline');
    assert.ok(oldHtml.includes('reports are available for 30 days after your purchase'), 'window copy on the expired page');
    assert.ok(oldHtml.includes('mailto:support@ass-score.com'), 'support contact on the expired page');
    assert.ok(oldHtml.includes(DISCLAIMER), 'mandated disclaimer on the expired page');

    // JSON accept -> 410 error envelope.
    const oldJsonRes = await fetch(`${app.base}/api/v1/report/${oldId}?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, oldId))}`, { headers: { accept: 'application/json' } });
    assert.equal(oldJsonRes.status, 410);
    const oldJson = await oldJsonRes.json();
    assert.equal(oldJson.error.code, 'report_expired');
    assert.ok(oldJson.error.message.includes('30 days'), 'JSON message names the window');
  } finally {
    app.server.close();
  }
});
test('report access window: /api/v1/scans/:id token branch mirrors the report gate — valid token on a 31d-old scan -> 410 report_expired (HTML), 29d-old -> 200 full report; no-token free path stays un-gated', async () => {
  const NOW = '2026-09-23T12:00:00.000Z';
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => NOW });
  try {
    const db = openDb(dbp);
    const youngId = 'scan-29d-via-scans-route';
    const oldId = 'scan-31d-via-scans-route';
    // 29 days before NOW (inside the window) and 31 days before NOW (past it).
    db.insertScan({ id: youngId, url: 'https://young.example/', score: 42, breakdown: {}, createdAt: '2026-08-25T12:00:00.000Z' });
    db.insertScan({ id: oldId, url: 'https://old.example/', score: 42, breakdown: {}, createdAt: '2026-08-23T12:00:00.000Z' });
    db.close();
    // Valid token on a 31-day-old scan via /api/v1/scans/:id: 410, same as
    // /api/v1/report/:id — the buyer's emailed link must not outlive the gate.
    const oldRes = await getHtml(app.base, oldId, `?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, oldId))}`);
    assert.equal(oldRes.status, 410, 'valid token on a 31d-old scan via /api/v1/scans/:id -> 410 report_expired');
    const oldHtml = await oldRes.text();
    assert.ok(oldHtml.includes('This report link has expired.'), 'expired page headline via the scans route');
    assert.ok(oldHtml.includes('reports are available for 30 days after your purchase'), 'window copy on the expired page');
    assert.ok(oldHtml.includes(DISCLAIMER), 'mandated disclaimer on the expired page');
    // Valid token on a 29-day-old scan via the same route: 200 full report.
    const youngRes = await getHtml(app.base, youngId, `?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, youngId))}`);
    assert.equal(youngRes.status, 200, 'valid token on a 29d-old scan via /api/v1/scans/:id renders the full report');
    assert.match(youngRes.headers.get('content-type'), /text\/html/);
    assert.ok((await youngRes.text()).includes('The Verdict'), 'full report rendered for the in-window scan');
    // No-token free path on an OLD scan: still 200 free payload, never gated.
    const freeJson = await getJson(app.base, oldId);
    assert.equal(freeJson.status, 200, 'no-token free JSON on an old scan stays 200');
    const freeHtml = await getHtml(app.base, oldId);
    assert.equal(freeHtml.status, 200, 'no-token free HTML on an old scan stays 200');
    assert.ok((await freeHtml.text()).includes('A.S.S. Score: 42 / 100'), 'free teaser page renders for the old scan');
  } finally {
    app.server.close();
  }
});

test('report access window: missing/invalid token on an old scan stay 403, missing scan stays 404, free routes stay un-gated', async () => {
  const NOW = '2026-09-23T12:00:00.000Z';
  const dbp = tmpDb();
  const app = startApp({ dbPath: dbp, now: () => NOW });
  try {
    const db = openDb(dbp);
    const oldId = 'scan-31d';
    db.insertScan({ id: oldId, url: 'https://old.example/', score: 42, breakdown: {}, createdAt: '2026-08-23T12:00:00.000Z' });
    db.close();

    // Missing token on an EXPIRED scan: 403 (unchanged), never 410 — a 410
    // must not widen the existence oracle beyond current 403 behavior.
    const noToken = await getReport(app.base, oldId);
    assert.equal(noToken.status, 403, 'missing token -> 403 even on an expired scan');
    const noTokenJson = await fetch(`${app.base}/api/v1/report/${oldId}`, { headers: { accept: 'application/json' } });
    assert.equal(noTokenJson.status, 403);
    assert.equal((await noTokenJson.json()).error.code, 'forbidden');

    // Invalid token on an expired scan: 403 (unchanged).
    const badToken = await getReport(app.base, oldId, '?token=v1.0000000000000000000000000000000000000000000000000000000000000000');
    assert.equal(badToken.status, 403, 'invalid token -> 403 even on an expired scan');

    // Missing scan: 404 (unchanged), even with a (validly-formed) token.
    const missing = await getReport(app.base, 'no-such-scan', `?token=${encodeURIComponent(createReportToken(TOKEN_SECRET, 'no-such-scan'))}`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');

    // The FREE routes are NOT gated (free by construction; their rows still
    // purge at 30d via retention): JSON, HTML, and the /report/:id alias all
    // still answer for the expired scan.
    assert.equal((await getJson(app.base, oldId)).status, 200, 'free JSON route not gated');
    const freeHtml = await getHtml(app.base, oldId);
    assert.equal(freeHtml.status, 200, 'free HTML route not gated');
    assert.ok((await freeHtml.text()).includes('A.S.S. Score: 42 / 100'), 'free teaser page renders for the expired scan');
    const alias = await fetch(`${app.base}/report/${oldId}`, { headers: { accept: 'text/html' } });
    assert.equal(alias.status, 200, '/report/:id alias not gated');
  } finally {
    app.server.close();
  }
});

// ------------------------------------------------------------------ (d) unguessable tokens

test('tokens are unguessable: wrong secret, other scan id, and API probes all fail', async () => {
  const created = await (await postScan(api.base)).json();

  // Unit: wrong secret.
  assert.equal(verifyReportToken('wrong-secret', created.id, createReportToken(TOKEN_SECRET, created.id)), false, 'wrong secret rejected');
  // Unit: token minted for another scan id.
  assert.equal(verifyReportToken(TOKEN_SECRET, created.id, createReportToken(TOKEN_SECRET, 'some-other-scan-id')), false, 'other-scan token rejected');
  // Unit: happy path verifies.
  assert.equal(verifyReportToken(TOKEN_SECRET, created.id, createReportToken(TOKEN_SECRET, created.id)), true, 'correct token verifies');
  // Unit: malformed tokens never verify.
  assert.equal(verifyReportToken(TOKEN_SECRET, created.id, ''), false);
  assert.equal(verifyReportToken(TOKEN_SECRET, created.id, undefined), false);
  assert.equal(verifyReportToken(TOKEN_SECRET, created.id, 42), false);

  // API: a token for scan B must not open scan A (both routes).
  const other = await (await postScan(api.base)).json();
  const tokenForOther = createReportToken(TOKEN_SECRET, other.id);
  assert.equal((await getReport(api.base, created.id, `?token=${encodeURIComponent(tokenForOther)}`)).status, 403, 'cross-scan token -> 403 on report');
  assert.equal((await getHtml(api.base, created.id, `?token=${encodeURIComponent(tokenForOther)}`)).status, 403, 'cross-scan token -> 403 on scans');

  // buildReportUrl encodes the token safely and targets the report route.
  const url = buildReportUrl(PUBLIC_BASE, created.id, createReportToken(TOKEN_SECRET, created.id));
  assert.ok(url.startsWith(`${PUBLIC_BASE}/api/v1/report/${created.id}?token=v1.`), `report link shape: ${url}`);
});

// ------------------------------------------------------------------ (e) teaser determinism

/** Synthetic breakdown with three eligible categories (like the SLOP fixture). */
function synthBreakdown() {
  const insight = (i) => ({ roast: `roast ${i}`, why: `why ${i}`, fix: `fix ${i}`, evidence: `evidence ${i}` });
  return {
    filler: { score: 100, findings: ['f1', 'f2'], insights: [insight(1), insight(2)] },
    boilerplate: { score: 100, findings: ['b1', 'b2'], insights: [insight(1), insight(2)] },
    infoDensity: { score: 100, findings: ['i1', 'i2'], insights: [insight(1), insight(2)] },
  };
}

test('teasers: stable for a scan id, seeded differently across ids, and never affect the paid report bytes', async () => {
  // Stability: same (breakdown, id) -> identical teasers, always.
  const bd = synthBreakdown();
  const a1 = pickTeasers(bd, 'scan-id-aaaa');
  const a2 = pickTeasers(bd, 'scan-id-aaaa');
  assert.deepEqual(a2, a1, 'same id -> identical teasers');
  assert.ok(a1.length >= 1 && a1.length <= 2);

  // Seeded variance: find two ids (deterministically) whose picks differ.
  const candidates = ['scan-id-aaaa', 'scan-id-bbbb', 'scan-id-cccc', 'scan-id-dddd', 'scan-id-eeee', 'scan-id-ffff'];
  let idA = null;
  let idB = null;
  for (let i = 0; i < candidates.length && !idA; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (JSON.stringify(pickTeasers(bd, candidates[i])) !== JSON.stringify(pickTeasers(bd, candidates[j]))) {
        idA = candidates[i];
        idB = candidates[j];
        break;
      }
    }
  }
  assert.ok(idA, 'the seed produces at least two distinct teaser selections');
  assert.notDeepEqual(pickTeasers(bd, idB), pickTeasers(bd, idA), 'different ids -> different teaser picks');

  // API-level stability: same scan id -> same teasers across repeated GETs,
  // and the PAID report is byte-identical regardless of teaser selection.
  const created = await (await postScan(api.base)).json();
  const g1 = await (await getJson(api.base, created.id)).json();
  const g2 = await (await getJson(api.base, created.id)).json();
  assert.deepEqual(g2.teasers, g1.teasers, 'repeated GETs return identical teasers');

  const token = createReportToken(TOKEN_SECRET, created.id);
  const p1 = await (await getReport(api.base, created.id, `?token=${encodeURIComponent(token)}`)).text();
  const p2 = await (await getReport(api.base, created.id, `?token=${encodeURIComponent(token)}`)).text();
  assert.equal(p2, p1, 'paid report bytes are independent of teaser selection');
});

// ------------------------------------------------------------------ (e2) problem-only teasers

/** Clean (compliment) insight — carries the kind marker. */
const cleanIns = (i) => ({ kind: 'clean', roast: `nice roast ${i}`, why: `why ${i}`, fix: `fix ${i}`, evidence: `evidence ${i}` });
/** Negative (problem) insight — NO kind key, exactly like real findings. */
const negIns = (i) => ({ roast: `roast ${i}`, why: `why ${i}`, fix: `fix ${i}`, evidence: `evidence ${i}` });

test('teasers are PROBLEM-ONLY: clean compliments never sampled; CLEAN-band categories never sampled; zero-problem site -> []', () => {
  // (a) a category whose only insights are clean compliments is never a source.
  const cleanOnly = {
    filler: { score: 100, findings: ['c1', 'c2'], insights: [cleanIns(1), cleanIns(2)] },
  };
  assert.deepEqual(pickTeasers(cleanOnly, 'scan-clean-only'), [], 'only-clean category yields NO teasers');

  // (b) a category with score < 25 is never a teaser source, even with
  //     negative insights; a >= 25 category supplies them.
  const mixedScores = {
    low: { score: 12, findings: ['f1'], insights: [negIns(1)] },
    high: { score: 88, findings: ['f2'], insights: [negIns(2)] },
  };
  const fromHigh = pickTeasers(mixedScores, 'scan-mixed-1');
  assert.ok(fromHigh.length >= 1, 'the >= 25 category supplies teasers');
  assert.ok(fromHigh.every((t) => t.key === 'high'), 'the sub-25 category is never a teaser source');

  // (c) within a candidate, a clean compliment next to a negative insight is
  //     never the pick — and the pick stays deterministic for the id.
  const mixed = {
    filler: { score: 90, findings: ['f1'], insights: [cleanIns(1), negIns(2)] },
  };
  const a1 = pickTeasers(mixed, 'scan-mix-a');
  const a2 = pickTeasers(mixed, 'scan-mix-a');
  assert.deepEqual(a2, a1, 'problem-only selection is deterministic for the same id');
  assert.ok(a1.length >= 1);
  for (const t of a1) {
    assert.ok(!('kind' in t), 'a clean compliment is never selected as a teaser');
    assert.equal(t.evidence, 'evidence 2', 'the negative insight is the one sampled');
  }

  // (d) a site with zero problem findings (no category >= 25 with a negative
  //     insight) yields teasers: [] — on pickTeasers AND on the free payload
  //     (the teasers KEY stays, empty array is the clean-site signal).
  const zero = {
    filler: { score: 8, findings: ['c1'], insights: [cleanIns(1)] },
    boilerplate: { score: 15, findings: ['c2'], insights: [negIns(2)] }, // < 25 -> not a problem source
  };
  assert.deepEqual(pickTeasers(zero, 'scan-zero-1'), [], 'no problem candidates -> NO teasers');
  const free = buildFreePayload({
    id: 'scan-zero-1', url: 'https://clean.example/', score: 0, verdict: 'CLEANEST', breakdown: zero,
  });
  assert.deepEqual(free.teasers, [], 'free payload carries an EMPTY teasers array (key present)');

  // (d2) mixed clean+problem across categories: teasers come only from the
  //      problem category(ies), never from a clean-only category.
  const zoo = {
    filler: { score: 30, findings: ['c1'], insights: [cleanIns(1)] },
    boilerplate: { score: 70, findings: ['b1'], insights: [negIns(1)] },
  };
  const teasers = pickTeasers(zoo, 'scan-zoo-1');
  assert.ok(teasers.length >= 1, 'problem category supplies the teaser');
  assert.ok(teasers.every((t) => t.key === 'boilerplate' && !('kind' in t)), 'only problem findings surface');
});

// ------------------------------------------------------------------ (f) fulfillment email link

const stripeSession = (overrides = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: overrides.id ?? 'cs_test_paywall_001',
      customer_email: overrides.customer_email ?? 'buyer@example.com',
      metadata: {
        target_url: overrides.target_url ?? 'https://acme.example',
        business_name: 'Acme Corp',
        client_email: 'client@example.com',
      },
    },
  },
});

const query = (dbPath, sql, ...params) => new Database(dbPath, { readonly: true }).prepare(sql).all(...params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForScan(dbPath, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const rows = query(dbPath, 'SELECT id FROM scans ORDER BY created_at');
    if (rows.length > 0) return rows[0];
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for scan row');
    await sleep(20);
  }
}

test('fulfillment: the checkout-webhook email carries a token link that opens the full report', async () => {
  const sent = [];
  const fakeTransport = { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to] }; } };
  const emailSender = createEmailSender({
    env: { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'A.S.S. Score <no-reply@ass-score.com>' },
    publicBaseUrl: PUBLIC_BASE,
    reportTokenSecret: TOKEN_SECRET,
    transport: fakeTransport,
    logger: { log: () => {}, error: () => {}, warn: () => {} },
  });
  const dbPath = tmpDb();
  const app = startApp({ dbPath, fetcher: fakeFetcher(), emailSender, maxWebhooksPerDay: 10 });
  try {
    const res = await fetch(`${app.base}/api/v1/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stripeSession({ id: 'cs_test_paywall_001' })),
    });
    assert.equal(res.status, 202, 'webhook accepted');

    const { id } = await waitForScan(dbPath);
    // Wait for the async email send to land in the fake transport.
    const start = Date.now();
    while (sent.length === 0 && Date.now() - start < 4000) await sleep(20);
    assert.equal(sent.length, 1, 'buyer email sent');

    // The emailed link is the token'd full-report URL on the PUBLIC site
    // origin (/report/<id> — the site's proxy route; the backend's /api/v1
    // /report path is NOT routed by the public domain, so the email must use
    // the site route — owner-approved cleanup 2026-09-28).
    const mailText = sent[0].text;
    assert.ok(mailText.includes(`${PUBLIC_BASE}/report/${id}?token=v1.`), `emailed link is site-origin token'd report URL: ${mailText}`);
    const m = mailText.match(/Full report: (\S+)/);
    assert.ok(m, 'email contains a report link');
    const url = new URL(m[1]);
    assert.equal(url.pathname, `/report/${id}`, 'link path is the site proxy route');
    const token = url.searchParams.get('token');
    assert.match(token, /^v1\.[a-f0-9]{64}$/, 'link carries the versioned report token');
    assert.ok(!m[1].includes('railway'), 'no internal host in the emailed link');

    // Opening the emailed link on the service returns the FULL report.
    const opened = await fetch(`${app.base}/api/v1/report/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
    assert.equal(opened.status, 200, 'emailed link opens the full report');
    const html = await opened.text();
    assert.ok(html.includes('The Verdict') && html.includes('The Actual Findings'), 'full report content');
    assert.ok(html.includes(DISCLAIMER), 'verbatim disclaimer in the emailed report');

    // The same link WITHOUT its token is a 403.
    assert.equal((await fetch(`${app.base}/api/v1/report/${id}`, { headers: { accept: 'text/html' } })).status, 403, 'stripped link -> 403');
  } finally {
    app.server.close();
  }
});

// ------------------------------------------------------------------ buildFreePayload unit

test('buildFreePayload: strips paid fields even when present on the input; keeps free fields', () => {
  const input = {
    id: 'scan-1',
    url: 'https://example.com/',
    score: 55,
    verdict: 'VERY ASS',
    roast: 'a roast line',
    created_at: '2026-09-16T00:00:00.000Z',
    partial: true,
    note: 'some pages failed',
    pages: ['https://example.com/'],
    worstPage: { url: 'https://example.com/', score: 80, findings: ['x'] },
    branding: { agencyName: 'Agency' },
    breakdown: synthBreakdown(),
  };
  const free = buildFreePayload(input);
  assert.equal(free.id, 'scan-1');
  assert.equal(free.score, 55);
  assert.equal(free.partial, true);
  assert.equal(free.note, 'some pages failed');
  assert.equal(free.disclaimer, DISCLAIMER);
  assert.ok(!('pages' in free) && !('worstPage' in free) && !('branding' in free), 'paid analysis/config stripped');
  for (const entry of Object.values(free.breakdown)) {
    assert.ok(!('findings' in entry) && !('insights' in entry), 'breakdown reduced to numbers');
  }
  assert.ok(free.teasers.length >= 1 && free.teasers.length <= 2, 'teasers drawn from the input insights');

  // Determinism: same input -> byte-identical free payload.
  assert.deepEqual(buildFreePayload(input), free, 'free payload is deterministic');
});
