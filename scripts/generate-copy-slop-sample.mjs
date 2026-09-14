// Generates /home/team/shared/copy-slop-e2e-sample.json from the same fixtures
// the test suite uses (offline injected fetcher — no network).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runScan } from '../src/scan.js';
import { validateUrl } from '../src/fetch/ssrf.js';

const HEDGE_PAGE = `<!doctype html><html><head><title>Our Solutions</title></head><body>
<p>We aim to empower your journey. We strive to be your trusted partner in innovation.</p>
<p>Our goal is simple: we're here to help you succeed. We pride ourselves on cutting-edge, world-class, state-of-the-art solutions.</p>
<p>We look forward to serving you. In today's fast-paced world, we deliver seamless experiences driven by synergy.</p>
<p>This page has been carefully written to describe our values, our mission, and what we believe makes us different.</p>
</body></html>`;

const SPECIFIC_PAGE = `<!doctype html><html><head><title>Acme Corp Results</title></head><body>
<p>Founded in 2013, Acme Corp uses AWS and Figma to serve 10,000 customers in 24 countries.</p>
<p>Our $2 million annual budget grew 23% last year, and revenue hit $4.5M in March 2022.</p>
<p>We ship 3 new features every quarter and support 99.9% uptime for enterprise accounts.</p>
</body></html>`;

const noopValidate = async (raw) => validateUrl(raw);

async function scan(html) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copyslop-sample-')), 'test.db');
  const db = openDb(dbPath);
  try {
    const fetcher = { fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: html }) };
    const { payload } = await runScan({ db, fetcher, url: 'https://acme.example/', now: () => '2026-09-14T00:00:00.000Z' });
    const row = db.getScan(payload.id);
    return { scan: payload, storedBreakdownMatches: JSON.stringify(row.breakdown) === JSON.stringify(payload.breakdown) };
  } finally {
    db.close();
  }
}

const hedge = await scan(HEDGE_PAGE);
const specific = await scan(SPECIFIC_PAGE);

const out = {
  generatedBy: 'src/rules/copySlop.js + fixtures from test/copySlop.test.js (offline injected fetcher, no network)',
  note: 'hedgeScan = hedge-y copy (findings under breakdown.boilerplate + breakdown.infoDensity); specificScan = specifics-rich copy (no gap finding)',
  storedBreakdownMatches: hedge.storedBreakdownMatches && specific.storedBreakdownMatches,
  hedgeScan: hedge.scan,
  specificScan: specific.scan,
};

fs.writeFileSync('/home/team/shared/copy-slop-e2e-sample.json', JSON.stringify(out, null, 2) + '\n');
console.log('written');
console.log('hedge boilerplate findings:');
console.log(JSON.stringify(hedge.scan.breakdown.boilerplate.findings, null, 1));
console.log('hedge infoDensity specifics finding:');
console.log(JSON.stringify(hedge.scan.breakdown.infoDensity.findings.filter((f) => f.startsWith('concrete specifics:')), null, 1));
console.log('specific infoDensity has gap finding?',
  specific.scan.breakdown.infoDensity.findings.some((f) => f.startsWith('concrete specifics:')),
  '| slopScore:', specific.scan.slopScore);