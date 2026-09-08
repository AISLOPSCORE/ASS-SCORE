import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { extractText } from '../text.js';
import { runRules } from '../rules/index.js';
import { computeSlopScore } from '../scorer.js';
import { SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { FetchError } from '../fetch/client.js';

/**
 * POST /api/v1/scan
 * Body: { "url": "https://example.com" }
 * Flow: validate URL (SSRF) -> fetch with re-checked redirects -> extract text
 *       -> run 4 deterministic rules -> weighted Slop Score -> persist in SQLite -> JSON.
 *
 * Errors: 400 SSRF-blocked / invalid URL, 502 fetch failure, 422 HTML parse failure.
 */
export function scanRouter({ db, fetcher, now = () => new Date().toISOString() }) {
  const r = Router();

  r.post('/api/v1/scan', async (req, res, next) => {
    try {
      const url = req.body?.url;
      if (typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({
          error: { code: 'invalid_request', message: 'Request body must be JSON of the form { "url": "https://example.com" }' },
        });
      }

      let page;
      try {
        page = await fetcher.fetchHtml(url);
      } catch (err) {
        if (err instanceof SsrfError || err instanceof InvalidUrlError) {
          return res.status(400).json({ error: { code: 'blocked', message: err.message } });
        }
        if (err instanceof FetchError) {
          return res.status(502).json({ error: { code: 'fetch_failed', message: err.message } });
        }
        throw err;
      }

      let text;
      try {
        text = extractText(page.body);
      } catch (err) {
        return res.status(422).json({ error: { code: 'parse_failed', message: 'Could not parse the HTML response' } });
      }
      if (!text.text || text.words.length === 0) {
        return res.status(422).json({ error: { code: 'parse_failed', message: 'The page contained no extractable text' } });
      }

      const breakdown = runRules(text);
      const { slopScore } = computeSlopScore(breakdown);

      const id = randomUUID();
      const createdAt = now();
      db.insertScan({ id, url: page.url, score: slopScore, breakdown, createdAt });

      res.status(200).json({ id, url: page.url, slopScore, breakdown, createdAt });
    } catch (err) {
      next(err); // centralized error handler; never leaks stack traces
    }
  });

  return r;
}