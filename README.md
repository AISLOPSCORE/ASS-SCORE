# AISlopScanner

Deterministic, rule-based **Slop Score** scanner for public websites. No AI models,
no LLM calls, no external scoring APIs — the same URL in yields the same score, every
time. A micro-SaaS service: submit a URL over HTTP, get a 0–100 score with a
per-rule breakdown, stored in SQLite.

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

Response `200`:

```json
{
  "id": "7d5f2b1a-...",
  "url": "https://example.com/",
  "slopScore": 6,
  "breakdown": {
    "filler":       { "score": 0, "findings": ["0 filler phrase occurrence(s) in 112 words (0.0 per 300 words)"] },
    "boilerplate":  { "score": 0, "findings": ["0 boilerplate signal(s) in 112 words (0.0 per 300 words)"] },
    "infoDensity":  { "score": 33, "findings": ["vocabulary diversity (MATTR-50): 0.812 ...", "..."] },
    "repetitive":   { "score": 0, "findings": ["no notable repetitive structure (7 sentences, 4 paragraphs)"] }
  },
  "createdAt": "2026-09-08T18:50:00.000Z"
}
```

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
the response body returned to the caller:

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
`Accept: text/html`.

## How the Slop Score works

Four deterministic rules run over the extracted page text, each returning a
score and findings:

| Rule | Weight | Signal measured |
| --- | --- | --- |
| **Filler phrasing** | 25% | occurrences of known slop/AI-buzz phrases (`in today's fast-paced world`, `game-changer`, `delve into`, `unlock the`, `revolutionize`, `cutting-edge`, `seamless`, `elevate`, `furthermore`, `moreover`, `it's no secret`, `ever-evolving`, `landscape`, `robust`, ... — full list in `src/rules/filler.js`), normalized per 300 words |
| **Boilerplate** | 20% | cookie/consent banners, legal boilerplate, newsletter blocks, generic marketing passages, repeated low-variation blocks (duplicate paragraphs) |
| **Low info density** | 30% | vocabulary diversity (moving-average type–token ratio, window 50), stopword ratio, mean sentence length, short-paragraph prevalence |
| **Repetitive structure** | 25% | repeated sentence openings (first 3 words), near-identical sentences, repeated paragraphs |

Overall score = `round(filler·0.25 + boilerplate·0.20 + infoDensity·0.30 + repetitive·0.25)`,
clamped to 0–100. No randomness; timestamps are stored but never enter the score.

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
  db.js              SQLite persistence (data/aislopscanner.db, gitignored)
  text.js            deterministic HTML -> text/sentences/words extraction
  scorer.js          weighted 0–100 combination (documented weights)
  fetch/
    ssrf.js          URL validation + blocked-range checks + DNS resolution
    client.js        fetch with re-validated redirects, timeout, 2 MB cap
  routes/
    scan.js          POST /api/v1/scan (validates webhookUrl, fires async delivery)
    scans.js         GET /api/v1/scans/:id (+ HTML report)
  webhook.js         webhookUrl validation + async best-effort deliverer (retries)
  rules/
    index.js         runRules() aggregator
    filler.js        Rule A
    boilerplate.js   Rule B
    infoDensity.js   Rule C
    repetitive.js    Rule D
test/                node:test suites (ssrf, rules/scorer, API pipeline, webhook)
```

## Docker (production: Node 20 on Alpine)

```bash
docker build -t aislopscanner .
docker run --rm -p 4000:4000 -v "$(pwd)/data:/app/data" aislopscanner
```

> Note: `better-sqlite3` is a native module; the Alpine image installs
> `python3 make g++` as build dependencies (no musl prebuilds are published).