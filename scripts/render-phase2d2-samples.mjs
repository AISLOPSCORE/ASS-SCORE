/**
 * Render the Phase 2D-2 polished Full Report samples through the REAL paid
 * report renderer (the token'd route) — same harness as
 * scripts/render-report-samples.mjs and test/fullReportIa.test.js (fixture
 * rows inserted straight into a temp SQLite DB, no live scans; the share
 * card and landing page are untouched).
 *
 * Usage: node scripts/render-phase2d2-samples.mjs [outDir] [sitePublicDir]
 *   outDir       defaults to /home/team/shared/phase2d2-samples
 *   sitePublicDir defaults to /home/team/shared/site/public
 *
 * Writes:
 *   <outDir>/clean.html            (score 7  -> CLEANEST, all categories clean)
 *   <outDir>/sloppy.html           (score 89 -> EXTREMELY ASS, every state)
 *   <outDir>/mid.html              (score 50 -> VERY ASS, mid-band reference)
 *   <sitePublicDir>/phase2d2-preview-clean.html   (owner review preview)
 *   <sitePublicDir>/phase2d2-preview-sloppy.html  (owner review preview)
 *
 * Deterministic: same fixtures + IDs always produce identical HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';

const SECRET = 'phase2d2-sample-secret';
const outDir = process.argv[2] ?? '/home/team/shared/phase2d2-samples';
const sitePublicDir = process.argv[3] ?? '/home/team/shared/site/public';

const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);

function startApp(dbPath) {
  const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET });
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function insertScan(dbPath, { id, url = 'https://fixture.example/', score, breakdown, createdAt = '2026-09-17T12:00:00.000Z', worstPage = null }) {
  const repository = openDb(dbPath);
  repository.insertScan({ id, url, score, breakdown, createdAt, worstPage: worstPage ?? undefined });
  repository.close();
}

async function paidHtml(base, id) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  if (res.status !== 200) throw new Error(`paid report for ${id} returned ${res.status}`);
  return res.text();
}

/** Clean fixture — low score (7/100 -> CLEANEST), nothing to roast. */
const CLEAN_BREAKDOWN = {
  filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
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

/** Sloppy fixture — high score (89/100 -> EXTREMELY ASS), all state colors. */
const SLOPPY_BREAKDOWN_89 = {
  filler: { score: 88, findings: ['3× "cutting-edge"', '2× "seamless"'] },
  boilerplate: { score: 62, findings: ['1× hedge phrase "we aim to"'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};

/** Mid fixture — score 50 (VERY ASS), mid-band hero + NEEDS ATTENTION mix. */
const MID_BREAKDOWN = {
  filler: { score: 55, findings: ['3× "cutting-edge"'] },
  boilerplate: { score: 40, findings: ['1× hedge phrase "we aim to"'] },
  infoDensity: { score: 60, findings: ['concrete specifics: 1 found in 320 words — no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 25, findings: ['repeated sentence openings: 5× "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 10, findings: [] },
  assets: { score: 45, findings: ['1 of 3 images from stock/placeholder CDNs'] },
};

async function renderSample(dbPath, { id, score, breakdown, url }) {
  insertScan(dbPath, { id, score, breakdown, url });
  const app = startApp(dbPath);
  try {
    return await paidHtml(app.base, id);
  } finally {
    app.server.close();
  }
}

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase2d2-samples-')), 'test.db');
const clean = await renderSample(dbPath, { id: 'phase2d2-clean', score: 7, breakdown: CLEAN_BREAKDOWN, url: 'https://clean-example.com/' });
const sloppy = await renderSample(dbPath, { id: 'phase2d2-sloppy', score: 89, breakdown: SLOPPY_BREAKDOWN_89, url: 'https://sloppy-example.com/' });
const mid = await renderSample(dbPath, { id: 'phase2d2-mid', score: 50, breakdown: MID_BREAKDOWN, url: 'https://mid-example.com/' });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'clean.html'), clean);
fs.writeFileSync(path.join(outDir, 'sloppy.html'), sloppy);
fs.writeFileSync(path.join(outDir, 'mid.html'), mid);
console.log(`wrote ${path.join(outDir, 'clean.html')} (${clean.length} bytes)`);
console.log(`wrote ${path.join(outDir, 'sloppy.html')} (${sloppy.length} bytes)`);
console.log(`wrote ${path.join(outDir, 'mid.html')} (${mid.length} bytes)`);

// Owner review previews on the published site (updated by `bun run publish`).
fs.mkdirSync(sitePublicDir, { recursive: true });
fs.writeFileSync(path.join(sitePublicDir, 'phase2d2-preview-clean.html'), clean);
fs.writeFileSync(path.join(sitePublicDir, 'phase2d2-preview-sloppy.html'), sloppy);
console.log(`wrote ${path.join(sitePublicDir, 'phase2d2-preview-clean.html')}`);
console.log(`wrote ${path.join(sitePublicDir, 'phase2d2-preview-sloppy.html')}`);