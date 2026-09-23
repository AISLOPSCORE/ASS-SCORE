/**
 * Tier paywall — the free/paid boundary (owner-flagged gap 2026-09-14).
 *
 * The free tier (POST /api/v1/scan response, GET /api/v1/scans/:id JSON+HTML)
 * gets: id, url, score, verdict, roast, 1–2 teaser findings in full three-layer
 * format, category scores as NUMBERS, the share card route, and the mandated
 * disclaimer. The full findings/insights (the paid content) are served ONLY at
 * GET /api/v1/scans/:id?token=… and GET /api/v1/report/:id?token=… — the link
 * is emailed to the paying buyer after checkout.
 *
 * Token scheme: HMAC-SHA256 over the scan id, hex-encoded, version-prefixed
 * ("v1.<hex>"). Stateless (no DB column, no expiry bookkeeping): the token is
 * verifiable from the secret + scan id alone, and unguessable — the secret is
 * server-side (REPORT_TOKEN_SECRET), never shipped. Repeated free rescans
 * therefore cannot reconstruct either the token or the paid report: each
 * rescan has a fresh scan id and a fresh teaser selection.
 *
 * Teaser selection: PROBLEM-ONLY (owner rule) — free samples are drawn only
 * from WATCH-and-above categories (score >= 25) with non-clean insights, so a
 * clean/praise finding NEVER appears in the free "WHAT'S ACTUALLY WRONG"
 * preview; a site with no problem findings gets teasers: []. Selection stays
 * deterministic for a given scan id (stable across repeated GETs of the SAME
 * scan — the buyer's teasers never drift), but seeded by the scan id so
 * DIFFERENT scans (rescans) select different teasers — repeated free rescans
 * can't reconstruct the paid report through the teasers either. The paid
 * report rendering never depends on teaser selection, so the paid report
 * stays byte-identical for a given scan id.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashScanId } from './roast.js';
import { isMetricFinding } from './threeLayer.js';
import { DISCLAIMER } from './card.js';

export { DISCLAIMER };

/** Teaser selection constants (cap the pick pool so teasers vary per scan). */
const FIRST_POOL = 3;   // first teaser is drawn from the top-3 scoring categories
const SECOND_POOL = 4;  // second teaser from the top-4, excluding the first pick

/**
 * Pick 1–2 teaser findings (full three-layer objects) from a breakdown.
 *
 * PROBLEM-ONLY RULE (owner): free samples must NEVER be clean/praise findings —
 * the free "WHAT'S ACTUALLY WRONG" preview only ever shows findings that
 * represent actual problems. Concretely:
 *   - a category is a candidate only when its numeric score >= 25 (WATCH and
 *     above — every non-CLEAN severity counts as a problem);
 *   - within a candidate, only insights that are NOT clean compliments may
 *     enter the pool (`ins.kind !== 'clean'`; negative findings carry no
 *     kind key);
 *   - candidates left with zero problem insights drop out; if no candidates
 *     remain, teasers are [] — a clean site shows NO teasers anywhere on the
 *     free surfaces.
 *
 * Deterministic per (breakdown, id): same scan id -> identical teasers, always.
 * Different scan ids -> different picks (seeded via hashScanId), which is what
 * makes repeated free rescans feel fresh without ever being random.
 *
 * Candidates (score >= 25, non-metric insights, at least one problem insight)
 * are sorted by score desc (ties: category key asc) — the funniest = most
 * damning material is always in the pool.
 *
 * The teaser object mirrors its source insight one-for-one. Negative teasers
 * carry no kind key; the clean-marker passthrough in teaserFrom is kept for
 * safety but is inert under the problem-only rule (clean insights can never
 * reach the pool).
 *
 * @param {Record<string, {score?: number, findings?: unknown[], insights?: any[]}>} breakdown
 * @param {string} id scan id (seed)
 * @returns {Array<{ key: string, roast: string, why: string, fix: string, evidence: string, kind?: 'clean' }>}
 */
export function pickTeasers(breakdown, id) {
  const candidates = Object.entries(breakdown ?? {})
    .filter(([, r]) =>
      r &&
      typeof r === 'object' &&
      Number.isFinite(Number(r.score)) && r.score !== null &&
      // Problem-only rule: only WATCH-and-above categories (score >= 25) may
      // supply free samples — CLEAN-band categories never do.
      Number(r.score) >= 25 &&
      Array.isArray(r.findings) && r.findings.length > 0 &&
      Array.isArray(r.insights) && r.insights.length > 0)
    .map(([key, r]) => {
      // Owner IA (2026-09-17): METRIC MEASUREMENT lines are not findings, so
      // they can never be teasers (a raw "vocabulary diversity 0.766" line
      // must not be sold as one of the funniest/damning findings). The
      // teaser pool keeps only insights whose evidence is a real detector
      // finding. PROBLEM-ONLY rule (owner): a clean compliment (`kind:
      // 'clean'`, i.e. praise) is also excluded — only actual problems may
      // surface as free samples. Deterministic: filtering happens before
      // seeding, so the same (breakdown, id) still always yields identical
      // teasers.
      const insights = (r.insights ?? []).filter((ins) =>
        ins && typeof ins === 'object' &&
        !isMetricFinding(key, String(ins.evidence ?? '')) &&
        ins.kind !== 'clean');
      return { key, score: Number(r.score), findings: r.findings, insights };
    })
    .filter((c) => c.insights.length > 0)
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (candidates.length === 0) return [];

  const count = candidates.length === 1 ? 1 : 1 + (hashScanId(`${id}:teasers:n`) % 2); // 1 or 2
  const firstIdx = hashScanId(`${id}:teasers:0`) % Math.min(FIRST_POOL, candidates.length);
  const out = [];
  const first = teaserFrom(candidates[firstIdx], id, 0);
  if (first) out.push(first);
  if (count === 2 && candidates.length >= 2) {
    // Second teaser: from the top SECOND_POOL candidates, excluding the first
    // pick — a different category than teaser 1, always.
    const pool = candidates.slice(0, Math.min(SECOND_POOL, candidates.length)).filter((_, i) => i !== firstIdx);
    if (pool.length > 0) {
      const second = teaserFrom(pool[hashScanId(`${id}:teasers:1`) % pool.length], id, 1);
      if (second) out.push(second);
    }
  }
  return out;
}

/** Build ONE teaser object from a candidate (insight variant seeded per slot). */
function teaserFrom(candidate, id, slot) {
  if (!candidate || candidate.insights.length === 0) return null;
  const ins = candidate.insights[hashScanId(`${id}:teasers:ins:${slot}:${candidate.key}`) % candidate.insights.length];
  if (!ins || typeof ins !== 'object') return null;
  return {
    key: candidate.key,
    roast: String(ins.roast ?? ''),
    why: String(ins.why ?? ''),
    fix: String(ins.fix ?? ''),
    evidence: String(ins.evidence ?? candidate.findings[0] ?? ''),
    // Clean-marker passthrough kept for safety: inert under the problem-only
    // rule (clean insights can never reach the pool). If it ever does fire,
    // renderers label the sample COMPLIMENT / WHY IT MATTERS / KEEP IT UP.
    ...(ins.kind === 'clean' ? { kind: 'clean' } : {}),
  };
}

/**
 * The FREE public payload — what every unauthenticated surface returns
 * (POST /api/v1/scan response, GET /api/v1/scans/:id JSON, the free HTML
 * teaser page, the free-tier webhook callback, and the free-tier email).
 *
 * CONTRACT (locked 2026-09-16 — owner's free tier = id, url, score, verdict,
 * roast, 1–2 teaser findings in full three-layer format, category scores as
 * NUMBERS, the share card route, and the mandated disclaimer):
 *
 *   IN:
 *   - id, url, score, verdict            — every identity field
 *   - roast                              — the stored/derived roast line
 *   - createdAt                          — scan timestamp
 *   - partial / note                     — partial-scan status (UX-critical,
 *                                          not findings)
 *   - breakdown.<cat>.score              — category NUMBER only (0–100,
 *                                          higher = worse; null when skipped)
 *   - breakdown.<cat>.note               — skip note (e.g. crossPage on a
 *                                          single-page scan)
 *   - teasers                            — 1–2 three-layer finding samples,
 *                                          seeded per scan id (stable for a
 *                                          given id, varied across rescans)
 *   - disclaimer                         — the mandated verbatim line
 *
 *   OUT (never on the free payload, they ARE the paid content):
 *   - breakdown.<cat>.findings / .insights / .hits / .pairs / .pages
 *   - top-level pages / worstPage / pairs — paid-side analysis, not free
 *   - branding                           — agency config for the paid report
 *   - the full /api/v1/report/:id HTML   — token-only route
 *
 * The input must already be the PUBLIC scan shape (score 0-100 higher =
 * worse, verdict present) with insights attached (three-layer findings live
 * in the breakdown before this strips them); `roast` should be the
 * stored/derived roast line. Deterministic: same scan id -> identical
 * payload (teasers seeded by id).
 *
 * @param {{ id: string, url: string, score: number, verdict: string, roast?: string,
 *          createdAt?: string, created_at?: string, partial?: boolean, note?: string,
 *          breakdown?: Record<string, {score?: number, note?: string}> }} scan
 * @returns {object} the free JSON payload
 */
export function buildFreePayload(scan) {
  const breakdown = {};
  for (const [key, rule] of Object.entries(scan?.breakdown ?? {})) {
    if (rule && typeof rule === 'object') {
      const out = {};
      if ('score' in rule) out.score = rule.score;
      if (typeof rule.note === 'string') out.note = rule.note;
      breakdown[key] = out;
    } else {
      breakdown[key] = rule;
    }
  }
  const json = {
    id: scan.id,
    url: scan.url,
    score: scan.score,
    verdict: scan.verdict,
    breakdown,
    roast: typeof scan.roast === 'string' && scan.roast.trim() !== '' ? scan.roast : '',
    teasers: pickTeasers(scan.breakdown, scan.id),
    disclaimer: DISCLAIMER,
    createdAt: scan.created_at ?? scan.createdAt,
  };
  if (typeof scan.partial === 'boolean') json.partial = scan.partial;
  if (typeof scan.note === 'string') json.note = scan.note;
  return json;
}

/**
 * Report-access secret: env REPORT_TOKEN_SECRET, or a fresh random secret when
 * unset. A random fallback FAILS CLOSED (every token dies on restart) and logs
 * a warning (once per process) — production must set REPORT_TOKEN_SECRET so
 * emailed buyer links survive restarts.
 */
let warnedMissingSecret = false;
export function reportSecret(env = process.env, logger = console) {
  const configured = String(env.REPORT_TOKEN_SECRET ?? '').trim();
  if (configured) return configured;
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
    warn(
      '[paywall] REPORT_TOKEN_SECRET is not set — using a random per-boot secret. ' +
        'Emailed full-report links will stop working after the next restart. Set REPORT_TOKEN_SECRET in production.'
    );
  }
  return randomBytes(32).toString('hex');
}

/**
 * HMAC report token for a scan id: `v1.<hex>` (version prefix allows scheme
 * rotation without invalidating the format).
 */
export function createReportToken(secret, scanId) {
  const hmac = createHmac('sha256', String(secret));
  hmac.update(`report:${String(scanId)}`);
  return `v1.${hmac.digest('hex')}`;
}

/**
 * Constant-time verification of a report token against a scan id.
 * @returns {boolean}
 */
export function verifyReportToken(secret, scanId, token) {
  if (typeof token !== 'string') return false;
  const expected = createReportToken(secret, scanId);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The token'd full-report URL emailed to buyers (and shown on the paid report
 * page). Base is the report base URL (REPORT_BASE_URL ?? PUBLIC_BASE_URL).
 */
export function buildReportUrl(base, scanId, token) {
  return `${String(base).replace(/\/+$/, '')}/api/v1/report/${encodeURIComponent(scanId)}?token=${encodeURIComponent(token)}`;
}