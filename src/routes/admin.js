import crypto from 'node:crypto';
import { Router } from 'express';

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
 *     ua, path} x latest 50] }, scans: { total, today, last30d: x30 } }
 * (the JSON shape is unchanged; the HTML page is a rendering of that object)
 *
 * Date bucketing uses the app's UTC-day convention (the ledgers derive day =
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
function renderAdminPage(stats, generatedAt) {
  const { views, scans } = stats;
  const hasViews = views.total > 0 || views.recent.length > 0 || views.last30d.some((d) => d.count > 0);

  // Normalize each series to its own max; min 1px so zero days show a hairline.
  const scanMax = Math.max(0, ...scans.last30d.map((d) => d.count));
  const viewMax = Math.max(0, ...views.last30d.map((d) => d.count));
  const barHeight = (count, max) => (max > 0 ? Math.max(1, Math.round((count / max) * CHART_HEIGHT_PX)) : 1);

  const chartCells = scans.last30d
    .map((scanDay, i) => {
      const viewDay = views.last30d[i];
      const tick = i % 5 === 0 ? `<span class="tick">${esc(scanDay.date.slice(5))}</span>` : '';
      return [
        `<div class="day" title="${esc(`${scanDay.date} — scans ${scanDay.count}, views ${viewDay.count}`)}">`,
        `<div class="bars">`,
        `<div class="bar bar-scans" style="height:${barHeight(scanDay.count, scanMax)}px" title="${esc(`${scanDay.date} · ${scanDay.count} scans`)}"></div>`,
        `<div class="bar bar-views" style="height:${barHeight(viewDay.count, viewMax)}px" title="${esc(`${viewDay.date} · ${viewDay.count} views`)}"></div>`,
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
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi-label{display:block;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.1em}
.kpi-value{display:block;font-size:34px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
.card h2{margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text)}
.legend{display:flex;gap:18px;align-items:center;color:var(--muted);font-size:12px;margin-bottom:10px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:-1px}
.sw-scans{background:var(--orange)}.sw-views{background:var(--green)}
.chart{display:flex;align-items:flex-end;gap:2px}
.day{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0}
.bars{height:${CHART_HEIGHT_PX}px;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px}
.bar{width:100%;max-width:10px;border-radius:2px 2px 0 0}
.bar-scans{background:var(--orange)}.bar-views{background:var(--green)}
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
    <div class="gen">Generated <time datetime="${esc(generatedAt)}">${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC</time></div>
  </header>
  <section class="kpis">
    ${kpi('SCANS TOTAL', scans.total, BANDS.red)}
    ${kpi('SCANS TODAY', scans.today, BANDS.deepOrange)}
    ${kpi('VIEWS TOTAL', views.total, BANDS.orange)}
    ${kpi('VIEWS TODAY', views.today, BANDS.green)}
  </section>
  <section class="card">
    <h2>Last 30 days</h2>
    <div class="legend"><span class="sw sw-scans"></span>Scans&nbsp;<span class="sw sw-views"></span>Views</div>
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

export function adminRouter({ db, adminPassword, now = () => new Date().toISOString() } = {}) {
  const secret = adminPassword ?? process.env.ADMIN_PASSWORD;
  const r = Router();
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
    const today = now().slice(0, 10); // UTC day
    const todayStartMs = Date.parse(`${today}T00:00:00.000Z`);
    const sinceTs = todayStartMs - (DAYS_IN_WINDOW - 1) * DAY_MS;
    const sinceIso = new Date(sinceTs).toISOString().slice(0, 10); // scans.created_at >= date
    const viewCounts = new Map(db.pageViewDayCounts(sinceTs).map((d) => [d.date, d.count]));
    const scanCounts = new Map(db.scanDayCounts(sinceIso).map((d) => [d.date, d.count]));
    const last30dViews = [];
    const last30dScans = [];
    for (let i = DAYS_IN_WINDOW - 1; i >= 0; i--) {
      const date = new Date(todayStartMs - i * DAY_MS).toISOString().slice(0, 10);
      last30dViews.push({ date, count: viewCounts.get(date) ?? 0 });
      last30dScans.push({ date, count: scanCounts.get(date) ?? 0 });
    }
    const stats = {
      views: {
        total: db.countPageViews(),
        today: db.countPageViewsSince(todayStartMs),
        last30d: last30dViews,
        recent: db.recentPageViews(),
      },
      scans: {
        total: db.countScansTotal(),
        today: db.countScansToday(today),
        last30d: last30dScans,
      },
    };
    if (wantsHtml(req)) {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(renderAdminPage(stats, now()));
    }
    return res.json(stats);
  });
  return r;
}