import { Router } from 'express';
import { clientIp } from '../clientIp.js';

/**
 * Silent homepage-view beacon — POST /api/v1/track.
 *
 * The site fires this once per page load after hydration (client-only, never
 * visible, never logged by the site). This route records one row in
 * `page_views` per REAL human browser hit and answers 204 on every
 * non-error outcome so a beacon failure can never break the page:
 *
 *   - Empty / missing UA      -> 204 (not a browser)
 *   - Known bot/crawler UA    -> 204 (substring match, case-insensitive)
 *   - Same IP within 30s      -> 204 (in-memory dedup map, pruned per hit)
 *   - Success                 -> 204 (silent — the site never reads a body)
 *   - Anything throws         -> 204 (try/catch wrapper)
 *
 * The in-memory dedup map is the same style as the scanner's per-IP rate
 * limits (single-process synchronous = race-free): keyed by the exact client
 * IP derivation the ledgers use (src/clientIp.js —
 * req.ip behind the trust-proxy edge), never by forwarded strings we invent.
 */
const BOT_PATTERNS = [
  'googlebot', 'bingbot', 'baiduspider', 'yandex', 'duckduckbot', 'slurp',
  'facebookexternalhit', 'twitterbot', 'linkedinbot', 'discordbot', 'slackbot',
  'telegrambot', 'whatsapp', 'curl/', 'wget', 'python-requests',
  'go-http-client', 'headlesschrome', 'phantomjs',
];
const DEDUP_WINDOW_MS = 30_000;
const MAX_PATH_LENGTH = 200;

export function trackRouter({ db, now = () => new Date().toISOString() } = {}) {
  const r = Router();
  // { ip -> last accepted ts (ms) }. Pruned on every hit while the map is
  // tiny: entries die 30s after they are written, so it can never grow past
  // distinct-IPs-in-30s regardless of traffic.
  const lastHit = new Map();
  const prune = (tsMs) => {
    for (const [ip, lastTs] of lastHit) {
      if (tsMs - lastTs > DEDUP_WINDOW_MS) lastHit.delete(ip);
    }
  };
  r.post('/api/v1/track', (req, res) => {
    try {
      const rawPath = req.body?.path;
      if (typeof rawPath !== 'string') return res.status(204).end();
      const path = rawPath.trim().slice(0, MAX_PATH_LENGTH);
      if (path === '') return res.status(204).end();
      const ua = (req.get('user-agent') || '').trim();
      if (ua === '') return res.status(204).end();
      const uaLower = ua.toLowerCase();
      if (BOT_PATTERNS.some((bot) => uaLower.includes(bot))) return res.status(204).end();
      const ts = Date.parse(now()); // epoch ms (the page_views.ts convention)
      const ip = clientIp(req);
      prune(ts);
      if (lastHit.has(ip)) return res.status(204).end(); // dedup within 30s
      lastHit.set(ip, ts);
      db.insertPageView({ ts, ip, ua, path });
      return res.status(204).end();
    } catch {
      return res.status(204).end();
    }
  });
  return r;
}