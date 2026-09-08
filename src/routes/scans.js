import { Router } from 'express';

/**
 * GET /api/v1/scans/:id — fetch a stored scan.
 * Returns JSON by default; renders a simple HTML report when the client
 * prefers text/html (the MVP report view).
 */
export function scansRouter({ db }) {
  const r = Router();

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
    res.json({
      id: scan.id,
      url: scan.url,
      slopScore: scan.score,
      breakdown: scan.breakdown,
      createdAt: scan.created_at,
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

function renderHtmlReport(scan) {
  const rows = Object.entries(scan.breakdown)
    .map(([key, rule]) => `
      <tr>
        <td>${esc(key)}</td>
        <td>${Number(rule.score)}</td>
        <td><ul>${rule.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></td>
      </tr>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AISlopScanner report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a202c; }
    h1 { font-size: 1.4rem; } .score { font-size: 2.6rem; font-weight: 700; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #cbd5e1; padding: .5rem .75rem; text-align: left; vertical-align: top; font-size: .9rem; }
    th { background: #f1f5f9; } ul { margin: 0; padding-left: 1.1rem; }
  </style>
</head>
<body>
  <h1>AISlopScanner report</h1>
  <p><a href="${esc(scan.url)}">${esc(scan.url)}</a> · scanned ${esc(scan.created_at)}</p>
  <p class="score">Slop Score: ${Number(scan.score)} / 100</p>
  <table>
    <thead><tr><th>Rule</th><th>Score</th><th>Findings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p>Score id: <code>${esc(scan.id)}</code> · deterministic rule-based analysis, no AI models.</p>
</body>
</html>`;
}