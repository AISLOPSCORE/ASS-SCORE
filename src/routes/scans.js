import { Router } from 'express';
import { buildCardSvg, renderCardPng } from '../card.js';
import { isHttpUrl } from '../branding.js';
import { selectRoast, selectRoastInfo } from '../roast.js';
import { withInsights } from '../threeLayer.js';
import { toPublicScan, flipScore } from '../serialize.js';
import { verdictBand, verdictLabel, scoreColor } from '../verdict.js';

/**
 * The stored line when the row has one; for rows written before the roast
 * column existed (roast null), derive it deterministically from the stored
 * id + score + breakdown — the same function the scan pipeline used, so the
 * result is identical to what a fresh scan would have stored.
 */
function roastFor(scan) {
  if (typeof scan.roast === 'string' && scan.roast.trim() !== '') return scan.roast;
  return selectRoast({ id: scan.id, slopScore: scan.score, breakdown: scan.breakdown });
}

/** Roast info (pool emoji/label + line) with the stored-line override. */
function roastInfoFor(scan) {
  const info = selectRoastInfo({ id: scan.id, slopScore: scan.score, breakdown: scan.breakdown });
  if (typeof scan.roast === 'string' && scan.roast.trim() !== '') info.line = scan.roast;
  return info;
}

/**
 * Breakdown with three-layer insights guaranteed: stored rows already carry
 * `insights` inside the JSON column (attached at scan time); rows written
 * before the feature derive them deterministically from the stored id +
 * breakdown — the same function the scan pipeline used (withInsights is
 * idempotent, so stored insights always win). Every surface (JSON + HTML)
 * therefore shows the same layers for the same scan id.
 */
function breakdownFor(scan) {
  return withInsights(scan.breakdown, scan.id);
}

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
      return res.type('html').send(renderHtmlReport({ ...scan, breakdown: breakdownFor(scan) }));
    }
    // PUBLIC shape: stored internal slop scores are flipped at this read
    // boundary (score = 100 - internal, verdict added, breakdown flipped).
    // Pre-flip rows read correctly with NO migration: the flip happens here,
    // at response time; the DB column keeps the internal slop direction.
    // Three-layer insights are guaranteed on the breakdown (stored, or derived
    // for legacy rows).
    const pub = toPublicScan({ ...scan, breakdown: breakdownFor(scan) });
    const json = {
      id: pub.id,
      url: pub.url,
      score: pub.score,
      verdict: pub.verdict,
      breakdown: pub.breakdown,
      roast: roastFor(scan), // stored line, or derived for pre-roast legacy rows
      createdAt: pub.created_at ?? pub.createdAt,
    };
    if (Array.isArray(pub.breakdown?.crossPage?.pages) && pub.breakdown.crossPage.pages.length >= 2) {
      json.pages = pub.breakdown.crossPage.pages;
    }
    if (pub.breakdown?.crossPage?.pairs?.length) {
      json.pairs = pub.breakdown.crossPage.pairs;
    }
    if (typeof pub.partial === 'boolean') json.partial = pub.partial;
    if (typeof pub.note === 'string') json.note = pub.note;
    if (pub.worstPage) json.worstPage = pub.worstPage; // worstPage.score stays INTERNAL slop direction (see README)
    if (pub.branding) json.branding = pub.branding; // white-label branding used
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
        score: flipScore(scan.score), // PUBLIC score: 100 - stored internal slop
        url: scan.url,
        agencyName: scan.branding?.agencyName, // white-label: small agency line only
        roast: roastFor(scan),
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
      text: `My website scored ${flipScore(scan.score)}/100 on the A.S.S. Score (AI Slop Score). Check yours: ${shareUrl}`,
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
 * boilerplate, infoDensity, repetitive, crossPage, fingerprints, assets).
 */
const CATEGORY_LABELS = {
  filler: '🤖 AI-like copy',
  boilerplate: '🥱 Generic marketing language',
  infoDensity: '📋 Repeated/template content',
  repetitive: '🧱 Generic page structures',
  crossPage: '🔁 Duplicate language across pages',
  fingerprints: '🎨 AI-looking design patterns',
  assets: '🖼️ Stock/placeholder imagery',
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
 *
 * Three-layer findings: each category's findings cell keeps the raw evidence
 * lines and, under each one, its insight (roast italic/accent; why/fix small
 * and muted) when the category carries insights. Insight `i` corresponds to
 * finding `i` (evidence is the finding string), so the layers stay glued to
 * the exact trigger they roast. Findings beyond the 6-insight cap render as
 * plain evidence lines, exactly as before.
 */
function renderInsightLi(evidence, ins) {
  const ev = `<li><strong>${esc(evidence)}</strong>`;
  if (!ins || typeof ins.roast !== 'string' || ins.roast === '') return `${ev}</li>`;
  // NOTE: the classed spans must not sit inside a classed parent followed by a
  // child element — the literal "><" would trip the report's blanket no-raw-
  // delimiter assertion. Unclassed containers + classed spans keep the markup
  // injection-proof AND the assertion green.
  return `${ev}
      <p class="ins-roast">${esc(ins.roast)}</p>
      <div><span class="ins-why">Why it matters:</span> ${esc(ins.why ?? '')}</div>
      <div><span class="ins-fix">How to fix it:</span> ${esc(ins.fix ?? '')}</div></li>`;
}
function renderHtmlReport(scan) {
  // --- Slop Roast: the personality line, emoji-tagged like other findings. ---
  // Deterministic per scan id; stored on the scan, derived for pre-roast rows.
  const roastInfo = roastInfoFor(scan);
  const roastSection = `
  <h2>Slop Roast</h2>
  <p class="roast">${roastInfo.emoji} ${esc(roastInfo.line)}</p>`;

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
      if (Number.isFinite(Number(rule?.score)) && rule.score !== null) {
        const catScore = flipScore(rule.score); // public direction: higher = better
        return `
      <tr>
        <td>${esc(CATEGORY_LABELS[key] ?? key)}</td>
        <td class="${{'CATASTROPHICALLY ASS': 'b-catastrophic', 'EXTREMELY ASS': 'b-extreme', 'VERY ASS': 'b-very', 'MILDLY GENERIC': 'b-mild', 'CLEANEST': 'b-clean'}[verdictBand(catScore).shortLabel] ?? 'b-very'}" style="font-weight:700">${catScore}</td>
        <td><ul>${(rule.findings ?? []).map((f, i) => renderInsightLi(f, Array.isArray(rule.insights) ? rule.insights[i] : undefined)).join('')}</ul></td>
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
    // worstPage.score is the INTERNAL slop direction (higher = worse) — the
    // label below says so explicitly so the flipped public scale is not misread.
    worstSection = `
  <h2>Worst Page</h2>
  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined slop score ${Number(worst.score)} / 100 (higher = more slop)</p>
  <ul>${(worst.findings ?? []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
  } else if (worst) {
    worstSection = `
  <h2>Worst Page</h2>
  <p><a href="${esc(worst.url)}">${esc(worst.url)}</a> — combined slop score ${Number(worst.score)} / 100 (higher = more slop)</p>`;
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
  // PUBLIC score + verdict: the stored internal slop score is flipped here
  // (score = 100 - internal, higher = better); the grade label and its band
  // color come from the shared verdict module (src/verdict.js).
  const publicScore = flipScore(scan.score);
  const publicVerdict = verdictBand(publicScore);
  const verdictClass = { 'CATASTROPHICALLY ASS': 'b-catastrophic', 'EXTREMELY ASS': 'b-extreme', 'VERY ASS': 'b-very', 'MILDLY GENERIC': 'b-mild', 'CLEANEST': 'b-clean' }[publicVerdict.shortLabel] ?? 'b-very';
  const verdictLine = `<p class="verdict ${verdictClass}">${verdictLabel(publicScore)}</p>`;

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
    .verdict { font-size: 1.15rem; font-weight: 700; margin: .25rem 0 .75rem; }
    .b-catastrophic { color: #f87171; } .b-extreme { color: #fb923c; } .b-very { color: #facc15; }
    .b-mild { color: #a3e635; } .b-clean { color: #4ade80; }
    .roast { font-size: 1.15rem; font-weight: 600; margin: .75rem 0 .25rem; }
    .footer { color: #64748b; font-size: .9rem; border-top: 1px solid #e2e8f0; padding-top: .75rem; margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #cbd5e1; padding: .5rem .75rem; text-align: left; vertical-align: top; font-size: .9rem; }
    th { background: #f1f5f9; } ul { margin: 0; padding-left: 1.1rem; }
    li { margin-bottom: .45rem; }
    .ins-roast { font-style: italic; color: #7c3aed; font-weight: 600; margin: .25rem 0 0; font-size: .92rem; }
    .ins-why, .ins-fix { font-weight: 700; color: #475569; margin-right: .25rem; }
  </style>
</head>
<body>
  ${logo}
  ${header}
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(scan.created_at)}</p>
  <p class="score"${scoreAccent}>A.S.S. Score: ${publicScore} / 100</p>
  ${verdictLine}
  ${roastSection}
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