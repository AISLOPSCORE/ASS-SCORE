/**
 * Report width fix proof — boot the REAL app with fixture rows (clean 7 + sloppy 89),
 * then render the token'd paid report HTML through the real report renderer and:
 *  (1) measure the fluid container via CDP (Emulation.setDeviceMetricsOverride) at
 *      viewports 390 / 768 / 1024 / 1440 / 1920 / 2560:
 *      body width, #dashboard width, first .finding-card width,
 *      matchMedia('(max-width: 640px)'), documentElement scrollWidth vs clientWidth
 *      (NO horizontal overflow at any width);
 *  (2) capture full-page 1440px-wide screenshots of the sloppy + clean reports.
 * Note: chromium's CLI --window-size clamps to min 500px wide; CDP emulation
 * override is used so 390 is measured at exactly 390 CSS px.
 * Writes measurements + PNGs under /home/team/shared/report-width-fix/.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { validateUrl } from '../src/fetch/ssrf.js';
import { createReportToken } from '../src/paywall.js';
import { openDb } from '../src/db.js';

const SECRET = 'width-proof-secret';
const OUT = '/home/team/shared/report-width-fix';
const STATIC = fs.mkdtempSync(path.join(os.tmpdir(), 'width-proof-static-'));
const CHROME = '/usr/local/bin/chromium';
const CDP_PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(STATIC, 'assets'), { recursive: true });
fs.copyFileSync(
  fileURLToPath(new URL('../src/assets/donkey-dashboard.png', import.meta.url)),
  path.join(STATIC, 'assets', 'donkey-dashboard.png'),
);
// ---- fixtures (same as render-cleanup-proof.mjs) -------------------------
const fakeFetcher = () => ({ fetchHtml: async () => ({ status: 200, url: 'https://fixture.example/', body: '<html><body><p>x</p></body></html>' }) });
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'width-proof-')), 'test.db');
const app = createApp({ dbPath, fetcher: fakeFetcher(), validateTarget: async (raw) => validateUrl(raw), maxScansPerDay: 0, reportTokenSecret: SECRET, publicBaseUrl: 'https://www.ass-score.com' });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
async function mk(id, score, breakdown) {
  const repo = openDb(dbPath);
  repo.insertScan({ id, url: 'https://fixture.example/', score, breakdown, createdAt: '2026-09-23T09:00:00.000Z' });
  repo.close();
}
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
  filler: { score: 88, findings: ['3\u00d7 "cutting-edge"', '2\u00d7 "seamless"'] },
  boilerplate: { score: 62, findings: ['2\u00d7 generic "learn more" CTA', '1 boilerplate signal in 300 words (0.5 per 300 words)'] },
  infoDensity: { score: 90, findings: ['concrete specifics: 0 found in 500 words \u2014 no dates, numbers, prices, percentages, or named references (need at least 7 per 75 words)'] },
  repetitive: { score: 30, findings: ['repeated sentence openings: 5\u00d7 "the company"'] },
  crossPage: { score: null, findings: [], note: 'insufficient pages for cross-page analysis' },
  fingerprints: { score: 0, findings: [] },
  assets: { score: 82, findings: ['2 of 2 images from stock/placeholder CDNs'] },
};
const IDS = { clean: 'c1111111-1111-4111-8111-111111111111', sloppy: 'c2222222-2222-4222-8222-222222222222' };
await mk(IDS.clean, 7, CLEAN);
await mk(IDS.sloppy, 89, SLOPPY);

// ---- fetch token'd report HTML through the real renderer -----------------
const htmls = {};
for (const [name, id] of Object.entries(IDS)) {
  const token = createReportToken(SECRET, id);
  const res = await fetch(`${base}/api/v1/scans/${id}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' } });
  if (res.status !== 200) throw new Error(`${name} report ${res.status}`);
  htmls[name] = await res.text();
  fs.writeFileSync(path.join(STATIC, `report-${name}.html`), htmls[name]);
}

// ---- tiny static server for the rendered pages ---------------------------
const staticServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const file = path.join(STATIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(STATIC) || !fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  const html = file.endsWith('.html');
  res.writeHead(200, { 'content-type': html ? 'text/html; charset=utf-8' : 'image/png' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => staticServer.listen(0, r));
const staticBase = `http://127.0.0.1:${staticServer.address().port}`;

// ---- launch chromium with CDP --------------------------------------------
const chromeProc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/width-proof-cdp-profile',
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });
async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('chromium CDP did not come up');
}
const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- measure at all 6 viewports ------------------------------------------
const VIEWPORTS = [390, 768, 1024, 1440, 1920, 2560];
const results = { sloppy: {}, clean: {} };
const MEASURE_EXPR = `(() => {
  const de = document.documentElement, body = document.body;
  const dash = document.getElementById('dashboard');
  const card = document.querySelector('.finding-card');
  return {
    innerW: window.innerWidth, innerH: window.innerHeight,
    deClientW: de.clientWidth, deScrollW: de.scrollWidth,
    bodyRectW: Math.round(body.getBoundingClientRect().width),
    dashRectW: dash ? Math.round(dash.getBoundingClientRect().width) : null,
    cardRectW: card ? Math.round(card.getBoundingClientRect().width) : null,
    mqMobile: window.matchMedia('(max-width: 640px)').matches,
    docScrollH: de.scrollHeight,
    overflowX: de.scrollWidth > de.clientWidth,
  };
})()`;
async function measure(name, width) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${staticBase}/report-${name}.html` });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (st.result.value === 'complete') break;
  }
  await sleep(600); // let webfonts/layout settle
  const ev = await cdp('Runtime.evaluate', { expression: MEASURE_EXPR, returnByValue: true });
  if (ev.exceptionDetails) throw new Error(`measure eval failed: ${JSON.stringify(ev.exceptionDetails)}`);
  const m = ev.result.value;
  if (m.innerW !== width) throw new Error(`${name}@${width}: expected viewport ${width}, got ${m.innerW}`);
  return m;
}
for (const w of VIEWPORTS) {
  results.sloppy[w] = await measure('sloppy', w);
  console.log(`measured ${w}: sloppy`, JSON.stringify(results.sloppy[w]));
  results.clean[w] = await measure('clean', w);
  console.log(`measured ${w}: clean`, JSON.stringify(results.clean[w]));
}

// ---- full-page 1440 screenshots ------------------------------------------
const shots = [];
for (const name of ['sloppy', 'clean']) {
  const sh = results[name][1440].docScrollH;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${staticBase}/report-${name}.html` });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (st.result.value === 'complete') break;
  }
  await sleep(2500); // webfonts + lazy donkey image paint
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, `report-${name}-desktop1440.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const info = await cdp('Runtime.evaluate', { expression: `({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})`, returnByValue: true });
  shots.push([name, file, info.result.value]);
  console.log(`shot ${file} (content ${info.result.value.w}x${info.result.value.h}, capture beyond viewport)`);
}

// ---- write measurements.txt ----------------------------------------------
const lines = [];
lines.push('REPORT WIDTH FIX \u2014 MEASURED RESULTS');
lines.push('date: 2026-09-23 | tool: headless chromium 153 (CDP, Emulation.setDeviceMetricsOverride) against the');
lines.push('REAL token\'d paid report rendered by the local app (fixtures: clean = 7/100 CLEANEST,');
lines.push('sloppy = 89/100 EXTREMELY ASS). CLI --window-size clamps to 500px min; CDP emulation is used');
lines.push('so the 390 row is measured at exactly 390 CSS px (mobile layout branch).');
lines.push('CSS under test (src/routes/scans.js renderHtmlReport <style>, body rule):');
lines.push('  body { ... max-width: min(1280px, calc(100% - 2.5rem)); margin: 0 auto; padding: 2rem 1.25rem 4rem; ... overflow-x: clip; }');
lines.push('  @media (max-width: 640px) branch unchanged; all 78ch prose caps (.fc-roast/.fc-why/.fc-fix/');
lines.push('  .fix-action/.final-note/.conclusion), category grid, and section/card classes unchanged.');
lines.push('');
lines.push('Expected: desktop 1440+ -> 1280px centered (~11% margins); 1024/tablet -> fluid full-width;');
lines.push('mobile <=640 -> existing mobile branch; NO horizontal overflow anywhere.');
lines.push('');
for (const name of ['sloppy', 'clean']) {
  lines.push(`== fixture: ${name} ==`);
  lines.push('viewport   body w.   #dashboard   .finding-card   mq(<=640)   scrollW == clientW   overflowX   note');
  for (const w of VIEWPORTS) {
    const r = results[name][w];
    const note = w <= 640 ? 'mobile layout (mq on)' : (w >= 1440 ? 'capped 1280' : 'fluid');
    lines.push(
      `${String(w).padEnd(10)} ${String(r.bodyRectW).padEnd(9)} ${String(r.dashRectW).padEnd(12)} ${String(r.cardRectW).padEnd(15)} ` +
      `${String(r.mqMobile).padEnd(10)} ${String(`${r.deScrollW} == ${r.deClientW}`).padEnd(17)} ${String(r.overflowX).padEnd(10)} ${note}`,
    );
  }
  lines.push('');
}
const failures = [];
for (const name of ['sloppy', 'clean']) {
  for (const w of VIEWPORTS) {
    const r = results[name][w];
    if (r.deScrollW !== r.deClientW) failures.push(`${name}@${w}: horizontal overflow (${r.deScrollW} > ${r.deClientW})`);
    if (r.overflowX) failures.push(`${name}@${w}: overflowX flag true`);
    if (w >= 1440 && r.bodyRectW !== 1280) failures.push(`${name}@${w}: expected 1280 body, got ${r.bodyRectW}`);
    if (w === 1024 && r.bodyRectW > 1010) failures.push(`${name}@1024: not fluid-ish (body ${r.bodyRectW})`);
    if (w <= 640 && !r.mqMobile) failures.push(`${name}@${w}: mobile media query should match`);
    if (w > 640 && r.mqMobile) failures.push(`${name}@${w}: mobile media query should NOT match`);
  }
}
lines.push(failures.length === 0
  ? 'OVERFLOW CHECK: PASS \u2014 documentElement.scrollWidth === clientWidth at every viewport (no horizontal overflow).'
  : 'OVERFLOW CHECK: FAILURES\n' + failures.join('\n'));
lines.push('');
lines.push('Screenshots (full-page, 1440px wide): report-sloppy-desktop1440.png, report-clean-desktop1440.png');
fs.writeFileSync(path.join(OUT, 'measurements.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));

ws.close();
chromeProc.kill('SIGTERM');
staticServer.close();
server.close();
process.exit(failures.length === 0 ? 0 : 1);