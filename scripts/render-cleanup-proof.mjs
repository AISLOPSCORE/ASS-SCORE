/**
 * Dashboard final cleanup proof — boot the REAL app with fixture rows, then:
 *  (1) render token'd paid report HTML for clean (7) + sloppy (89) scans
 *      through the real report renderer;
 *  (2) assert the cleanup contracts on the rendered HTML (no "(s)" leaks, no
 *      nested-quote soup, no fake clean-category cards in THE ACTUAL FINDINGS,
 *      no negative-finding loss, compact fix-first with working links,
 *      new section order);
 *  (3) screenshot the paid reports at desktop (1280px) AND mobile (390px)
 *      widths with headless chromium.
 * Writes everything under /home/team/shared/cleanup-proof/.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';

const SECRET = 'cleanup-proof-secret';
const OUT = '/home/team/shared/cleanup-proof';
fs.mkdirSync(OUT, { recursive: true });

const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-proof-')), 'test.db');
const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET, publicBaseUrl: 'https://www.ass-score.com' });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function mk(id, score, breakdown, worstPage) {
  const repo = openDb(dbPath);
  repo.insertScan({ id, url: 'https://fixture.example/', score, breakdown, createdAt: '2026-09-23T09:00:00.000Z', worstPage: worstPage ?? undefined });
  repo.close();
}

// NEW-format fixtures: evidence strings exactly as the fixed rules emit
// (plural-correct, curly-quoted labels). Clean = 7/100 CLEAN, sloppy = 89.
const CLEAN = {
  filler: { score: 0, findings: ['0 filler phrase occurrences in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signals in 108 words (0.0 per 300 words)'] },
  infoDensity: { score: 0, findings: [
    'vocabulary diversity (MATTR-50): 0.900 (lower = more repetitive vocabulary)',
    'stopword ratio: 32.0%',
    'mean sentence length: 18.0 words (6 sentences)',
    'short paragraphs (<25 words): 0% (3 paragraphs)',
  ] },
  repetitive: { score: 0, findings: ['no notable repetitive structure (6 sentences, 3 paragraphs)'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged for stock/placeholder signals'] },
};
const SLOPPY = {
  filler: { score: 88, findings: ['3× "cutting-edge"', '2× "seamless"'] },
  boilerplate: { score: 62, findings: ['2× generic \u201Clearn more\u201D CTA', '1 boilerplate signal in 300 words (0.5 per 300 words)'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};

const IDS = { clean: 'c1111111-1111-4111-8111-111111111111', sloppy: 'c2222222-2222-4222-8222-222222222222' };
await mk(IDS.clean, 7, CLEAN);
await mk(IDS.sloppy, 89, SLOPPY);

// ---- (1) paid report HTML -------------------------------------------------
const htmls = {};
for (const [name, id] of Object.entries(IDS)) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  if (res.status !== 200) throw new Error(`${name} report ${res.status}`);
  const html = await res.text();
  htmls[name] = html;
  fs.writeFileSync(path.join(OUT, `report-${name}.html`), html);
  console.log(`${name}: report html saved (${html.length} bytes)`);
}

// ---- (2) cleanup contract checks (asserted hard — the proof IS the gate) ---
const sloppy = htmls.sloppy;
const clean = htmls.clean;
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures += 1; console.log(`FAIL: ${msg}`); } else console.log(`ok: ${msg}`); };

// section order (new hierarchy: hero → verdict → attention → breakdown → working → findings → final → methodology)
const seq = ['A.S.S. Score: 89 / 100', 'The Verdict', 'Page That Needs The Most Work', 'What To Fix First',
  'Your Breakdown', "What's Working", 'The Actual Findings', 'Final Verdict', 'Methodology'];
let prev = -1;
check(seq.every((m) => { const at = sloppy.indexOf(m); const ok = at > prev; prev = at; return ok; }), 'new section order holds in the rendered HTML');

// (s) leaks: zero anywhere in the paid report
for (const leak of ['signal(s)', 'specific(s)', 'occurrence(s)', 'flagged pair(s)', 'phrase(s)', 'buzzword(s)', 'repeat(s)', 'appearance(s)', 'fact(s)', 'pair(s)']) {
  check(!sloppy.includes(leak), `no "${leak}" leak in sloppy report`);
  check(!clean.includes(leak), `no "${leak}" leak in clean report`);
}
// nested-quote soup gone: the boilerplate label reads with proper inner quotes
check(sloppy.includes('generic \u201Clearn more\u201D CTA'), 'boilerplate label uses proper inner quotes (curly), no soup');
check(!sloppy.includes('2× generic &quot;learn more&quot; CTA'), 'no ASCII double-quote soup around the label');
// plural-correct strings present
check(sloppy.includes('1 boilerplate signal in 300 words (0.5 per 300 words)'), 'singular evidence line reads correctly');
check(clean.includes('0 boilerplate signals in 108 words'), 'plural-zero evidence line reads correctly');
// clean categories: no fake "Nothing meaningful to roast here" cards inside
// THE ACTUAL FINDINGS (fingerprints is clean on the sloppy report)
const findingsRegion = sloppy.slice(sloppy.indexOf('The Actual Findings'), sloppy.indexOf('Final Verdict'));
check(!findingsRegion.includes('Nothing meaningful to roast here'), 'no placeholder roast cards for clean categories in THE ACTUAL FINDINGS');
check(findingsRegion.includes('id="cat-fingerprints"'), 'clean-category anchor target still present (2C wiring intact)');
// negative findings preserved: 7 negatives in the fixture (filler 2 + boilerplate 2
// + infoDensity 1 + repetitive 1 + assets 1) -> 7 finding cards, 7 roast layers
const cardCount = (sloppy.match(/<div class="finding-card">/g) ?? []).length;
check(cardCount === 7, `all 7 negative findings still render as cards (got ${cardCount})`);
check((sloppy.match(/<p class="ins-roast">/g) ?? []).length === 7, '7 roast layers preserved');
check(sloppy.includes('7 findings across 5 categories'), 'summary count still counts exactly the negative findings');
// compact What To Fix First: ranked summary, capped at 5, links resolve, no duplicated full findings
const fixItems = [...sloppy.matchAll(/<li class="fix-item fix-([a-z-]+)">/g)].map((m) => m[1]);
check(fixItems.length === 5, `fix-first capped at 5 ranked items (got ${fixItems.length})`);
check(!fixItems.length || fixItems.every((c) => ['priority', 'needs-attention', 'watch'].includes(c)), 'fix cards carry real state classes');
const fixLinks = [...sloppy.matchAll(/class="fix-link" href="#(cat-[a-z]+)"/g)].map((m) => m[1]);
check(fixLinks.length === 5, `each fix item links to its category view (got ${fixLinks.length})`);
check(fixLinks.every((a) => sloppy.includes(`id="${a}"`)), 'every fix link resolves to a real in-page anchor');
check(fixLinks.includes('cat-infodensity') && fixLinks.includes('cat-filler') && fixLinks.includes('cat-assets'), 'fix-first ranks by category severity (infoDensity 90 > filler 88 > assets 82 …)');
check(!sloppy.includes('class="fix-problem"') && !sloppy.includes('class="fix-evidence"'), 'fix-first items never repeat the full roast or full receipt');
const fixRegion = sloppy.slice(sloppy.indexOf('What To Fix First'), sloppy.indexOf('Your Breakdown'));
check(!fixRegion.includes('class="finding-card"'), 'fix-first section contains no duplicated finding cards');
// all 7 category anchors + 7 views still wired
check((sloppy.match(/id="cat-[a-z]+"/g) ?? []).length >= 7, 'all 7 category anchors present');
check((sloppy.match(/<section class="cat-view" id="(?:view-cat-[a-z]+)" hidden>/g) ?? []).length === 7, 'all 7 category views present');
check(!sloppy.includes('"><'), 'sacred markup constraint: no raw quote-bracket sequence');
check(sloppy.includes('does not detect AI authorship'), 'mandated disclaimer verbatim');

// ---- (3) chromium screenshots: desktop + mobile ---------------------------
const CHROME = '/usr/local/bin/chromium';
const shots = [
  ['report-sloppy-desktop.png', '1280,8200', IDS.sloppy],
  ['report-sloppy-mobile.png', '390,8600', IDS.sloppy],
  ['report-clean-desktop.png', '1280,6000', IDS.clean],
  ['report-clean-mobile.png', '390,6600', IDS.clean],
];
for (const [file, win, id] of shots) {
  const token = createReportToken(SECRET, id);
  const url = `${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`;
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    `--window-size=${win}`, '--virtual-time-budget=12000',
    `--screenshot=${path.join(OUT, file)}`, url],
    { stdio: 'ignore', timeout: 150000 });
  console.log(`${file}: screenshot saved`);
}

server.close();
console.log(failures === 0 ? 'ALL CONTRACTS PASS' : `CONTRACT FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);