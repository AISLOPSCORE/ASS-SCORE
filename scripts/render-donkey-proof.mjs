/**
 * Donkey wiring proof — boot the REAL app with fixture rows, then:
 *  (1) render token'd paid report HTML for clean (7) + sloppy (89) scans;
 *  (2) verify GET /assets/donkey-dashboard.png serves the exact cutout bytes;
 *  (3) render share-card PNGs for 7/50/93 (1600x900) and pixel-check the
 *      donkey region;
 *  (4) screenshot the paid report pages (headless chromium) for visual proof.
 * Writes everything under /home/team/shared/donkey-wiring-proof/.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';

const SECRET = 'donkey-wiring-proof-secret';
const OUT = '/home/team/shared/donkey-wiring-proof';
fs.mkdirSync(OUT, { recursive: true });

const fakeFetcher = () => ({ fetchHtml: async (raw) => ({ status: 200, url: new URL(raw).href, body: '<html><body><p>x</p></body></html>' }) });
const offlineValidateTarget = async (raw) => validateUrl(raw);
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-proof-')), 'test.db');
const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: offlineValidateTarget, maxScansPerDay: 0, reportTokenSecret: SECRET, publicBaseUrl: 'https://www.ass-score.com' });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function mk(id, score, breakdown) {
  const repo = openDb(dbPath);
  repo.insertScan({ id, url: 'https://fixture.example/', score, breakdown, createdAt: '2026-09-22T12:00:00.000Z' });
  repo.close();
}
const CLEAN = {
  filler: { score: 0, findings: ['0 filler phrase occurrence(s) in 108 words (0.0 per 300 words)'] },
  boilerplate: { score: 0, findings: ['0 boilerplate signal(s) in 108 words (0.0 per 300 words)'] },
  infoDensity: { score: 0, findings: ['mattr 0.900', 'stopword ratio: 32.0%', 'mean sentence length: 18.0 words'] },
  repetitive: { score: 0, findings: ['no notable repetitive structure'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 0, findings: ['0 of 2 images flagged'] },
};
const SLOPPY = {
  filler: { score: 88, findings: ['3x "cutting-edge"', '2x "seamless"'] },
  boilerplate: { score: 62, findings: ['1x hedge phrase "we aim to"'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5x "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock CDNs'] },
};

const IDS = { clean: '11111111-1111-4111-8111-111111111111', sloppy: '22222222-2222-4222-8222-222222222222' };
await mk(IDS.clean, 7, CLEAN);
await mk(IDS.sloppy, 89, SLOPPY);

// ---- (1) paid report HTML ----
for (const [name, id] of Object.entries(IDS)) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  if (res.status !== 200) throw new Error(`${name} report ${res.status}`);
  const html = await res.text();
  fs.writeFileSync(path.join(OUT, `report-${name}.html`), html);
  console.log(`${name}: report html saved (${html.length} bytes); final-donkey img=${html.includes('class="final-donkey"')}; head-donkey=${html.includes('class="head-donkey"')}; no-open-report-btn=${!html.includes('Open full report')}`);
}

// ---- (2) asset route serves the exact cutout ----
const asset = await fetch(`${base}/assets/donkey-dashboard.png`);
const assetBuf = Buffer.from(await asset.arrayBuffer());
const srcBuf = fs.readFileSync('/home/team/shared/mascot-system-samples/donkey-dashboard.png');
console.log(`asset route: ${asset.status} ${asset.headers.get('content-type')} bytes=${assetBuf.length} exact-match=${assetBuf.equals(srcBuf)}`);

// ---- (3) share card PNGs 7/50/93 ----
for (const score of [7, 50, 93]) {
  const uid = `33333333-3333-4333-8333-${String(score).padStart(12, '0')}`;
  await mk(uid, score, score === 7 ? CLEAN : SLOPPY);
  const res = await fetch(`${base}/api/v1/scans/${uid}/card`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(OUT, `card-${score}.png`), buf);
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  // donkey zone in card coords: x 1050-1560, y 66-861
  let warm = 0, neon = 0;
  for (let y = 66; y <= 861 && y < info.height; y += 2) {
    for (let x = 1050; x <= 1560 && x < info.width; x += 2) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 90 && r > g * 1.15 && r > b * 1.15 && g > 40) warm++;
      if (g > 150 && g > r * 1.25 && g > b * 1.25) neon++;
    }
  }
  console.log(`card-${score}: ${res.status} ${meta.width}x${meta.height} donkey-zone warm=${warm} neon=${neon} ${meta.width === 1600 && meta.height === 900 ? 'SIZE-OK' : 'SIZE-BAD'}`);
}

// ---- (4) chromium screenshots of the paid reports ----
const CHROME = '/usr/local/bin/chromium';
for (const name of ['clean', 'sloppy']) {
  const token = createReportToken(SECRET, IDS[name]);
  const url = `${base}/api/v1/scans/${IDS[name]}?token=${encodeURIComponent(token)}`;
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,7200', '--virtual-time-budget=20000',
    `--screenshot=${path.join(OUT, `report-${name}-desktop.png`)}`, url],
    { stdio: 'ignore', timeout: 90000 });
  console.log(`${name}: report screenshot saved`);
}
server.close();
console.log('DONE');