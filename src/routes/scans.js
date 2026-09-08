import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { isHttpUrl } from '../branding.js';

/**
 * GET /api/v1/scans/:id — fetch a stored scan.
 * Returns JSON by default; renders a simple HTML report when the client
 * prefers text/html (the report view).
 *
 * GET /api/v1/scans/:id/card — the shareable result card: a deterministic
 * 1200x630 PNG (A.S.S. Score + scanned URL + one-line verdict + branding +
 * disclaimer), composed as SVG and rasterized with sharp (no headless
 * browser). Same scan id -> byte-identical PNG, always.
 *
 * GET /api/v1/scans/:id/share — pre-filled social share text + public result
 * URL (publicBaseUrl, default env PUBLIC_BASE_URL || https://ass-score.com).
 */
export function scansRouter({ db, publicBaseUrl }) {
  const r = Router();
  const shareBase = publicBaseUrl || process.env.PUBLIC_BASE_URL || 'https://ass-score.com';

  r.get('/api/v1/scans/:id', (req, res) => {
    const scan = db.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${req.params.id}"` } });
    }
    // Render the HTML report only when the client explicitly asks for text/html;
    // JSON is the default for API clients (curl sends */* and gets JSON).
    const accept = req.get('accept') || '';
    const wantsHtml = /text\/html/.test(accept) && !/application\/json/.test(accept);
    if (wantsHtml) {
      return res.type('html').send(renderHtmlReport(scan));
    }
    const json = {
      id: scan.id,
      url: scan.url,
      slopScore: scan.score,
      breakdown: scan.breakdown,
      createdAt: scan.created_at,
    };
    if (Array.isArray(scan.breakdown?.crossPage?.pages) && scan.breakdown.crossPage.pages.length >= 2) {
      json.pages = scan.breakdown.crossPage.pages;
    }
    if (scan.breakdown?.crossPage?.pairs?.length) {
      json.pairs = scan.breakdown.crossPage.pairs;
    }
    if (typeof scan.partial === 'boolean') json.partial = scan.partial;
    if (typeof scan.note === 'string') json.note = scan.note;
    if (scan.worstPage) json.worstPage = scan.worstPage;
    if (scan.branding) json.branding = scan.branding; // white-label branding used
    res.json(json);
  });

  const missing = (res, id) =>
    res.status(404).json({ error: { code: 'not_found', message: `No scan found with id "${id}"` } });

  // --- Shareable result card (deterministic PNG, sharp-rasterized SVG) -------
  r.get('/api/v1/scans/:id/card', async (req, res, next) => {
    const scan = db.getScan(req.params.id);
    if (!scan) return missing(res, req.params.id);
    try {
      const png = await renderCardPng(buildCardSvg({
        score: scan.score,
        url: scan.url,
        agencyName: scan.branding?.agencyName, // white-label: small agency line only
      }));
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=60');
      res.send(png);
    } catch (err) {
      next(err); // centralized error handler; PNG render errors never leak internals
    }
  });

  // --- Pre-filled share text (copy-to-clipboard + social post) ---------------
  r.get('/api/v1/scans/:id/share', (req, res) => {
    const scan = db.getScan(req.params.id);
    if (!scan) return missing(res, req.params.id);
    const shareUrl = `${shareBase.replace(/\/+$/, '')}/scan/${scan.id}`;
    res.json({
      url: shareUrl,
      text: `My website scored ${scan.score}/100 on the A.S.S. Score (AI Slop Score). Check yours: ${shareUrl}`,
    });
  });

  return r;
}

function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Branded, emoji-tagged display labels for the breakdown categories.
 * Display layer only — the JSON API keys stay exactly as built (filler,
 * boilerplate, infoDensity, repetitive, crossPage, fingerprints).
 */
const CATEGORY_LABELS = {
  filler: '🤖 AI-like copy',
  boilerplate: '🥱 Generic marketing language',
  infoDensity: '📋 Repeated/template content',
  repetitive: '🧱 Generic page structures',
  crossPage: '🔁 Duplicate language across pages',
  fingerprints: '🎨 AI-looking design patterns',
};

/**
 * Mandated user-facing disclaimer. Appears on every HTML report, verbatim.
 */
const DISCLAIMER =
  'This tool identifies writing and design patterns commonly associated with generic or templated content. It does not detect AI authorship and is not proof that any content was AI-generated.';

/**
 * Render the HTML report.
 *
 * White-label branding (optional, stored with the scan):
 *   - agencyName  -> the report header shows the agency name; the metric
 *                    label "A.S.S. Score" stays visible (title tag, "powered
 *                    by" line + the score line below).
 *   - logoUrl     -> <img> at the top, ONLY when it is an http(s) URL
 *                    (re-checked at render, attrs escaped).
 *   - accentColor -> inline style on the agency header + the A.S.S. Score
 *                    number (only when it is a valid hex color).
 *   - footerText  -> an extra footer line (the mandated disclaimer and the
 *                    score id are always rendered, never replaced).
 * Everything else renders byte-identical to the default report: the metric
 * label, the emoji category labels, and the mandated disclaimer are ALWAYS
 * present regardless of branding.
 *
 * Sections (added in phase 2):
 *   - Worst Page: the fetched page with the highest combined score
 *     (0.7 × per-page v1 score + 0.3 × its duplication score; deterministic
 *     tie-break = lowest URL lexicographic).
 *   - Templated Content: the flagged cross-page duplication pairs
 *     (similarity >= 0.80) with both URLs and the similarity percentage.
 *
 * A module whose score is null (e.g. crossPage with fewer than 2 pages) is
 * rendered as its note instead of a numeric row.
 */
function renderHtmlReport(scan) {
  // --- white-label branding (normalized + re-validated at render) -----------
  const branding = scan.branding ?? {};
  const agencyName = typeof branding.agencyName === 'string' ? branding.agencyName : '';
  const logoUrl = isHttpUrl(branding.logoUrl) ? branding.logoUrl : '';
  const accentColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(branding.accentColor ?? '')
    ? branding.accentColor
    : '';
  const footerText = typeof branding.footerText === 'string' ? branding.footerText : '';

  const rows = Object.entries(scan.breakdown)
    .map(([key, rule]) => {
      if (Number.isFinite(Number(rule?.score))) {
        return `
      <tr>
        <td>${esc(CATEGORY_LABELS[key] ?? key)}</td>
        <td>${Number(rule.score)}</td>
        <td><ul>${(rule.findings ?? []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></td>
      </tr>`;
      }
      // Skipped module (score null): show its note instead of a score.
      const note = rule?.note ? esc(rule.note) : 'skipped';
      return `
      <tr>
        <td>${esc(CATEGORY_LABELS[key] ?? key)}</td>
        <td>—</td>
        <td><em>${note}</em></td>
      </tr>`;
    })
    .join('');

  // --- Worst Page section ----------------------------------------------------
  const cross = scan.breakdown?.crossPage ?? {};
  const worst = scan.worstPage || null;
  let worstSection = '';
  if (worst && Array.isArray(cross.pages) && cross.pages.length >= 2) {
    worstSection = `
  <h2>Worst Page</h2>
  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined score ${Number(worst.score)} / 100</p>
  <ul>${(worst.findings ?? []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
  } else if (worst) {
    worstSection = `
  <h2>Worst Page</h2>
  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined score ${Number(worst.score)} / 100</p>`;
  }

  // --- Templated Content section (flagged duplication pairs) -----------------
  const pairs = Array.isArray(cross.pairs) ? cross.pairs.filter((p) => p.similarity >= 0.8) : [];
  let templatedSection = '';
  if (pairs.length > 0) {
    templatedSection = `
  <h2>Templated Content</h2>
  <ul>${pairs.map((p) => `
    <li><a href="${esc(p.pageA)}">${esc(p.pageA)}</a> ~ <a href="${esc(p.pageB)}">${esc(p.pageB)}</a> — ${(p.similarity * 100).toFixed(1)}% similar</li>`).join('')}
  </ul>`;
  }

  const pagesLine = Array.isArray(cross.pages) && cross.pages.length >= 2
    ? `<p>Pages scanned: ${cross.pages.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(', ')}${scan.partial && scan.note ? ` · ${esc(scan.note)}` : ''}</p>`
    : '';

  // --- white-label header (agency name, optional logo, accent color) --------
  // The metric label "A.S.S. Score" is ALWAYS visible: in the <title>, in the
  // "powered by" line when branded, and in the score line below.
  const header = agencyName
    ? `<h1${accentColor ? ` style="color:${accentColor};border-bottom:3px solid ${accentColor};display:inline-block;padding-bottom:.2rem"` : ''}>${esc(agencyName)}</h1>
  <p class="powered">A.S.S. Score report · powered by <a href="https://ass-score.com">A.S.S. Score</a></p>`
    : `<h1>A.S.S. Score report</h1>`;
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(agencyName || 'agency logo')}" style="max-height:56px;max-width:220px;display:block;margin:0 0 .75rem" />`
    : '';
  const scoreAccent = accentColor ? ` style="color:${accentColor}"` : '';
  const footerLine = footerText ? `<p class="footer">${esc(footerText)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>A.S.S. Score report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a202c; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.8rem; }
    .powered { color: #64748b; font-size: .85rem; margin-top: -.25rem; }
    .score { font-size: 2.6rem; font-weight: 700; }
    .footer { color: #64748b; font-size: .9rem; border-top: 1px solid #e2e8f0; padding-top: .75rem; margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #cbd5e1; padding: .5rem .75rem; text-align: left; vertical-align: top; font-size: .9rem; }
    th { background: #f1f5f9; } ul { margin: 0; padding-left: 1.1rem; }
  </style>
</head>
<body>
  ${logo}
  ${header}
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(scan.created_at)}</p>
  <p class="score"${scoreAccent}>A.S.S. Score: ${Number(scan.score)} / 100</p>
  ${pagesLine}
  <table>
    <thead><tr><th>Rule</th><th>Score</th><th>Findings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${worstSection}
  ${templatedSection}
  <p class="disclaimer">${DISCLAIMER}</p>
  ${footerLine}
  <p>Score id: <code>${esc(scan.id)}</code> · deterministic rule-based analysis, no AI models.</p>
</body>
</html>`;
}