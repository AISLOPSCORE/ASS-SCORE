import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { extractText, extractMainText, extractHead } from '../text.js';
import { runRules } from '../rules/index.js';
import { computeSlopScore } from '../scorer.js';
import { discoverPages } from '../rules/discover.js';
import { analyzeCrossPage, DUPLICATION_THRESHOLD } from '../rules/crossPage.js';
import { analyzeFingerprints } from '../rules/fingerprints.js';
import { createBudget } from '../budget.js';
import { SsrfError, InvalidUrlError } from '../fetch/ssrf.js';
import { FetchError } from '../fetch/client.js';
import { validateWebhookUrl, createWebhookDeliverer } from '../webhook.js';
import { validateBranding } from '../branding.js';
import { validateEmail } from '../email.js';
import { selectRoast } from '../roast.js';

/** Per-scan time budget (ms): target fetch + discovery + additional fetches +
 *  similarity. When it elapses, in-flight work is aborted and whatever
 *  completed is used (partial mode recorded). Injectable for tests. */
export const SCAN_BUDGET_MS = 25_000;

/** Worst-page blend: 70% the page's own v1 score + 30% its duplication score. */
export const WORST_PAGE_V1_WEIGHT = 0.7;
export const WORST_PAGE_DUP_WEIGHT = 0.3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * POST /api/v1/scan
 * Body: { "url": "https://example.com", "webhookUrl"?: "https://hooks.example.com/x",
 *         "branding"?: { agencyName?, logoUrl?, accentColor?, footerText? },
 *         "email"?: "owner@example.com" }
 *
 * Flow (phase 2):
 *   validate url (SSRF) -> validate optional webhookUrl (fail fast, BEFORE any
 *   network I/O) -> validate optional branding + email (fail fast, BEFORE any
 *   network I/O) -> budget starts -> fetch target with re-checked redirects
 *   -> extract text -> discover up to 4 additional same-origin pages
 *   (sitemap first, link fallback; EVERY fetch through the same SSRF-safe
 *   Fetcher) -> fetch additional pages concurrently (budget abort) -> extract
 *   main content per page -> run 4 v1 rules on the target + per page (Worst
 *   Page) -> crossPage + fingerprints rules -> weighted score (renormalizes
 *   when crossPage is skipped) -> persist in SQLite (branding stored) ->
 *   async webhook -> async best-effort email -> JSON.
 *
 * Response shape is unchanged from v1 (id, url, slopScore, breakdown,
 * createdAt) plus `pages`, `partial`, `note`, `worstPage` when multi-page,
 * plus `branding` when white-label branding was supplied.
 * The webhook payload is the exact response object. The email (if requested)
 * is delivered async + best-effort exactly like webhooks: failures are logged,
 * never propagated to the caller.
 */
export function scanRouter({ db, fetcher, now = () => new Date().toISOString(), webhookDeliverer, emailSender, scanBudgetMs = SCAN_BUDGET_MS }) {
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

      // Optional white-label branding. Invalid values are a 400 BEFORE scanning.
      const branding = validateBranding(req.body?.branding);
      if (!branding.ok) {
        return res.status(400).json({ error: { code: 'invalid_branding', message: branding.message } });
      }

      // Optional delivery email. Invalid values are a 400 BEFORE scanning.
      const mail = validateEmail(req.body?.email);
      if (!mail.ok) {
        return res.status(400).json({ error: { code: 'invalid_email', message: mail.message } });
      }

      // --- time budget (covers target fetch + discovery + additional fetches) --
      const budget = createBudget(scanBudgetMs);
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), Math.max(1, budget.remainingMs()));

      let page;
      try {
        page = await fetcher.fetchHtml(url, { signal: abortCtrl.signal });
      } catch (err) {
        clearTimeout(abortTimer);
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
        clearTimeout(abortTimer);
        return res.status(422).json({ error: { code: 'parse_failed', message: 'Could not parse the HTML response' } });
      }
      if (!text.text || text.words.length === 0) {
        clearTimeout(abortTimer);
        return res.status(422).json({ error: { code: 'parse_failed', message: 'The page contained no extractable text' } });
      }

      // --- discovery + additional fetches (budget-aware, concurrent) -----------
      const pages = [{ url: page.url, html: page.body }]; // target first, deterministic order
      const skipped = [];

      try {
        if (budget.expired()) {
          skipped.push('<discovery: budget expired before additional-page discovery>');
        } else {
          const discovery = await discoverPages({
            targetUrl: page.url,
            targetHtml: page.body,
            fetcher,
            signal: abortCtrl.signal,
          });
          const additional = discovery.additional; // <= 4, deterministic order
          if (additional.length > 0) {
            // Concurrent; budget expiry aborts whatever is still in flight.
            const settled = await Promise.allSettled(
              additional.map((u) => fetcher.fetchHtml(u, { signal: abortCtrl.signal })),
            );
            for (let i = 0; i < additional.length; i += 1) {
              if (settled[i].status === 'fulfilled') {
                pages.push({ url: settled[i].value.url, html: settled[i].value.body });
              } else {
                skipped.push(additional[i]);
              }
            }
          }
        }
      } finally {
        clearTimeout(abortTimer);
      }

      // --- per-page main content + v1 rules (Worst Page needs them) -----------
      const perPage = new Map(); // url -> { rules, main }
      for (const p of pages) {
        const main = extractMainText(p.html);
        perPage.set(p.url, { rules: runRules(main), main });
      }

      // --- phase-2 rules --------------------------------------------------------
      // crossPage: similarity over MAIN content of every fetched page.
      const crossPage = analyzeCrossPage({
        pages: pages.map((p) => ({ url: p.url, main: perPage.get(p.url).main })),
      });
      // fingerprints: evidence on the target page (the URL the customer asked about).
      const fingerprints = analyzeFingerprints({
        html: page.body,
        head: extractHead(page.body),
        text: text.text,
      });

      // --- v1 breakdown on the target + new categories --------------------------
      const breakdown = {
        ...runRules(text),
        crossPage,
        fingerprints,
      };

      const { slopScore } = computeSlopScore(breakdown);

      // --- Worst Page: highest per-page combined score --------------------------
      // combined = 0.7 * (page's own v1 score) + 0.3 * (its duplication score,
      // where duplication score reuses the crossPage mapping 0.80 -> 0, 1.00 -> 100
      // for the page's worst flagged pair; 0 when the page is in no flagged pair).
      // Deterministic tie-break: lowest URL (lexicographic).
      let worstPage = null;
      if (pages.length >= 2) {
        const dupByUrl = new Map();
        for (const p of crossPage.pairs ?? []) {
          if (p.similarity < DUPLICATION_THRESHOLD) continue;
          const dup = clamp(Math.round(((p.similarity - DUPLICATION_THRESHOLD) / (1 - DUPLICATION_THRESHOLD)) * 100), 0, 100);
          dupByUrl.set(p.pageA, Math.max(dupByUrl.get(p.pageA) ?? 0, dup));
          dupByUrl.set(p.pageB, Math.max(dupByUrl.get(p.pageB) ?? 0, dup));
        }
        let bestUrl = null;
        let bestScore = -1;
        let bestFindings = [];
        for (const p of pages) {
          const v1 = computeSlopScore(perPage.get(p.url).rules).slopScore;
          const dup = dupByUrl.get(p.url) ?? 0;
          const combined = clamp(Math.round(WORST_PAGE_V1_WEIGHT * v1 + WORST_PAGE_DUP_WEIGHT * dup), 0, 100);
          const better = combined > bestScore || (combined === bestScore && (bestUrl === null || p.url < bestUrl));
          if (better) {
            bestScore = combined;
            bestUrl = p.url;
            bestFindings = [
              ...perPage.get(p.url).rules.filler.findings,
              ...perPage.get(p.url).rules.boilerplate.findings,
              ...perPage.get(p.url).rules.infoDensity.findings,
              ...perPage.get(p.url).rules.repetitive.findings,
            ].slice(0, 6);
          }
        }
        worstPage = { url: bestUrl, score: bestScore, findings: bestFindings };
      }

      const id = randomUUID();
      const createdAt = now();
      // Slop Roast: deterministic per scan id (same id -> same line, forever),
      // pool picked from the category that contributed the most to the score.
      const roast = selectRoast({ id, slopScore, breakdown });
      // Response object AND webhook payload — delivered bytes-exact as returned.
      const payload = { id, url: page.url, slopScore, breakdown, roast, createdAt };
      if (branding.branding) payload.branding = branding.branding;
      if (pages.length >= 2) {
        payload.pages = pages.map((p) => p.url);
        payload.worstPage = worstPage;
      }
      if (skipped.length > 0) {
        payload.partial = true;
        payload.note = `skipped/dropped pages: ${skipped.join(', ')}`;
      }
      db.insertScan({
        id,
        url: page.url,
        score: slopScore,
        breakdown,
        createdAt,
        partial: payload.partial,
        note: payload.note,
        worstPage: payload.worstPage,
        branding: payload.branding,
        roast,
      });

      if (webhook.url) {
        // Best-effort, non-blocking: defer delivery out of the request path.
        setImmediate(async () => {
          try {
            await deliver(payload, webhook.url);
          } catch (err) {
            console.error(`[webhook] delivery to ${webhook.url} for scan ${id} crashed:`, err?.message ?? err);
          }
        });
      }

      if (mail.email && emailSender) {
        // Best-effort, non-blocking: same semantics as webhooks. The sender
        // never rejects (missing SMTP config logs a no-op), so the response
        // below is never affected.
        setImmediate(async () => {
          try {
            await emailSender(payload, mail.email);
          } catch (err) {
            console.error(`[email] delivery to ${mail.email} for scan ${id} crashed:`, err?.message ?? err);
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