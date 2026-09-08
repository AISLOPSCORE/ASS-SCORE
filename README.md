# AISlopScanner

Deterministic, rule-based **Slop Score** scanner for public websites. No AI models,
no LLM calls, no external scoring APIs — the same URL in yields the same score, every
time. A micro-SaaS service: submit a URL over HTTP, get a 0–100 score with a
per-rule breakdown, stored in SQLite. Same input → same score, every run.

## Quickstart

```bash
npm install
npm start          # listens on PORT (default 4000)
npm test           # node:test unit + API tests (no network required)
```

## API

### `POST /api/v1/scan`

Request (optionally with a callback `webhookUrl`):

```bash
curl -s -X POST http://localhost:4000/api/v1/scan \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com",
    "webhookUrl": "https://hooks.example.com/scan-complete"
  }'
```

`webhookUrl` is optional. Missing or empty means no webhook delivery. It must be
an `http://` or `https://` URL with a host — anything else (wrong scheme, no
host, non-string) is a `400 invalid_webhook_url` that fails fast BEFORE the
target is scanned. It is a callback URL, not a scan target, so the SSRF range
checks are deliberately **not** applied to it; only scheme + host presence are
validated (via `new URL`). Actual DNS/connectivity problems surface at delivery
time and are logged, never propagated to the caller.

Response `200` (single-page site — the v1 shape, unchanged for single-page scans):

```json
{
  "id": "7d5f2b1a-...",
  "url": "https://example.com/",
  "slopScore": 30,
  "breakdown": {
    "filler":       { "score": 0, "findings": ["0 filler phrase occurrence(s) in 112 words (0.0 per 300 words)"] },
    "boilerplate":  { "score": 0, "findings": ["0 boilerplate signal(s) in 112 words (0.0 per 300 words)"] },
    "infoDensity":  { "score": 100, "findings": ["vocabulary diversity (MATTR-50): 0.812 ...", "..."] },
    "repetitive":   { "score": 0, "findings": ["no notable repetitive structure (7 sentences, 4 paragraphs)"] },
    "crossPage":    { "score": null, "findings": [], "note": "insufficient pages for cross-page analysis" },
    "fingerprints": { "score": 0, "findings": [], "hits": [] }
  },
  "createdAt": "2026-09-08T18:50:00.000Z"
}
```

Multi-page scans add four top-level fields (all webhook-delivered too):

```json
{
  "id": "...", "url": "https://site.example/", "slopScore": 52, "breakdown": { "...": "..." },
  "pages": ["https://site.example/", "https://site.example/about", "https://site.example/blog"],
  "worstPage": { "url": "https://site.example/blog", "score": 71, "findings": ["...up to 6 top findings..."] },
  "partial": false,
  "note": "skipped/dropped pages: https://site.example/slow"   // only when partial
}
```

- `pages` — every page fetched (target + up to 4 additional).
- `worstPage` — highest combined per-page score; combined = `0.7 × (page's own
  v1 score) + 0.3 × (its duplication score)`; duplication score uses the same
  0.80→0 / 1.00→100 mapping as crossPage; ties break on lowest URL (lexicographic).
- `partial` — `true` when the per-scan time budget expired or an additional page
  failed to fetch; the scan then uses whatever completed.
- `note` — which pages were skipped/dropped (and why, when it was a budget abort).

| Error | HTTP | When |
| --- | --- | --- |
| SSRF-blocked / invalid URL | `400` | private/loopback/link-local/reserved target, banned hostname, malformed URL |
| Invalid webhook URL | `400` | `webhookUrl` present but not `http(s)://host...` (checked before scanning) |
| Fetch failure | `502` | timeout (>10s), network error, body > 2 MB, too many redirects (>3) |
| Parse failure | `422` | HTML could not be parsed or contained no extractable text |
| Bad JSON | `400` | malformed request body |

### Webhook delivery

When `webhookUrl` is supplied, an asynchronous, **best-effort** delivery of the
exact scan JSON is fired after the scan is persisted — it never blocks and never
fails the `POST /api/v1/scan` response. The delivered payload is byte-for-byte
the response body returned to the caller (including `pages`/`partial`/`note`/
`worstPage` when multi-page):

```json
{ "id": "…", "url": "https://example.com/", "slopScore": 6, "breakdown": {…}, "createdAt": "…" }
```

Request the webhook endpoint receives:

```
POST <webhookUrl>
Content-Type: application/json
X-AISlopScanner-Scan-Id: <scan id>
```

Delivery semantics:

- **Timeout**: each attempt has a 5 s timeout.
- **Retries**: up to 3 attempts with backoff (1 s, 3 s, 9 s between attempts) for
  network errors (timeout, DNS, connection refused) and non-2xx responses.
- **No retry on 4xx**: a 4xx means the customer's endpoint rejected the payload;
  it is logged and delivery is abandoned immediately.
- **Best-effort**: any failure is logged with the scan id + webhook URL via
  `console.error` and is never surfaced in the scan response. The deliverer is
  injectable (`webhookDeliverer` option on the app/router factory) so tests can
  stub it.

### `GET /api/v1/scans/:id`

Returns a stored scan as JSON, or a simple HTML report when the client sends
`Accept: text/html`. The report renders the per-rule table (a module with
`score: null` shows its note instead of a number) plus two phase-2 sections:

- **Worst Page** — the fetched page with the highest combined score
  (`0.7 × v1 + 0.3 × dup`, deterministic tie-break: lowest URL) with top
  findings.
- **Templated Content** — the flagged duplication pairs (both URLs + similarity
  percentage) from `crossPage.pairs`.

## How the Slop Score works

Six deterministic rules run over the extracted page text (and, for crossPage,
over main content of several pages), each returning a score and findings:

| Rule | Weight (full) | Signal measured |
| --- | --- | --- |
| **Filler phrasing** | 15% | occurrences of known slop/AI-buzz phrases, normalized per 300 words |
| **Boilerplate** | 12% | cookie/consent banners, legal boilerplate, newsletter blocks, generic marketing passages |
| **Low info density** | 18% | vocabulary diversity (MATTR-50), stopword ratio, mean sentence length, short-paragraph prevalence |
| **Repetitive structure** | 15% | repeated sentence openings, near-identical sentences, repeated paragraphs |
| **Cross-page duplication** | **30%** | word 4-gram Jaccard similarity of MAIN content across up to 5 pages (highest weight) |
| **Build/tool fingerprints** | 10% | public markers of AI builders (v0.dev, Lovable, Framer, Durable, Replit) + generic template markers |

### Weight tables and renormalization

Full six-category weights (multi-page scans): `filler 0.15, boilerplate 0.12,
infoDensity 0.18, repetitive 0.15, crossPage 0.30, fingerprints 0.10` — total
1.00; **crossPage is the largest single weight**. The four v1 categories keep
their exact v1 *relative* weights (5 : 4 : 6 : 5) in both tables.

When a module is skipped (only crossPage returns `score: null`, which happens
when fewer than 2 pages are discoverable), the composite returns to the exact
v1 four-rule weights `{filler 0.25, boilerplate 0.20, infoDensity 0.30,
repetitive 0.25}` — a single-page scan scores bit-identically to v1. The
fingerprints module still runs and its findings appear in the breakdown, but it
contributes weight 0 in this case so single-page results stay strictly
comparable to v1 (fingerprint evidence enters the score when cross-page
analysis runs). Any other null module would be dropped and the remaining
weights renormalized to sum 1.00 preserving their ratios.

Overall score = `round(Σ weight × score)`, clamped to 0–100. No randomness;
timestamps are stored but never enter the score. Deterministic: identical rule
scores produce an identical overall score, run after run.

### Cross-page duplication (discovery + similarity)

- **Discovery** (`src/rules/discover.js`): after the target page is fetched,
  up to 4 additional same-host pages are found — **total ≤ 5 pages per scan**
  (`MAX_TOTAL_PAGES`). Preferred source: `/sitemap.xml` (and `/sitemap_index.xml`
  if the first is an index), `<loc>` entries parsed with cheerio. Fallback /
  gap-fill: same-host `<a href>` links from the target page, https preferred
  over http, deduped, fragments stripped, obvious non-HTML extensions
  (`.pdf/.jpg/.png/.zip/.mp4/...`) dropped; deterministic sort, capped at 4.
  Every fetch — target, sitemap, every additional page — goes through the same
  SSRF-protected Fetcher (validateUrl + resolveAndCheck per redirect hop), so
  the SSRF protections are never bypassed.
- **Similarity** (`src/rules/similarity.js`): pure-JS **word 4-gram Jaccard**
  over each page's MAIN content only (`extractMainText`: `<main>`/`<article>`,
  else body minus `nav/header/footer/aside/form`), so a shared nav/footer never
  inflates the result. Identical pages → 1.0, disjoint → 0.
- **Threshold**: pairs with similarity ≥ **0.80** are flagged ("near-identical
  page pair"; "duplicated across N pages" for ≥3-page clusters).
- **Score**: no flagged pair → 0; otherwise `round((maxSim − 0.80) / 0.20 × 100)`
  clamped 0–100 (0.80 → 0, 1.00 → 100 — a fully duplicated site). Linear in
  between. The rule result also serializes `pairs: [{pageA, pageB, similarity}]`
  and `pages` (all fetched URLs) for the report.
- **<2 discoverable pages**: the module is skipped gracefully — `{score: null,
  findings: [], note: "insufficient pages for cross-page analysis"}`, never an
  error; the scorer renormalizes as above.

### Per-scan time budget and partial results

One scan budget (`SCAN_BUDGET_MS = 25_000`, injectable in tests) covers target
fetch + discovery + additional fetches + similarity. Additional pages are
fetched concurrently (`Promise.allSettled`); when the deadline elapses,
in-flight work is aborted and whatever completed is used. The response records
`partial: true` + a `note` naming the skipped/dropped pages. A single page that
never responds cannot hang a scan — the budget aborts it and the scan completes
with partial results.

### Build/tool fingerprints (extensible)

`src/rules/fingerprints.json` is a pure pattern list — **no code changes needed
to add fingerprints**. Each entry: `id`, `label`, `confidence` (`high`/`medium`/
`low`), `scope` (`head` = raw `<head>` HTML, `html` = whole raw HTML, `text` =
extracted text), and `patterns` (regex strings). Findings are weighted by
confidence (high 3, medium 2, low 1), normalized against the total weight of
the whole list to 0–100. Wording is pattern-evidence only — "template-like",
"AI-builder-associated", "unmodified-template marker" — the tool never asserts
AI authorship. Only publicly known markers are included (v0.dev/Lovable/Framer/
Durable script & CDN origins, Replit badge, meta generator tags declaring a
builder, "Made with &lt;builder&gt;" footers, Unsplash stock imagery, placeholder-image
services, Font Awesome default icons); no fabricated fingerprints.

## SSRF protection

Hard requirement: the scanner must never reach internal/private networks. Every
URL (and every redirect hop, max 3) is checked before requesting:

1. Protocol must be `http`/`https`.
2. Hostname must not be `localhost`, `*.localhost`, `*.local`, `*.internal`.
3. Literal IPs are checked against blocked ranges.
4. Hostnames are DNS-resolved; if **any** resolved address is blocked, the request
   is refused.

Blocked ranges: IPv4 `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`,
`0.0.0.0/8`, `100.64/10`; IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:…`.
Connect/read timeout 10 s; response body capped at 2 MB. See
`src/fetch/ssrf.js` for the documented list.

## Project layout

```
src/
  server.js          entry point (PORT, default 4000)
  app.js             Express app factory (injectable db path + fetcher for tests)
  budget.js          per-scan time budget (SCAN_BUDGET_MS, injectable)
  db.js              SQLite persistence (data/aislopscanner.db, gitignored; ALTER
                     migration adds partial/note/worst_page for phase 2)
  text.js            deterministic HTML -> text/sentences/words extraction +
                     extractMainText (main content only) + extractHead
  scorer.js          weighted 0–100 combination (+ renormalization when a module
                     is skipped; FULL_RULE_WEIGHTS for 6 categories)
  fetch/
    ssrf.js          URL validation + blocked-range checks + DNS resolution
    client.js        fetch with re-validated redirects, timeout, 2 MB cap;
                     optional external AbortSignal for budget aborts
  routes/
    scan.js          POST /api/v1/scan (pipeline: target -> discovery -> additional
                     fetches -> rules -> score; webhook; partial/pages/worstPage)
    scans.js         GET /api/v1/scans/:id (+ HTML report: Worst Page,
                     Templated Content sections)
  webhook.js         webhookUrl validation + async best-effort deliverer (retries)
  rules/
    index.js         runRules() aggregator (the four v1 rules)
    filler.js        Rule A   boilerplate.js   Rule B
    infoDensity.js   Rule C   repetitive.js    Rule D   (unchanged in phase 2)
    similarity.js    word 4-gram Jaccard (pure JS)
    discover.js      sitemap-first discovery, link fallback, MAX_TOTAL_PAGES=5
    crossPage.js     cross-page duplication rule (threshold 0.80, score mapping)
    fingerprints.js  build/tool fingerprint matcher (loads fingerprints.json)
    fingerprints.json  extensible pattern list (no code changes to add entries)
test/                node:test suites (ssrf, rules/scorer, API pipeline, webhook,
                     phase2: similarity/discovery/fingerprints/scorer + integration
                     against local fixture sites incl. budget-expiry)
```

## Docker (production: Node 20 on Alpine)

```bash
docker build -t aislopscanner .
docker run --rm -p 4000:4000 -v "$(pwd)/data:/app/data" aislopscanner
```

> Note: `better-sqlite3` is a native module; the Alpine image installs
> `python3 make g++` as build dependencies (no musl prebuilds are published).