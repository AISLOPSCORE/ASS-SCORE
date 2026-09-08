import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { extractText } from '../text.js';
import { runRules } from '../rules/index.js';
import { computeSlopScore } from '../scorer.js';
import { SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { FetchError } from '../fetch/client.js';
import { validateWebhookUrl, createWebhookDeliverer } from '../webhook.js';

/**
 * POST /api/v1/scan
 * Body: { "url": "https://example.com", "webhookUrl"?: "https://hooks.example.com/x" }
 * Flow: validate url (SSRF) -> validate optional webhookUrl (fail fast, BEFORE any
 *       network I/O) -> fetch with re-checked redirects -> extract text
 *       -> run 4 deterministic rules -> weighted Slop Score -> persist in SQLite
 *       -> fire async best-effort webhook delivery -> JSON.
 *
 * The webhook URL is a callback URL, not a scan target: it is validated for
 * scheme + host presence only (no SSRF range checks). Delivery never blocks or
 * fails the response.
 *
 * Errors: 400 SSRF-blocked / invalid url / invalid webhookUrl, 502 fetch failure,
 *         422 HTML parse failure.
 */
export function scanRouter({ db, fetcher, now = () => new Date().toISOString(), webhookDeliverer }) {
  const r = Router();
  const deliver = webhookDeliverer ?? createWebhookDeliverer();

  r.post('/api/v1/scan', async (req, res, next) => {
    try {
      const url = req.body?.url;
      if (typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({
          error: { code: 'invalid_request', message: 'Request body must be JSON of the form { "url": "https://example.com" }' },
        });
      }

      // Optional callback URL. Invalid values are a 400 BEFORE scanning (fail fast).
      // Missing / empty is allowed and means "no webhook delivery".
      const webhook = validateWebhookUrl(req.body?.webhookUrl);
      if (!webhook.ok) {
        return res.status(400).json({ error: { code: 'invalid_webhook_url', message: webhook.message } });
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
      // Response object AND webhook payload — delivered bytes-exact as returned.
      const payload = { id, url: page.url, slopScore, breakdown, createdAt };
      db.insertScan({ id, url: page.url, score: slopScore, breakdown, createdAt });

      if (webhook.url) {
        // Best-effort, non-blocking: defer delivery out of the request path.
        // Any delivery failure is logged by the deliverer (and caught below for
        // exotic injectable deliverers) and NEVER affects this response.
        setImmediate(async () => {
          try {
            await deliver(payload, webhook.url);
          } catch (err) {
            console.error(`[webhook] delivery to ${webhook.url} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      res.status(200).json(payload);
    } catch (err) {
      next(err); // centralized error handler; never leaks stack traces
    }
  });

  return r;
}