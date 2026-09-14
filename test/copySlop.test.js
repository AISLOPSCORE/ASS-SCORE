import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { extractText } from '../src/text.js';
import { runRules } from '../src/rules/index.js';
import { boilerplateRegexes } from '../src/rules/boilerplate.js';
import {
  analyzeHedges,
  analyzeSpecifics,
  specificsFinding,
  specificsGapPenalty,
  HEDGE_PHRASES,
  KNOWN_NAMES,
  MAX_EVIDENCE_QUOTES,
} from '../src/rules/copySlop.js';
import { analyze as boilerplate } from '../src/rules/boilerplate.js';
import { analyze as infoDensity } from '../src/rules/infoDensity.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-copyslop-')), 'test.db');

/** Route-level SSRF guard (no DNS) so the fixture scan stays offline. */
const offlineValidateTarget = async (raw) => validateUrl(raw);

const ctx = (html) => extractText(html);

// ------------------------------------------------------------------ fixtures

// Hedge-heavy page: every representative group of vague constructions.
const HEDGE_PAGE = `<!doctype html><html><head><title>Our Solutions</title></head><body>
<p>We aim to empower your journey. We strive to be your trusted partner in innovation.</p>
<p>Our goal is simple: we're here to help you succeed. We pride ourselves on cutting-edge, world-class, state-of-the-art solutions.</p>
<p>We look forward to serving you. In today's fast-paced world, we deliver seamless experiences driven by synergy.</p>
<p>This page has been carefully written to describe our values, our mission, and what we believe makes us different.</p>
</body></html>`;

// Specifics-rich page: dates, numbers, prices, percentages, named brands.
const SPECIFIC_PAGE = `<!doctype html><html><head><title>Acme Corp Results</title></head><body>
<p>Founded in 2013, Acme Corp uses AWS and Figma to serve 10,000 customers in 24 countries.</p>
<p>Our $2 million annual budget grew 23% last year, and revenue hit $4.5M in March 2022.</p>
<p>We ship 3 new features every quarter and support 99.9% uptime for enterprise accounts.</p>
</body></html>`;

// Vague page with exactly two concrete specifics (~270 words).
const THIN_WITH_2 = `${Array.from(
  { length: 14 },
  () => 'Our team is passionate about delivering outstanding value through careful work on every project we undertake.',
).join(' ')} Founded in 2022, the company operates 3 offices worldwide.`;

// ------------------------------------------------------------------ unit: hedges

test('copySlop: hedge phrases are detected (case-insensitive, substring) with exact-sentence evidence', () => {
  const { text, sentences } = ctx(HEDGE_PAGE);
  const h = analyzeHedges(text, sentences);

  // A hedges report exists with counted hits + total.
  assert.ok(h.total >= 10, `hedge total ${h.total}`);
  const byPhrase = new Map(h.hits.map((x) => [x.phrase, x.count]));

  // Representative groups must each be present.
  for (const phrase of [
    'we aim to',           // "we aim/strive" family
    'we strive to',
    'our goal is simple',  // "our goal" family
    "we're here to help",  // "we're here to" family
    'we pride ourselves on', // "we pride" family
    "we look forward to",  // "we look forward" family
    "in today's fast-paced world", // cliché opener
    'cutting-edge',        // superlative buzz
    'world-class',
    'seamless experience', // plural form must NOT match "seamless experiences"
    'synergy',
  ]) {
    assert.ok(byPhrase.has(phrase), `phrase "${phrase}" detected`);
    assert.equal(byPhrase.get(phrase), 1, `phrase "${phrase}" counted once`);
  }

  // Exact-sentence evidence quoted (capped), pointing at the real trigger.
  assert.ok(h.quotes.length >= 5 && h.quotes.length <= MAX_EVIDENCE_QUOTES, `quotes capped: ${h.quotes.length}`);
  const ev = h.quotes.find((q) => q.phrase === 'we aim to');
  assert.ok(ev, 'quote for "we aim to"');
  assert.equal(ev.sentence, 'We aim to empower your journey.');
  const ev2 = h.quotes.find((q) => q.phrase === "in today's fast-paced world");
  assert.ok(ev2 && ev2.sentence.includes("In today's fast-paced world"), `sentence: ${ev2?.sentence}`);
});

test('copySlop: hedge list is disjoint from boilerplate regexes — no same-sentence double count', () => {
  // Every hedge phrase must NOT be matched by any boilerplate regex (so a
  // single sentence can never be counted twice inside the boilerplate
  // category).
  for (const phrase of HEDGE_PHRASES) {
    for (const re of boilerplateRegexes) {
      const probe = new RegExp(re.source, re.flags);
      assert.ok(!probe.test(phrase), `hedge "${phrase}" must not collide with boilerplate regex /${re.source}/`);
    }
  }
  // Phrases the boilerplate rule already owns are NOT repeated here.
  for (const owned of ['we are committed to', 'we are dedicated to', 'driven by passion', 'our mission is to']) {
    assert.ok(!HEDGE_PHRASES.includes(owned), `boilerplate-owned phrase "${owned}" is not re-listed`);
  }
  // The canonical overlap sentence counts once under one label per span.
  const r = boilerplate(ctx(`<html><body><p>We are committed to providing excellent service.</p></body></html>`));
  assert.ok(r.findings.some((f) => f.startsWith('1 boilerplate signal(')), `single signal: ${r.findings[0]}`);
  assert.ok(r.findings.some((f) => /1× generic commitment claim/.test(f)), 'existing boilerplate signal fires');
});

test('copySlop: hedge evidence folds into boilerplate category (labels + quotes + density)', () => {
  const rule = boilerplate(ctx(HEDGE_PAGE));
  assert.ok(rule.findings.some((f) => /× hedge phrase/.test(f)), 'hedge label findings present');
  assert.ok(rule.findings.some((f) => f.startsWith('hedge evidence: "')), 'quoted sentence evidence present');
  // Score contribution: hedge hits raise the density (a vague page scores high).
  assert.ok(rule.score >= 60, `boilerplate score ${rule.score} on the hedge page`);
});

// ------------------------------------------------------------------ unit: specifics

test('copySlop: specifics — rich copy produces NO gap finding and zero score contribution', () => {
  const { text, words } = ctx(SPECIFIC_PAGE);
  const s = analyzeSpecifics(text, words.length);
  assert.ok(s.count >= 1, `specifics count ${s.count}`);
  assert.equal(s.gap, false, 'no gap when specifics are plentiful');
  assert.equal(specificsGapPenalty(text, words.length), 0, 'score contribution exactly 0');
  assert.equal(specificsFinding(text, words.length), null, 'no finding emitted');

  const rule = infoDensity(ctx(SPECIFIC_PAGE));
  assert.ok(!rule.findings.some((f) => f.startsWith('concrete specifics:')), 'infoDensity has no gap finding');
});

test('copySlop: specifics — zero specifics emits the full no-dates/numbers/prices finding', () => {
  const { text, words } = ctx(`<html><body><p>We are passionate about what we do and your success is our only priority.</p></body></html>`);
  const s = analyzeSpecifics(text, words.length);
  assert.equal(s.count, 0);
  assert.equal(s.gap, true);
  assert.match(specificsFinding(text, words.length), /0 found in \d+ words — no dates, numbers, prices, percentages, or named references/);
  assert.equal(specificsGapPenalty(text, words.length), 100, 'full penalty when nothing concrete at all');
});

test('copySlop: specifics — thin copy emits the count variant with examples', () => {
  const { text, words } = ctx(`<html><body><p>${THIN_WITH_2}</p></body></html>`);
  const s = analyzeSpecifics(text, words.length);
  assert.equal(s.count, 2, `exactly 2 specifics (got ${s.count})`);
  assert.equal(s.gap, true, '2 specifics in ~270 words is below the ~1/75 threshold');
  assert.equal(s.needed, Math.ceil(words.length / 75));
  const finding = specificsFinding(text, words.length);
  assert.match(finding, /concrete specifics: only 2 in \d+ words \(need at least \d+ per 75 words\)/);
  assert.ok(finding.includes('2022') && finding.includes('3'), `examples quoted: ${finding}`);
  // Penalty is proportionate to the gap, never 100 for a "few specifics" page.
  const penalty = specificsGapPenalty(text, words.length);
  assert.ok(penalty > 0 && penalty < 100, `partial penalty ${penalty}`);

  // The finding reaches the infoDensity category.
  const rule = infoDensity(ctx(`<html><body><p>${THIN_WITH_2}</p></body></html>`));
  assert.ok(rule.findings.some((f) => f.startsWith('concrete specifics: only 2')), 'infoDensity carries the count variant');
});

test('copySlop: specifics — overlapping spans are deduped (year/number, currency/number, percent/number)', () => {
  const { text, words } = ctx(`<html><body><p>In 2022 we spent $99 on 3% of our budget.</p></body></html>`);
  const s = analyzeSpecifics(text, words.length);
  assert.equal(s.count, 3, 'one span each for year, currency, percent (got ' + JSON.stringify(s.kinds) + ')');
  assert.deepEqual(s.kinds, { year: 1, currency: 1, percent: 1 });
});

test('copySlop: specifics — sentence-initial capitalized words are not proper nouns; named brands are', () => {
  const { text, words } = ctx(`<html><body><p>Welcome to our platform. Every morning we demo Figma and Google Cloud to San Francisco teams.</p></body></html>`);
  const s = analyzeSpecifics(text, words.length);
  // "Welcome to" is sentence-initial -> skipped; "San Francisco" mid-sentence
  // -> proper noun; Figma + Google Cloud -> known names.
  assert.ok(s.count >= 3, `count ${s.count}: ${JSON.stringify(s.kinds)}`);
  assert.ok(!s.examples.includes('Welcome'), 'sentence-initial "Welcome to" not counted');
  assert.ok(s.examples.some((e) => /Figma/.test(e)), 'named brand Figma counted');
});

test('copySlop: config sanity — 25–40 curated hedge phrases, editable list, bounded quotes', () => {
  assert.ok(HEDGE_PHRASES.length >= 25 && HEDGE_PHRASES.length <= 40, `hedge phrases: ${HEDGE_PHRASES.length}`);
  assert.ok(KNOWN_NAMES.length >= 15, `known names: ${KNOWN_NAMES.length}`);
  assert.ok(MAX_EVIDENCE_QUOTES >= 1);
  for (const p of HEDGE_PHRASES) assert.equal(p, p.trim().toLowerCase(), `phrase normalized: "${p}"`);
});

// ------------------------------------------------------------------ determinism

test('copySlop: deterministic — same text -> identical hedge + specifics + category output', () => {
  const c = ctx(HEDGE_PAGE);
  assert.deepEqual(analyzeHedges(c.text, c.sentences), analyzeHedges(c.text, c.sentences));
  const s = analyzeSpecifics(c.text, c.words.length);
  assert.deepEqual(s, analyzeSpecifics(c.text, c.words.length));
  assert.deepEqual(runRules(c), runRules(c));

  const r = ctx(SPECIFIC_PAGE);
  assert.deepEqual(runRules(r), runRules(r));
  assert.deepEqual(runRules(ctx(`<html><body><p>${THIN_WITH_2}</p></body></html>`)), runRules(ctx(`<html><body><p>${THIN_WITH_2}</p></body></html>`)));
});

// ------------------------------------------------------------ integration (API)

const fakeFetcher = (html) => ({
  fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }),
});

function startApp(dbPath, html) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(html), validateTarget: offlineValidateTarget });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const postScan = (base, url) =>
  fetch(`${base}/api/v1/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

let hedgeApi;
let hedgeDb;

before(() => {
  hedgeDb = tmpDb();
  hedgeApi = startApp(hedgeDb, HEDGE_PAGE);
});

after(() => {
  hedgeApi.server.close();
});

test('E2E: hedge-y fixture -> JSON breakdown shows hedge findings under boilerplate + specifics gap under infoDensity', async () => {
  const res = await postScan(hedgeApi.base, 'https://acme.example/');
  assert.equal(res.status, 200);
  const json = await res.json();
  // Flipped public contract: hedge fixture internal 75 -> public 25, which is
  // the catastrophically-ass band (0-34).
  assert.equal(json.score, 25, 'hedge fixture internal 75 -> public 25');
  assert.equal(json.verdict, 'CATASTROPHICALLY ASS');

  const bp = json.breakdown.boilerplate;
  assert.ok(bp.findings.some((f) => /× hedge phrase/.test(f)), 'hedge label findings');
  assert.ok(bp.findings.some((f) => f.startsWith('hedge evidence: "We aim to empower your journey."')), 'exact quoted evidence');
  assert.ok(bp.findings.some((f) => f.includes("In today's fast-paced world")), 'cliché opener quoted');

  const id = json.breakdown.infoDensity;
  assert.ok(id.findings.some((f) => f.startsWith('concrete specifics:')), 'specifics gap finding present');
  assert.match(id.findings.find((f) => f.startsWith('concrete specifics:')), /0 found|only \d+/);

  // Persisted unchanged: the DB stores the INTERNAL slop scores; the response
  // is the flip (public + internal == 100 per category), findings untouched.
  const row = new (await import('better-sqlite3')).default(hedgeDb)
    .prepare('SELECT breakdown FROM scans WHERE id = ?').get(json.id);
  const stored = JSON.parse(row.breakdown);
  assert.equal(stored.boilerplate.score, 100 - bp.score, 'stored boilerplate == flipped public');
  assert.deepEqual(stored.boilerplate.findings, bp.findings, 'findings stored bytes-exact');
  assert.equal(stored.infoDensity.score, 100 - id.score);

  // Determinism across rescans: same public score, same findings.
  const res2 = await postScan(hedgeApi.base, 'https://acme.example/');
  const json2 = await res2.json();
  assert.equal(json2.score, json.score);
  assert.deepEqual(json2.breakdown, json.breakdown);
});

test('E2E: hedge-y fixture -> HTML report renders the hedge + specifics rows under the right category', async () => {
  const created = await (await postScan(hedgeApi.base, 'https://acme.example/')).json();
  const html = await (await fetch(`${hedgeApi.base}/api/v1/scans/${created.id}`, { headers: { accept: 'text/html' } })).text();
  assert.ok(html.includes('🥱 Generic marketing language'), 'boilerplate row under its emoji label');
  assert.ok(html.includes('hedge phrase'), 'hedge finding rendered in HTML');
  assert.ok(html.includes('hedge evidence: &quot;We aim to empower your journey.&quot;'), 'quoted evidence rendered (HTML-escaped)');
  assert.ok(html.includes('concrete specifics:'), 'specifics gap finding rendered');
  assert.ok(html.includes('This tool identifies writing and design patterns commonly associated with generic or templated content.'), 'mandated disclaimer intact');
  const rows = (html.match(/<tr>/g) ?? []).length;
  assert.equal(rows, 1 + Object.keys(created.breakdown).length, 'breakdown rows + header');
});

test('E2E: specifics-rich fixture -> zero gap finding in JSON; clean-copy page unaffected', async () => {
  const api = startApp(tmpDb(), SPECIFIC_PAGE);
  try {
    const res = await postScan(api.base, 'https://acme.example/');
    assert.equal(res.status, 200);
    const json = await res.json();
    // Flipped public contract: specifics-rich fixture internal 10 -> public 90
    // -> the cleanest band (90-100).
    assert.equal(json.score, 90, 'specifics fixture internal 10 -> public 90');
    assert.equal(json.verdict, 'CLEANEST');
    const id = json.breakdown.infoDensity;
    assert.ok(!id.findings.some((f) => f.startsWith('concrete specifics:')), 'no gap finding for specific copy');
    assert.ok(json.breakdown.boilerplate.findings.every((f) => !f.includes('hedge phrase')), 'no hedge findings on a specific, hedge-free page');

    // GET JSON carries the same breakdown.
    const got = await (await fetch(`${api.base}/api/v1/scans/${json.id}`, { headers: { accept: 'application/json' } })).json();
    assert.deepEqual(got.breakdown, json.breakdown);
  } finally {
    api.server.close();
  }
});