import crypto, { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { validateEmail } from '../email.js';
import { toPublicScan, publicScore } from '../serialize.js';
import { isReportExpired } from '../ttl.js';
import { runScan } from '../scan.js';
import { validateUrl, resolveAndCheck, SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { verdictLabel, scoreColor } from '../verdict.js';
import { buildCardSvg, renderCardPng } from '../card.js';

/**
 * Private admin stats page — GET /admin/stats (backend origin only, NOT under
 * /api/v1; the site never calls it).
 *
 * Password gate: the value of env ADMIN_PASSWORD (injectable via
 * createApp({ adminPassword }) for the test suite). Accepts the password via
 * header `x-admin-password` or query `?pw=`, compared with
 * crypto.timingSafeEqual (length guard first — never a plain string compare).
 * While ADMIN_PASSWORD is unset the route is disabled and ALWAYS 403 — the
 * owner sets the env var on Railway after deploy, so 403 here is intended.
 * The password itself is never logged (no logging in this route at all).
 *
 * Content negotiation: when the request's Accept header EXPLICITLY lists a
 * text/html media type (browsers — curl/API clients send a wildcard accept or
 * application/json and keep the JSON), the same route renders a server-side
 * dark-themed dashboard (inline <style> only, no client fetch, no CDN, no JS
 * framework; timestamps are formatted server-side). The gate is identical for
 * both response types and the 403 branch is ALWAYS JSON — a wrong/missing
 * password can never produce HTML.
 *
 * Response (200, password correct):
 *   { views: { total, today, last30d: [{date, count} x30], recent: [{ts, ip,
 *     ua, path} x latest 50] }, scans: { total, today, last30d: x30 },
 *     purchases: { total, today, last30d: x30 } }
 * (the JSON shape is additive — views/scans untouched; the HTML page is a
 * rendering of that object)
 *
 * `purchases` is the paid-order ledger (webhook_events — one row per accepted
 * full-report order, any status), the same source of truth the webhook route
 * writes to; nothing is fetched from Stripe. Date bucketing uses the app's UTC-day convention (the ledgers derive day =
 * first 10 chars of the ISO timestamp; page_views ts is epoch ms, bucketed
 * via SQLite datetime(ts/1000,'unixepoch') = the same UTC view).
 * last30d is oldest-first (29 days ago .. today) so the table reads naturally
 * top-to-bottom; `recent` is newest-first.
 */
const DAY_MS = 86_400_000;
const DAYS_IN_WINDOW = 30;
/** Bar area height in px — bar heights are computed as % of this, min 1px. */
const CHART_HEIGHT_PX = 150;
/** Server-rendered table truncates the UA to ~48 chars; full value in title. */
const UA_DISPLAY_MAX = 48;

// Brand palette — dark navy theme, accent colors from the A.S.S. Score
// verdict bands (single source of truth for the page, duplicated only here).
const BANDS = {
  red: '#f87171',
  deepOrange: '#f97316',
  orange: '#fb923c',
  yellow: '#facc15',
  lime: '#a3e635',
  green: '#4ade80',
};

/** HTML-escape every dynamic value — never interpolate a raw string. */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Epoch ms -> "YYYY-MM-DD HH:MM" in the server's local time (the admin box). */
function fmtLocalTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Pure-CSS grouped bar chart + recent-views table, fully server-rendered. */
function renderAdminPage(stats, generatedAt, opts = {}) {
  const { views, scans, purchases } = stats;
  const hasViews = views.total > 0 || views.recent.length > 0 || views.last30d.some((d) => d.count > 0);
  // EPOCAH CUTOVER (owner 2026-10-07): show the counting floor + the reset
  // button. epoch null (fresh/dev DBs) => header says all time, no cutover yet.
  const epoch = typeof opts.epoch === 'string' && opts.epoch !== '' ? opts.epoch : null;
  const resetAction = typeof opts.resetAction === 'string' ? opts.resetAction : '/admin/stats/reset';
  const epochLine = epoch
    ? `<br>Tracking since ${esc(epoch.slice(0, 16).replace('T', ' '))} UTC`
    : '<br>Tracking: all time — no cutover yet';
  const pwNote =
    resetAction.includes('pw=')
      ? ''
      : '<div class="reset-note">Opened with header auth — to use the reset button, open this page with <code>?pw=…</code> appended.</div>';

  // Normalize each series to its own max; min 1px so zero days show a hairline.
  const scanMax = Math.max(0, ...scans.last30d.map((d) => d.count));
  const viewMax = Math.max(0, ...views.last30d.map((d) => d.count));
  const purchaseMax = Math.max(0, ...purchases.last30d.map((d) => d.count));
  const barHeight = (count, max) => (max > 0 ? Math.max(1, Math.round((count / max) * CHART_HEIGHT_PX)) : 1);

  const chartCells = scans.last30d
    .map((scanDay, i) => {
      const viewDay = views.last30d[i];
      const purchaseDay = purchases.last30d[i];
      const tick = i % 5 === 0 ? `<span class="tick">${esc(scanDay.date.slice(5))}</span>` : '';
      return [
        `<div class="day" title="${esc(`${scanDay.date} — scans ${scanDay.count}, views ${viewDay.count}, reports ${purchaseDay.count}`)}">`,
        `<div class="bars">`,
        `<div class="bar bar-scans" style="height:${barHeight(scanDay.count, scanMax)}px" title="${esc(`${scanDay.date} · ${scanDay.count} scans`)}"></div>`,
        `<div class="bar bar-views" style="height:${barHeight(viewDay.count, viewMax)}px" title="${esc(`${viewDay.date} · ${viewDay.count} views`)}"></div>`,
        `<div class="bar bar-reports" style="height:${barHeight(purchaseDay.count, purchaseMax)}px" title="${esc(`${purchaseDay.date} · ${purchaseDay.count} reports`)}"></div>`,
        `</div>`,
        tick,
        `</div>`,
      ].join('');
    })
    .join('');

  const tableRows = views.recent
    .map(
      (v) => `<tr>
        <td class="col-time">${esc(fmtLocalTime(v.ts))}</td>
        <td class="col-ip">${esc(v.ip)}</td>
        <td class="col-path" title="${esc(v.path)}">${esc(v.path)}</td>
        <td class="col-ua" title="${esc(v.ua)}">${esc(truncate(v.ua, UA_DISPLAY_MAX))}</td>
      </tr>`
    )
    .join('');

  const empty = `<div class="empty">No views recorded yet. Once the site beacon starts receiving hits, they'll show up here.</div>`;
  const chartBlock = hasViews ? `<div class="chart">${chartCells}</div>` : empty;
  const tableBlock = hasViews
    ? `<div class="tablewrap"><table>
        <thead><tr><th>Time</th><th>IP</th><th>Path</th><th>User agent</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>`
    : empty;

  const kpi = (label, value, color) => `<div class="kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value" style="color:${color}">${value}</span>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>A.S.S. Score — Admin Stats</title>
<style>
:root{--bg:${'#0b0f19'};--card:${'#151b2b'};--border:${'#232c3f'};--text:${'#e2e8f0'};--muted:${'#8b9bb4'};
--red:${BANDS.red};--deepOrange:${BANDS.deepOrange};--orange:${BANDS.orange};--yellow:${BANDS.yellow};--lime:${BANDS.lime};--green:${BANDS.green}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.page{max-width:1100px;margin:0 auto;padding:32px 20px 48px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.brand{font-size:22px;font-weight:800;letter-spacing:.05em}
.brand .red{color:var(--red)}
.tag{font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:2px 10px;margin-left:8px;font-weight:700;color:var(--text);vertical-align:2px}
.gen{color:var(--muted);font-size:13px}
.gen time{font-variant-numeric:tabular-nums}
.top-meta{display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:100%}
.reset-form{margin:0}
.reset-btn{background:transparent;color:var(--yellow);border:1px solid var(--border);border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
.reset-btn:hover{border-color:var(--yellow);color:var(--yellow)}
.reset-note{color:var(--muted);font-size:11px;max-width:300px;text-align:right}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi-label{display:block;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.1em}
.kpi-value{display:block;font-size:34px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
.card h2{margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text)}
.legend{display:flex;gap:18px;align-items:center;color:var(--muted);font-size:12px;margin-bottom:10px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:-1px}
.sw-scans{background:var(--orange)}.sw-views{background:var(--green)}.sw-reports{background:var(--red)}
.chart{display:flex;align-items:flex-end;gap:2px}
.day{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0}
.bars{height:${CHART_HEIGHT_PX}px;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px}
.bar{width:100%;max-width:10px;border-radius:2px 2px 0 0}
.bar-scans{background:var(--orange)}.bar-views{background:var(--green)}.bar-reports{background:var(--red)}
.tick{font-size:9px;color:var(--muted);margin-top:4px;white-space:nowrap}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid ${'#1c2436'};white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tr:hover td{background:${'#1a2336'}}
.col-time{color:var(--muted)}
.col-ip{color:var(--yellow)}
.col-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--lime);max-width:340px;overflow:hidden;text-overflow:ellipsis}
.col-ua{color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--muted);font-size:13px;padding:26px 8px;text-align:center;border:1px dashed var(--border);border-radius:10px}
footer{margin-top:28px;color:${'#5b6b84'};font-size:12px;text-align:center;letter-spacing:.04em}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}.kpi-value{font-size:26px}}
</style>
</head>
<body>
<div class="page">
  <header class="top">
    <div class="brand"><span class="red">A.S.S. SCORE</span> — ADMIN <span class="tag">internal</span></div>
    <div class="top-meta">
      <div class="gen">Generated <time datetime="${esc(generatedAt)}">${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC</time>${epochLine}</div>
      <form class="reset-form" method="post" action="${esc(resetAction)}">
        <button class="reset-btn" type="submit" title="Restart tracking from now: every admin-stats counter goes to zero. Existing rows stay in the database — they just stop being counted.">↺ Restart stats tracking</button>
      </form>
      ${pwNote}
    </div>
  </header>
  <section class="kpis">
    ${kpi('SCANS TOTAL', scans.total, BANDS.red)}
    ${kpi('SCANS TODAY', scans.today, BANDS.deepOrange)}
    ${kpi('VIEWS TOTAL', views.total, BANDS.orange)}
    ${kpi('VIEWS TODAY', views.today, BANDS.green)}
    ${kpi('FULL REPORTS PURCHASED', purchases.total, BANDS.red)}
    ${kpi('REPORTS TODAY', purchases.today, BANDS.red)}
  </section>
  <section class="card">
    <h2>Last 30 days</h2>
    <div class="legend"><span class="sw sw-scans"></span>Scans&nbsp;<span class="sw sw-views"></span>Views&nbsp;<span class="sw sw-reports"></span>Reports</div>
    ${chartBlock}
  </section>
  <section class="card">
    <h2>Recent views <span class="gen">(${views.recent.length})</span></h2>
    ${tableBlock}
  </section>
  <footer>Internal tool — ass-score.com</footer>
</div>
</body>
</html>`;
}

/**
 * Download filename slug for the share card — mirrors the site's domainSlug()
 * exactly (site/src/routes/index.tsx): hostname without a leading www., dots
 * replaced with dashes. Same URL -> same download name on every surface.
 */
function domainSlug(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '-') || 'website';
  } catch {
    return 'website';
  }
}

/**
 * Shared shell for the admin share-card pages (form + result) — the same dark
 * navy design language as the stats dashboard (same variables/palette, kept
 * self-contained, inline <style> only, no JS, no external assets; noindex).
 */
function shareCardPage({ title, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
:root{--bg:${'#0b0f19'};--card:${'#151b2b'};--border:${'#232c3f'};--text:${'#e2e8f0'};--muted:${'#8b9bb4'};
--red:${BANDS.red};--deepOrange:${BANDS.deepOrange};--orange:${BANDS.orange};--yellow:${BANDS.yellow};--lime:${BANDS.lime};--green:${BANDS.green}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.page{max-width:820px;margin:0 auto;padding:32px 20px 48px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.brand{font-size:22px;font-weight:800;letter-spacing:.05em}
.brand .red{color:var(--red)}
.tag{font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:2px 10px;margin-left:8px;font-weight:700;color:var(--text);vertical-align:2px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
.card h1{margin:0 0 6px;font-size:20px;font-weight:800;letter-spacing:.02em}
.hint{color:var(--muted);font-size:13px;margin:0 0 16px}
label{display:block;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px}
input[type=url]{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:${'#0d1322'};color:var(--text);font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
input[type=url]:focus{outline:2px solid var(--yellow);border-color:var(--yellow)}
button{display:inline-block;background:var(--yellow);color:${'#0b0f19'};border:0;border-radius:10px;padding:12px 22px;font-size:14px;font-weight:800;letter-spacing:.06em;cursor:pointer;margin-top:14px}
button:hover{background:${'#fde047'}}
.error{background:rgba(248,113,113,.12);border:1px solid var(--red);color:${'#fecaca'};border-radius:10px;padding:12px 14px;margin:0 0 16px;font-size:13px;overflow-wrap:anywhere}
.host{font-size:15px;margin:0;overflow-wrap:anywhere}
.host a{color:var(--lime)}
.score-label{display:block;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:16px 0 6px}
.score{display:block;font-size:52px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.verdict{display:inline-block;font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;padding:6px 16px;margin-top:10px;color:${'#0b0f19'}}
.card-img{max-width:100%;height:auto;border:1px solid var(--border);border-radius:12px;margin-top:16px;display:block}
.rc-ghost{display:inline-block;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px 22px;font-size:14px;font-weight:700;letter-spacing:.04em;cursor:pointer;margin:18px 12px 0 0;text-decoration:none;transition:border-color .15s ease,color .15s ease}
.rc-ghost:hover{border-color:var(--yellow);color:var(--yellow)}
.note{color:${'#5b6b84'};font-size:12px;margin:14px 0 0}
.note code{color:${'#8b9bb4'}}
a.again{color:var(--muted);font-size:13px;text-decoration:none;border-bottom:1px dotted var(--border)}
footer{margin-top:28px;color:${'#5b6b84'};font-size:12px;text-align:center;letter-spacing:.04em}
@media (max-width:640px){.score{font-size:40px}}
</style>
</head>
<body>
<div class="page">
  <header class="top">
    <div class="brand"><span class="red">A.S.S. SCORE</span> — ADMIN <span class="tag">internal</span></div>
  </header>
  ${bodyHtml}
  <footer>Internal tool — ass-score.com</footer>
</div>
</body>
</html>`;
}

/** The form the browser submits — carries ?pw= when the request came in with it. */
function renderShareCardForm({ action, error = null, urlValue = '' }) {
  const err = error ? `<div class="error">${esc(error)}</div>` : '';
  const pwNote = action.includes('pw=')
    ? ''
    : '<p class="note">No password embedded in this form — a header-authenticated client (curl/XHR) must supply <code>x-admin-password</code> on the POST. If you opened this page with a header, append <code>?pw=…</code> to the URL to make the browser form work.</p>';
  return shareCardPage({
    title: 'Generate Share Card',
    bodyHtml: `<section class="card">
  <h1>Generate Share Card</h1>
  <p class="hint">Runs a full real scan through the same engine the public flow uses (same detectors, same scoring) and generates the downloadable share-card image. Admin scans never appear on public routes and never move the public counters.</p>
  ${err}
  <form method="post" action="${esc(action)}">
    <label for="url">Website URL</label>
    <input type="url" id="url" name="url" placeholder="https://example.com" value="${esc(urlValue)}" required />
    <button type="submit">Generate</button>
  </form>
  <p class="note">The scan can take up to ~30 seconds.</p>
  ${pwNote}
</section>`,
  });
}

/** Result page — score + verdict + card image + the download button. */
function renderShareCardResult({ url, score, verdict, cardPath, downloadName }) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* fall back to the raw url */
  }
  return shareCardPage({
    title: 'Share Card — generated',
    bodyHtml: `<section class="card">
  <h1>Share card generated</h1>
  <p class="host"><a href="${esc(url)}">${esc(host)}</a></p>
  <span class="score-label">A.S.S. Score (0 = clean · 100 = maximum ass)</span>
  <span class="score" style="color:${scoreColor(score)}">${publicScore(score)}</span>
  <span class="verdict" style="background:${scoreColor(score)}">${esc(verdict)}</span>
  <img class="card-img" src="${esc(cardPath)}" alt="A.S.S. Score share card for ${esc(host)}" width="1600" height="900" />
  <a class="rc-ghost" href="${esc(cardPath)}" download="${esc(downloadName)}">Download Share Card</a>
  <a class="again" href="/admin/share-card">← Generate another</a>
</section>`,
  });
}

/** POST /admin/stats/reset confirmation page (EPOCAH CUTOVER, owner 2026-10-07). */
function renderResetConfirmation({ epoch, backAction }) {
  return shareCardPage({
    title: 'Stats tracking reset',
    bodyHtml: `<section class="card">
  <h1>Tracking reset</h1>
  <p class="hint">All admin-stats counters now start at this moment. Existing rows stay in the database untouched — they just stop being counted.</p>
  <span class="score-label">Tracking since</span>
  <p class="host">${esc(epoch.slice(0, 16).replace('T', ' '))} UTC</p>
  <a class="rc-ghost" href="${esc(backAction)}">← Back to admin stats</a>
</section>`,
  });
}

export function adminRouter({ db, adminPassword, emailSender, now = () => new Date().toISOString(), fetcher, validateTarget, scanBudgetMs } = {}) {
  const secret = adminPassword ?? process.env.ADMIN_PASSWORD;
  const r = Router();
  // The share-card tool is a plain HTML form, so this router parses
  // application/x-www-form-urlencoded bodies (app-level is JSON-only; scoped
  // here so the rest of the API keeps JSON-only semantics). express.json has
  // already run app-wide: a JSON POST body still lands parsed in req.body and
  // urlencoded skips non-urlencoded content types.
  r.use(express.urlencoded({ extended: false }));
  const forbidden = (res) => res.status(403).json({ error: { code: 'forbidden' } });
  const secretOk = (candidate) => {
    if (typeof secret !== 'string' || typeof candidate !== 'string') return false;
    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
    return crypto.timingSafeEqual(a, b);
  };
  // Browsers send "Accept: text/html,..." explicitly; curl and undici's fetch
  // send */* (which does NOT literally contain a text/html token). Only an
  // explicit text/html media type gets the dashboard — every other client
  // (existing tests, API consumers, plain curl) keeps the exact JSON.
  const wantsHtml = (req) =>
    (req.get('accept') ?? '')
      .split(',')
      .some((part) => part.trim().split(';')[0].toLowerCase() === 'text/html');
  r.get('/admin/stats', (req, res) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);
    // EPOCAH CUTOVER (owner 2026-10-07): `stats_epoch` (settings table) is the
    // counting floor for EVERY admin-stats counter. Absent (fresh/dev DBs, or
    // prod before the cutover runs) => no filtering, byte-identical to before.
    // When set, each query's effective floor is MAX(its own window start, the
    // epoch) — pre-epoch rows can never re-appear in any bucket, and rows are
    // NEVER deleted (paid report links point at scans rows).
    const epochIso = db.getSetting('stats_epoch'); // ISO string | null
    const epochMs = epochIso ? Date.parse(epochIso) : null;
    const today = now().slice(0, 10); // UTC day
    const todayStartMs = Date.parse(`${today}T00:00:00.000Z`);
    const sinceTs = todayStartMs - (DAYS_IN_WINDOW - 1) * DAY_MS;
    const sinceIso = new Date(sinceTs).toISOString().slice(0, 10); // scans/webhook_events created_at >= date
    // Effective floors — the epoch wins where it is later than the query's
    // own window start (day series: MAX(sinceParam, epoch); today: MAX(midnight, epoch)).
    const viewFloorTs = epochMs !== null ? Math.max(sinceTs, epochMs) : sinceTs;
    const todayViewFloorTs = epochMs !== null ? Math.max(todayStartMs, epochMs) : todayStartMs;
    const ledgerFloorIso = epochIso && epochIso > sinceIso ? epochIso : sinceIso;
    const viewCounts = new Map(db.pageViewDayCounts(viewFloorTs).map((d) => [d.date, d.count]));
    const scanCounts = new Map(db.scanDayCounts(ledgerFloorIso).map((d) => [d.date, d.count]));
    const purchaseCounts = new Map(db.webhookDayCounts(ledgerFloorIso).map((d) => [d.date, d.count]));
    const last30dViews = [];
    const last30dScans = [];
    const last30dPurchases = [];
    for (let i = DAYS_IN_WINDOW - 1; i >= 0; i--) {
      const date = new Date(todayStartMs - i * DAY_MS).toISOString().slice(0, 10);
      last30dViews.push({ date, count: viewCounts.get(date) ?? 0 });
      last30dScans.push({ date, count: scanCounts.get(date) ?? 0 });
      last30dPurchases.push({ date, count: purchaseCounts.get(date) ?? 0 });
    }
    const stats = {
      views: {
        total: db.countPageViews(epochMs),
        today: db.countPageViewsSince(todayViewFloorTs),
        last30d: last30dViews,
        recent: db.recentPageViews(epochMs),
      },
      scans: {
        total: db.countScansTotal(epochIso),
        today: db.countScansToday(today, epochIso),
        last30d: last30dScans,
      },
      purchases: {
        total: db.countWebhooksTotal(epochIso),
        today: db.countWebhooksToday(today, epochIso),
        last30d: last30dPurchases,
      },
    };
    if (wantsHtml(req)) {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(renderAdminPage(stats, now(), { epoch: epochIso, resetAction: statsResetAction(req) }));
    }
    return res.json(stats);
  });

  /**
   * POST /admin/stats/reset — the EPOCAH CUTOVER (owner 2026-10-07). Sets
   * `stats_epoch` = now(): every admin-stats counter restarts at zero from
   * this moment while ALL existing rows stay in the database, untouched (paid
   * report links point at `scans` rows — deleting data is off the table).
   * Idempotent: a second reset just moves the epoch later; rows before the old
   * epoch stay excluded forever. Only the audit trail remembers it happened.
   *
   * Same gate as GET /admin/stats (x-admin-password header or ?pw=, compared
   * with timingSafeEqual); wrong/missing password => the same 403 JSON. JSON
   * accept -> { ok: true, epoch }; text/html accept (browser form) -> a small
   * confirmation page rendered with the standard admin theme. No body is
   * read — the button can be a plain form, and API clients need no payload.
   */
  r.post('/admin/stats/reset', (req, res) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);
    const epoch = now();
    db.setSetting('stats_epoch', epoch);
    // Audit trail — best-effort, exactly the existing audit-write pattern
    // (insertAdminAudit wrapped in try/catch): a reset row with empty url and
    // verdict 'stats_reset' joins the share-card trail and survives forever
    // (retention never purges admin_audit).
    try {
      db.insertAdminAudit({
        id: randomUUID(),
        scanId: null,
        actor: 'admin',
        ip: req.ip,
        url: '',
        score: 0,
        verdict: 'stats_reset',
        createdAt: epoch,
      });
    } catch (err) {
      console.error('[admin] audit insert failed:', err);
    }
    if (wantsHtml(req)) {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(renderResetConfirmation({ epoch, backAction: statsBackAction(req) }));
    }
    return res.json({ ok: true, epoch });
  });

  /**
   * POST /admin/deliver — manual report fulfillment (built 2026-09-25).
   *
   * Sends the token'd full-report email for an EXISTING scan to a given
   * address, using the SAME delivery path the webhook fulfillment uses
   * (emailSender builds the HMAC report link internally). This is how
   * bare-link purchases recorded in `unmatched_orders` get fulfilled once the
   * customer names their site — the owner's own 09-24 purchase, for example.
   *
   * Same password gate as GET /admin/stats (x-admin-password header or ?pw=,
   * timingSafeEqual); disabled (always 403) until ADMIN_PASSWORD is set.
   *
   * Contract (all gated):
   *   200 { delivered: boolean, scanId, email, note? } — email attempt made;
   *      delivery itself is best-effort like every other sender call, so a
   *      not-configured email transport still resolves 200 with note
   *   200 { delivered: false, ..., note: 'report link expired …' } — the scan
   *      exists but is past its 30-day report window (src/ttl.js); NO email is
   *      sent. The scan row is preserved by retention, so this is not an error.
   *   404 not_found — scanId does not exist
   *   400 invalid_scan_id / invalid_email — bad input
   *   403 forbidden — missing/wrong admin password
   */
  r.post('/admin/deliver', async (req, res) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);

    const body = req.body ?? {};
    const scanId = typeof body.scanId === 'string' ? body.scanId : '';
    if (scanId.trim() === '') {
      return res.status(400).json({ error: { code: 'invalid_scan_id', message: 'scanId is required' } });
    }
    const scan = db.getScan(scanId);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${scanId}"` } });
    }
    // ACCESS WINDOW (owner-approved preserve-data/expire-access): a scan past
    // its 30-day report window (fixed to scan.created_at — src/ttl.js) can no
    // longer be re-sent — the report link has expired for the buyer. The scan
    // row IS preserved (retention exemption), so this is a soft 200 note, NOT
    // an error, and the email sender is never called.
    if (isReportExpired(scan, now())) {
      return res.status(200).json({
        delivered: false,
        scanId: scan.id,
        email: typeof body.email === 'string' ? body.email : null,
        note: 'report link expired — scan preserved, but the 30-day access window has passed',
      });
    }
    const mail = validateEmail(body.email);
    if (!mail.ok || mail.email === null) {
      return res.status(400).json({
        error: { code: 'invalid_email', message: mail.email === null ? 'email is required' : mail.message },
      });
    }

    // Best-effort delivery, exact same soft-fail semantics as the webhook:
    // the sender never rejects, so the response is always 200 once input
    // validation passed. reportTokenSecret is bound inside emailSender
    // (createApp builds it with the configured secret).
    let delivered = false;
    let note = null;
    try {
      if (emailSender) {
        const result = await emailSender(toPublicScan(scan), mail.email);
        delivered = result?.ok === true;
        if (!delivered) note = 'email transport did not confirm delivery (see logs)';
      } else {
        note = 'email not configured';
      }
    } catch (err) {
      // Defensive: senders are built to never reject, but a broken injected
      // stub must not 500 the admin endpoint either.
      note = `delivery crashed: ${err?.message ?? err}`;
      console.error(`[admin] deliver to ${mail.email} for scan ${scanId} crashed:`, err);
    }
    return res.status(200).json({ delivered, scanId: scan.id, email: mail.email, ...(note ? { note } : {}) });
  });

  // --- Generate Share Card tool (owner request 2026-10-01) -------------------
  // GET/POST /admin/share-card + GET /admin/share-card/:scanId/card. Runs a
  // FULL REAL scan through the shared engine (same detectors + scoring as the
  // public flow — runScan called DIRECTLY, never POST /api/v1/scan, so the
  // public scan_events rate-limit ledger is untouched), marks the row internal
  // (excluded from every public route + the admin-stats counts), appends an
  // admin_audit trail row (never purged by retention), and outputs ONLY the
  // share card — the exact buildCardSvg/renderCardPng the public card route
  // uses, byte-identical design. Same password gate as /admin/stats; the 403
  // branch is ALWAYS JSON.
  //
  // The SSRF guard is the SAME checkTarget the public scan router runs
  // (injected from app.js: validateUrl + resolveAndCheck), applied BEFORE the
  // scan — blocked targets map exactly like runScan's own errors.
  const checkTarget = validateTarget ?? (async (raw) => {
    const url = validateUrl(raw);
    await resolveAndCheck(url);
    return url;
  });
  /** Form action — carries ?pw= when the request came in with the query auth. */
  const formAction = (req) =>
    typeof req.query.pw === 'string' && req.query.pw !== ''
      ? `/admin/share-card?pw=${encodeURIComponent(req.query.pw)}`
      : '/admin/share-card';
  /** Stats-reset form action + confirmation back-link — carry ?pw= when the
   *  request came in with the query auth (mirrors formAction: a browser form
   *  cannot send the x-admin-password header, so the button embeds the pw). */
  const statsResetAction = (req) =>
    typeof req.query.pw === 'string' && req.query.pw !== ''
      ? `/admin/stats/reset?pw=${encodeURIComponent(req.query.pw)}`
      : '/admin/stats/reset';
  const statsBackAction = (req) =>
    typeof req.query.pw === 'string' && req.query.pw !== ''
      ? `/admin/stats?pw=${encodeURIComponent(req.query.pw)}`
      : '/admin/stats';

  /**
   * GET /admin/share-card — the tool's form page (gated). Server-rendered,
   * dark admin theme, no JS, noindex; never cached (admin pages are private).
   */
  r.get('/admin/share-card', (req, res) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(renderShareCardForm({ action: formAction(req) }));
  });

  /**
   * POST /admin/share-card — run the scan and output the share card (gated).
   *
   * URL validation reuses the SAME validateTarget guard the public scan route
   * uses (validateUrl + resolveAndCheck — injected from app.js) BEFORE any
   * network I/O. runScan failures map like the public flow: 400 blocked /
   * 502 fetch_failed / 422 parse_failed. JSON accept -> { scanId, url, score,
   * verdict } (no card URL — admin-only surface); text/html accept (browser
   * form) -> the result page: host, band-colored score, verdict label, the
   * card image via /admin/share-card/:scanId/card, and the Download button.
   * On failure with HTML accept the form re-renders with the error inline.
   */
  r.post('/admin/share-card', async (req, res, next) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);

    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (rawUrl === '') {
      const message = 'URL is required';
      if (wantsHtml(req)) {
        return res.status(400).type('html').send(renderShareCardForm({ action: formAction(req), error: message }));
      }
      return res.status(400).json({ error: { code: 'invalid_request', message } });
    }

    // SSRF guard BEFORE scanning — same checkTarget the public scan router
    // runs; blocked targets never touch the DB or the audit trail.
    let target;
    try {
      target = await checkTarget(rawUrl);
    } catch (err) {
      if (err instanceof SsrfError || err instanceof InvalidUrlError) {
        if (wantsHtml(req)) {
          return res.status(400).type('html').send(renderShareCardForm({ action: formAction(req), error: err.message, urlValue: rawUrl }));
        }
        return res.status(400).json({ error: { code: 'blocked', message: err.message } });
      }
      throw err;
    }

    // Full real scan through the shared engine — internal: true marks the row
    // so every public read surface and the admin-stats counts exclude it.
    let result;
    try {
      result = await runScan({
        db,
        fetcher,
        url: target.href,
        now,
        scanBudgetMs,
        internal: true,
      });
    } catch (err) {
      next(err); // centralized error handler — genuine internal errors 500
      return;
    }
    if (!result.ok) {
      const { status, json } = result;
      const message = json?.error?.message ?? 'Scan failed';
      if (wantsHtml(req)) {
        return res.status(status).type('html').send(renderShareCardForm({ action: formAction(req), error: message, urlValue: rawUrl }));
      }
      return res.status(status).json(json);
    }

    const payload = result.payload;
    const scanId = payload.id;
    // Verdict = the SAME uppercase display label the report/API surfaces use
    // (src/verdict.js — verdictBand().shortLabel via verdictLabel()).
    const verdict = verdictLabel(payload.slopScore);
    // Audit trail (who/when/what/score+verdict). BEST-EFFORT: an audit
    // failure is logged and must never 500 the tool.
    try {
      db.insertAdminAudit({
        id: randomUUID(),
        scanId,
        actor: 'admin', // the tool has no per-user identity
        ip: req.ip,
        url: payload.url,
        score: payload.slopScore,
        verdict,
        createdAt: now(),
      });
    } catch (err) {
      console.error('[admin] audit insert failed:', err);
    }

    // The share card itself: EXACT same inputs as the public card route
    // (src/routes/scans.js) — buildCardSvg({ score: publicScore(scan.score),
    // url: scan.url }) + renderCardPng — so the bytes are identical in design.
    // Card URL — carries ?pw= when the request was authenticated by either
    // method (`candidate` above is already the checked auth value: header
    // first, then the query). The result page's <img> and Download href are
    // plain browser requests that CANNOT send the x-admin-password header,
    // so without the query the card route's gate 403s them and the image
    // renders broken. Mirrors formAction's carry-the-auth-on-the-URL
    // approach; header-auth curl/XHR clients get the same working URL.
    const cardPath =
      typeof candidate === 'string' && candidate !== ''
        ? `/admin/share-card/${scanId}/card?pw=${encodeURIComponent(candidate)}`
        : `/admin/share-card/${scanId}/card`;
    const downloadName = `ass-score-${domainSlug(payload.url)}.png`;
    if (wantsHtml(req)) {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(renderShareCardResult({
        url: payload.url,
        score: payload.slopScore,
        verdict,
        cardPath,
        downloadName,
      }));
    }
    return res.json({ scanId, url: payload.url, score: publicScore(payload.slopScore), verdict });
  });

  /**
   * GET /admin/share-card/:scanId/card — the gated card-image route (PNG).
   * Uses the EXACT public-card code path (buildCardSvg + renderCardPng), so
   * the design is byte-identical to the public share card. 404 JSON when the
   * scan id does not exist; Cache-Control private (admin tool only).
   */
  r.get('/admin/share-card/:scanId/card', async (req, res, next) => {
    if (!secret) return forbidden(res);
    const candidate = req.get('x-admin-password') ?? req.query.pw;
    if (!secretOk(candidate)) return forbidden(res);
    const scan = db.getScan(req.params.scanId);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.scanId}"` } });
    }
    try {
      const png = await renderCardPng(buildCardSvg({
        score: publicScore(scan.score), // public score = stored slop direction (higher = worse, 0 = clean)
        url: scan.url,
      }));
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(png);
    } catch (err) {
      next(err); // PNG render errors never leak internals
    }
  });

  return r;
}