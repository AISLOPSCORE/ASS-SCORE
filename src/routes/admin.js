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
 * Response (200, password correct):
 *   { views: { total, today, last30d: [{date, count} x30], recent: [{ts, ip,
 *     ua, path} x latest 50] }, scans: { total, today, last30d: x30 } }
 *
 * Date bucketing uses the app's UTC-day convention (the ledgers derive day =
 * first 10 chars of the ISO timestamp; page_views ts is epoch ms, bucketed
 * via SQLite datetime(ts/1000,'unixepoch') = the same UTC view).
 * last30d is oldest-first (29 days ago .. today) so the table reads naturally
 * top-to-bottom; `recent` is newest-first.
 */
const DAY_MS = 86_400_000;
const DAYS_IN_WINDOW = 30;

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
    return res.json({
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
    });
  });
  return r;
}