# A.S.S. Score

Deterministic, rule-based **A.S.S. Score (AI Slop Score)** scanner for public
websites, at **ass-score.com**. No AI models, no LLM calls, no external scoring
APIs — the same URL in yields the same score, every time. A micro-SaaS service:
submit a URL over HTTP, get a 0–100 A.S.S. Score with a per-rule breakdown,
stored in SQLite. Same input → same score, every run.

The metric is named the **A.S.S. Score** consistently across the product;
"AI Slop Score" appears only descriptively/parenthetically for SEO clarity. The
tool never asserts AI authorship — findings are pattern-based ("template-like",
"AI-builder-associated", "duplicated across N pages").

## Quickstart

```bash
npm install
npm start          # listens on PORT (default 4000)
npm test           # node:test unit + API tests (no network required)
```

## API

### `POST /api/v1/scan`

Request (optionally with a callback `webhookUrl`, white-label `branding`, and a
delivery `email`):

```bash
curl -s -X POST http://localhost:4000/api/v1/scan \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com",
    "webhookUrl": "https://hooks.example.com/scan-complete",
    "branding": {
      "agencyName": "Acme Agency",
      "logoUrl": "https://acme.example/logo.png",
      "accentColor": "#336699",
      "footerText": "Audit prepared by Acme Agency"
    },
    "email": "owner@example.com"
  }'
```

`webhookUrl` is optional. Missing or empty means no webhook delivery. It must be
an `http://` or `https://` URL with a host — anything else (wrong scheme, no
host, non-string) is a `400 invalid_webhook_url` that fails fast BEFORE the
target is scanned. It is a callback URL, not a scan target, so the SSRF range
checks are deliberately **not** applied to it; only scheme + host presence are
validated (via `new URL`). Actual DNS/connectivity problems surface at delivery
time and are logged, never propagated to the caller.

`branding` is optional white-label report branding (see
[White-label report branding](#white-label-report-branding)). `email` is an
optional report-delivery address (see
[Email delivery](#email-delivery)). Both are validated BEFORE any scanning;
invalid values are `400 invalid_branding` / `400 invalid_email` with the scan
never started.

**Score direction (public A.S.S. Score): 0-100, HIGHER = WORSE.** 0 = clean /
actually good, 100 = maximum ass. Every scan response carries `score` (the
public A.S.S. Score, a clamped 0-100 integer) and `verdict` (the grade label,
e.g. `VERY ASS`). `breakdown.<category>.score` is on the same scale (higher =
worse); `findings`/`evidence`/`pages`/`pairs`/`roast`/`partial` describe
problems and are unchanged. **Storage matches the public direction**: the DB
column and the stored breakdown hold the same higher = worse scores, so rows
written before the temporary flip experiment read correctly with no migration
— the serialization boundary (`src/serialize.js`) only relabels, it does not
invert. `worstPage.score` is in the same direction (higher = worse); treat it
as "how much slop this page has". Lower is better everywhere: the improvement
story is "I took my A.S.S. Score from 83 down to 21".

Response `200` (single-page site — the v1 shape, unchanged for single-page scans):

```json
{
  "id": "7d5f2b1a-...",
  "url": "https://example.com/",
  "score": 70,
  "verdict": "VERY ASS",
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
  "id": "...", "url": "https://site.example/", "score": 48, "verdict": "MILDLY GENERIC", "breakdown": { "...": "..." },
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
| Invalid branding | `400` | `branding` present but malformed (checked before scanning) |
| Invalid email | `400` | `email` present but not an address (checked before scanning) |
| Fetch failure | `502` | timeout (>10s), network error, body > 2 MB, too many redirects (>3) |
| Parse failure | `422` | HTML could not be parsed or contained no extractable text |
| Bad JSON | `400` | malformed request body |
| Per-IP daily cap exceeded | `429` | `error.code "rate_limited"` + `resetAt` (next UTC midnight) — see [Rate limiting](#rate-limiting) |

**Rate limiting.** `POST /api/v1/scan` has a per-IP daily cap on **accepted
scans** — a request only counts once its URL passed the SSRF guard and every
shape validation; all `400`s (malformed URL, blocked target, bad
`webhookUrl`/`branding`/`email`) are free. Over the cap the API returns
`429 { error: { code: "rate_limited", message: "Daily scan limit reached for
this IP (N scans per day). New scans unlock at UTC midnight.",
resetAt: "<next UTC midnight ISO>" } }`. The count lives in the SQLite
`scan_events` ledger (per IP per UTC day), is configured with
`MAX_SCANS_PER_DAY` (default `3`, `0` disables), and is **independent** of the
webhook cap — see [Rate limiting](#rate-limiting) for details. The client IP is
`X-Forwarded-For` (the app trusts one proxy hop) with socket fallback; note
that any proxy in front of the app must overwrite/sanitize `X-Forwarded-For`
for the cap to be meaningful.

### Webhook delivery

When `webhookUrl` is supplied, an asynchronous, **best-effort** delivery of the
exact scan JSON is fired after the scan is persisted — it never blocks and never
fails the `POST /api/v1/scan` response. The delivered payload is byte-for-byte
the response body returned to the caller (including `pages`/`partial`/`note`/
`worstPage` when multi-page):

```json
{ "id": "…", "url": "https://example.com/", "score": 94, "verdict": "CATASTROPHICALLY ASS", "breakdown": {…}, "createdAt": "…" }
```

Request the webhook endpoint receives:

```
POST <webhookUrl>
Content-Type: application/json
X-Ass-Score-Scan-Id: <scan id>
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

### `POST /api/v1/webhook` — paid-order fulfillment

Accepts order webhooks from **Fiverr**, **Stripe Checkout**, and
**LemonSqueezy**, extracts the ordered scan target, the client's brand name and
email, and triggers a REAL scan through the exact same pipeline as
`POST /api/v1/scan` (shared `runScan` in `src/scan.js`). On completion the
client is emailed the report link via the existing best-effort email sender —
an email failure never fails the webhook response. This is the automation that
fulfills paid scan orders without the dashboard.

```bash
curl -s -X POST http://localhost:4000/api/v1/webhook \
  -H 'content-type: application/json' \
  -d '{ "type": "checkout.session.completed", "data": { "object": {
         "id": "cs_test_abc123",
         "customer_email": "buyer@example.com",
         "metadata": { "target_url": "https://example.com",
                       "business_name": "Example Brand",
                       "client_email": "client@example.com" } } } }'
```

Response contract:

| Outcome | HTTP | Body |
| --- | --- | --- |
| Accepted — scan queued (runs async) | `202` | `{ "accepted": true, "status": "queued", "provider", "eventId", "targetUrl", "businessName", "emailDeliveredTo" }` |
| Replayed event id — already processed | `200` | `{ "accepted": true, "status": "already_processed", "note": "already processed", "scanId", ... }` |
| Malformed / unknown provider payload | `400` | `error.code "invalid_payload"` with a reason |
| SSRF-blocked / invalid target URL | `400` | `error.code "blocked"` (same guard as `/scan`) |
| Malformed client email | `400` | `error.code "invalid_email"` (missing email is allowed — order still scans, email skipped) |
| Per-IP daily cap exceeded | `429` | `error.code "rate_limited"` (see [Rate limiting](#rate-limiting)) |
| Genuine internal error | `500` | `error.code "internal_error"` |

**Internal order shape.** All three providers normalize to
`{ targetUrl, businessName?, clientEmail }` (`src/orderNormalizer.js`), plus a
provider event id used as the idempotency key. Detection and extraction are
explicit and tolerant:

- **Fiverr** — marker: top-level `type`/`event_type` starting with `ORDER`
  (e.g. `ORDER_CREATED`) with `data.order`. `eventId` from `order.id`; the
  target URL is the first `http(s)://` string found in `order.requirements`
  (or `requirement`/`message`/`url`/`link` — buyers paste the site to scan);
  `businessName` from `order.business_name` / `brand_name` / `company_name` /
  `title` / `gig.title`; `clientEmail` from `order.buyer.email` /
  `buyer_email` / `email` (Fiverr often omits buyer email in webhooks — when
  absent the order still scans, just no email).
- **Stripe Checkout** — marker: `type === "checkout.session.completed"` with
  `data.object`. Assumed metadata keys on the checkout session **`metadata`**:
  - `metadata.target_url` — the website to scan (**required**)
  - `metadata.business_name` — client brand (optional; `businessName`,
    `brand_name`, `company_name` also accepted)
  - `metadata.client_email` — report recipient (optional; falls back to
    `customer_email`, then `customer_details.email`)
- **LemonSqueezy** — marker: `meta.event_name` like `order_created` /
  `payment_*` or `data.type === "orders"`. Assumed fields: `data.id` is the
  event id; `meta.custom_data.target_url` (custom checkout field) with
  fallbacks `custom_data.url`/`website` and `attributes.target_url`/`url`/
  `website`; `meta.custom_data.business_name` with `attributes.business_name`
  fallback; `clientEmail` from `meta.custom_data.client_email`, else
  `attributes.user_email` / `payer_email` / `meta.customer_email`.

Anything that matches no provider shape (or misses a target URL) is a `400
invalid_payload` with the provider/reason named — never a crash.

**Idempotency.** When the provider supplies an event id, it is stored in the
SQLite `webhook_events` ledger (`<provider>:<eventId>`); a replayed event
returns `200 already_processed` (with the original `scanId` once completed)
and **never creates a second scan**. Events without an id are processed
normally (rate limit still applies) but cannot be deduplicated.

### Rate limiting

Both endpoints carry per-IP per-UTC-day caps backed by
SQLite ledgers; they count **accepted** requests only (every `400` validation
failure is free) and are fully **independent** — the `webhook_events` and
`scan_events` tables never share counts, so a paid order webhook never eats a
free scan slot and vice versa:

| Endpoint | Env var | Default | Ledger | Over cap → |
| --- | --- | --- | --- | --- |
| `POST /api/v1/webhook` | `MAX_WEBHOOKS_PER_DAY` | `10` | `webhook_events` | `429 rate_limited` |
| `POST /api/v1/scan` | `MAX_SCANS_PER_DAY` | `3` | `scan_events` | `429 rate_limited` (+ `resetAt`) |

`0` disables either cap. Scans triggered by accepted order webhooks run
through `runScan` directly and are **not** debited from `MAX_SCANS_PER_DAY`.
The client IP comes from `X-Forwarded-For` (one trusted proxy hop) with the
socket address as fallback — see `src/clientIp.js`.

**Delivery.** After the scan completes, the report link is emailed to the
client's address with the existing soft-fail sender (see
[Email delivery](#email-delivery)): report URL = `GET /api/v1/scans/:id`
(public HTML report at `{PUBLIC_BASE_URL}/scan/{id}`), including the Slop Roast
on the report page. Sending is best-effort and asynchronous — the `202` is
returned first.

### White-label report branding

Agencies can inject their own branding into a scan request; the metric stays
the **A.S.S. Score** and the mandated disclaimer is never removed or obscured —
white-label changes the chrome, not the score name or the disclaimer. `branding`
is an optional object on `POST /api/v1/scan`:

| Field | Type | Rules |
| --- | --- | --- |
| `agencyName` | string | 1–120 chars after trim; rendered as the report header (the "A.S.S. Score report" title + "powered by A.S.S. Score" line stay visible) |
| `logoUrl` | string | must be an `http(s)` URL with a host; rendered as an `<img>` at the top of the HTML report (attrs escaped, scheme re-checked at render) |
| `accentColor` | string | hex color `#rgb`, `#rrggbb` or `#rrggbbaa`; applied via inline style to the agency header and the score number |
| `footerText` | string | 1–200 chars after trim; rendered as an extra footer line (the disclaimer + score id are always rendered too) |

Unknown keys are ignored; empty-after-trim fields are dropped. Anything
malformed (wrong types, non-http(s) logo, non-hex accent, over-long values)
is `400 invalid_branding` **before** the scan starts. Missing `branding` =
default A.S.S. Score branding.

The normalized `branding` is persisted with the scan (SQLite `branding`
TEXT/JSON column, added by an idempotent ALTER migration — old rows/`NULL`
render the default report) and is included in:
- the `POST /api/v1/scan` response (`branding` key, only when supplied),
- the webhook payload (bytes-exact same object),
- `GET /api/v1/scans/:id` JSON (`branding` key, when stored).

The HTML report renders it (agency header, logo, accent color, footer); the
share card renders only the `agencyName` as a small line under the product
brand row — everything else on the card is unchanged. All branding values are
HTML/XML-escaped (hostile values render as inert text; the report still shows
the A.S.S. Score, the emoji category labels, and the disclaimer).

### Email delivery

If `POST /api/v1/scan` includes `email`, an email report is sent to that
address **asynchronously after the 200 response**, with the same best-effort
semantics as webhooks: it never blocks or fails the scan, failures are retried
(up to 3 attempts, backoff 1 s / 3 s / 9 s) and logged, and delivery never
rejects. `email` must look like an address — anything else is
`400 invalid_email` before the scan. Missing/empty means no delivery.

The email body is built by `src/email.js`: an "A.S.S. Score" brand header, the
score, the scanned URL, the one-line verdict, a link to the public report
(`{PUBLIC_BASE_URL}/scan/{id}`), and the mandated disclaimer, in plain text +
a simple HTML body. Sender name is **A.S.S. Score**
(`A.S.S. Score <no-reply@ass-score.com>`, overridable via `SMTP_FROM`, or
`RESEND_FROM` on the Resend transport).

**Transport precedence (the `createEmailSender` factory in `src/email.js`):**

| # | When | Transport |
| --- | --- | --- |
| 1 | `RESEND_API_KEY` set | **Resend API** — `POST https://api.resend.com/emails` with `Authorization: Bearer <RESEND_API_KEY>` and JSON body `{ from, to, subject, html }` (from = `RESEND_FROM` ?? `SMTP_FROM` ?? `A.S.S. Score <onboarding@resend.dev>`). Uses Node's global fetch — no SDK, no new dependencies. |
| 2 | `SMTP_HOST` set | **Nodemailer over SMTP** (existing behavior, unchanged) |
| 3 | neither | **No-op** — logs `email not configured`, returns `{ ok: false, configured: false }` |

The Resend transport has the same soft-fail contract as SMTP: it never throws
into the request path, transient failures (HTTP 5xx / network errors) are
retried up to `maxAttempts` (default 3) with backoff 1 s / 3 s / 9 s, and HTTP
4xx responses are **not** retried (a client-side rejection would never succeed
on retry — same convention as the webhook deliverer). All failures and the
final give-up are logged; a 4xx or persistent failure returns
`{ ok: false, configured: true, attempts, error }`.

> **From-domain must be verified with Resend before production sends.** While
> `RESEND_API_KEY` is set but neither `RESEND_FROM` nor `SMTP_FROM` is, the
> sandbox default `A.S.S. Score <onboarding@resend.dev>` is used and a warning
> is logged telling you to verify a real sending domain and set `RESEND_FROM`.

**Subject decision.** The owner spec asks to spam-test subject lines and keep a
fallback ready. Real spam-testing needs a live SMTP provider, so the shipped
default is the CONSERVATIVE primary `"Your website audit is ready"`
(deliverability-safe: no emoji, no brand token, unlikely to trip filters). The
branded variant `"Your A.S.S. Score is ready 🔴"` exists and is selectable via
`EMAIL_SUBJECT` (or the `emailSubject` app option) — swap it in once the team
inbox can A/B test against real delivery.

**Required env vars at deploy (to turn email ON — Resend preferred):**

| Env | Meaning | Default |
| --- | --- | --- |
| `RESEND_API_KEY` | Resend API key — makes Resend the transport | **unset → falls through to SMTP / no-op** |
| `RESEND_FROM` | sender address for Resend (must be a verified domain) | `SMTP_FROM`, else `A.S.S. Score <onboarding@resend.dev>` (logs a warning) |
| `SMTP_HOST` | SMTP server (e.g. `smtp.postmarkapp.com`) | **unset → email is a no-op** (unless Resend is used) |
| `SMTP_PORT` | SMTP port | `587` (or `465` when `SMTP_SECURE=true`) |
| `SMTP_SECURE` | `"true"` for implicit TLS on 465 | `false` |
| `SMTP_USER` | auth username | — |
| `SMTP_PASS` | auth password | — |
| `SMTP_FROM` | SMTP sender address / Resend from-fallback | `A.S.S. Score <no-reply@ass-score.com>` |
| `EMAIL_SUBJECT` | subject line variant | `Your website audit is ready` |
| `PUBLIC_BASE_URL` | report-link base | `https://ass-score.com` |

**No credentials → nothing breaks.** When neither `RESEND_API_KEY` nor
`SMTP_HOST` is present, the default sender is a no-op that logs `[email] email
not configured (set RESEND_API_KEY, or SMTP_HOST/...)` and returns
`{ ok: false, configured: false }` — the scan still succeeds with `200`. The
transport is injectable: the `emailSender` app option is an
`async (scan, to) => result` function, so tests (and future swaps to other
providers) stub or script the transport. No real email is ever sent unless
`RESEND_API_KEY` (preferred) or `SMTP_*` credentials are present in the
environment.

### `GET /api/v1/scans/:id`

Returns a stored scan as JSON, or a simple HTML report when the client sends
`Accept: text/html`. The report is branded: the headline metric is the
**A.S.S. Score**, the breakdown rows carry emoji-tagged category labels
(e.g. `🤖 AI-like copy`, `🔁 Duplicate language across pages` — display only;
the JSON keys stay `filler`/`boilerplate`/`infoDensity`/`repetitive`/
`crossPage`/`fingerprints`), and every report carries the mandated disclaimer
verbatim:

> This tool identifies writing and design patterns commonly associated with
> generic or templated content. It does not detect AI authorship and is not
> proof that any content was AI-generated.

The report renders the per-rule table (a module with
`score: null` shows its note instead of a number) plus two phase-2 sections:

- **Worst Page** — the fetched page with the highest combined score
  (`0.7 × v1 + 0.3 × dup`, deterministic tie-break: lowest URL) with top
  findings.
- **Templated Content** — the flagged duplication pairs (both URLs + similarity
  percentage) from `crossPage.pairs`.

### Three-layer findings (`insights`)

Every scan's breakdown categories carry **three-layer insights** — the product's
spine (spec §5). Each category object gains an `insights` array, one entry per
finding (capped at **6** per category, first findings in list order; `insight[i]`
corresponds to `findings[i]`):

```json
"filler": {
  "score": 40,
  "findings": ["3× \"cutting-edge\"", "..."],
  "insights": [
    {
      "roast": "\"cutting-edge\" appears 3× on this page. Bold words from a phrase that means nothing.",
      "why": "Filler phrases signal that the copy was written to sound impressive, not to inform — and visitors who smell vague marketing lose trust in seconds.",
      "fix": "Delete each flagged phrase and replace it with plain English that names a real outcome — \"elevate your brand\" becomes \"we redesign menus for restaurants.\"",
      "evidence": "3× \"cutting-edge\""
    }
  ]
}
```

- **Shape** — `{ roast, why, fix, evidence }` per insight, where `evidence` is
  the finding string itself (the trigger the other three layers are about).
  `roast` is funny, blunt and SPECIFIC: it interpolates `{tokens}` from the
  finding's real parsed evidence (the exact phrase, label, sentence, page URLs,
  image host/alt, counts). When a finding carries verbatim-evidence tokens, the
  roast MUST cite at least one of them — a roast never fabricates a detail it
  cannot point at. Findings with no interpolatable token fall back to
  group-level roasts that still reference the summary values.
- **Where the copy lives** — `src/threeLayer.json`, one pool per breakdown
  category (`roasts`, `whys`, `fixes`). Editable WITHOUT code changes; token
  names per group are documented in the file's `_comment`. House style matches
  `src/roasts.json`: loud, meme-friendly, pattern-based only, never asserting
  AI authorship (automated forbidden-phrase test).
- **Determinism** — selection is seeded by scan id + category + finding index
  through the same FNV-1a `hashScanId` the Slop Roast uses (`src/threeLayer.js`).
  Same scan id → identical insights, forever; a fresh rescan (new id) may pick
  different variants — that freshness is what keeps repeated free scans from
  reconstructing the paid report, and it is still never random.
- **Persistence** — insights are attached at scan time and stored inside the
  breakdown JSON column, so every surface (JSON, webhook, email, HTML report)
  is stable. Legacy rows written before the feature derive insights on read
  with the same deterministic function (`withInsights` is idempotent: stored
  insights always win). The HTML report renders each insight under its
  evidence line (evidence bold; roast italic/accent; why/fix small and muted).
- **Additive** — scores, findings, verdicts, the score flip and rate limiting
  are untouched; `insights` is a new key on each category object.

### `GET /api/v1/scans/:id/card`

The **shareable result card** — the viral distribution feature. Returns a
**1200×630 PNG** (the Open Graph / social-preview standard) showing, on a clean
dark-brand gradient:

- the **A.S.S. Score** big and color-coded by verdict band (e.g. `73 / 100`),
- the scanned URL (host + path, entity-escaped, truncated to fit),
- a **one-line verdict by score band** (see below),
- the footer `ass-score.com · A.S.S. Score (AI Slop Score)` and the mandated
  disclaimer in tiny print.

```bash
curl -s http://localhost:4000/api/v1/scans/<id>/card -o card.png
```

- `Content-Type: image/png`, `Cache-Control: public, max-age=60`.
- **Deterministic**: the same scan id always returns byte-identical PNG
  (`buildCardSvg` has no timestamps/randomness; verified by test — two renders
  sha256-equal).
- **SSRF/XML-safe**: every user-derived string (URL, verdict) is entity-escaped;
  a hostile URL cannot inject SVG markup (tested).
- **White-label**: when the scan carried `branding.agencyName`, the card adds a
  small agency line under the product brand row (escaped, elided to fit);
  every other pixel is identical to the default card.
- Invalid/missing id → `404` with the same JSON error shape as
  `GET /api/v1/scans/:id`.

**Verdict bands** (single source of truth: `src/verdict.js`, consumed by the
JSON response, the HTML report and the share card — higher = worse, green =
low/good, red = high/bad):
| Score | Verdict | Accent |
| --- | --- | --- |
| 90-100 | CATASTROPHICALLY ASS / certified slop | red |
| 75-89 | EXTREMELY ASS | orange |
| 55-74 | VERY ASS | yellow |
| 35-54 | MILDLY GENERIC | lime |
| 0-34 | CLEANEST / most original | green |

### `GET /api/v1/scans/:id/share`

Pre-filled social share text + public result URL, for copy-to-clipboard:

```bash
curl -s http://localhost:4000/api/v1/scans/<id>/share
# {"url":"https://ass-score.com/scan/<id>",
#  "text":"My website scored 73/100 on the A.S.S. Score (AI Slop Score). Check yours: https://ass-score.com/scan/<id>"}
```

The share URL points at the (future) public result page `/scan/<id>`. Its base
is configurable via the `publicBaseUrl` app option (default
`PUBLIC_BASE_URL` env, falling back to `https://ass-score.com`) — so a
deployment behind another origin can emit correct share links without a code
change.

**How the card is rendered.** No headless browser, no screenshots. The card is
composed as a deterministic SVG string and rasterized to PNG with
**sharp** (libvips' built-in SVG loader) — cheap (~100 ms), dependency-light,
byte-deterministic, and it runs fine on Railway/Alpine with sharp's prebuilt
binaries. The Dockerfile installs `font-dejavu` because Alpine ships no fonts
by default and SVG text needs one.

## How the A.S.S. Score works

Seven deterministic rules run over the extracted page text, the raw HTML, and
(for crossPage) main content of several pages — each returning a score and
findings:

| Rule | Weight (full) | Signal measured |
| --- | --- | --- |
| **Filler phrasing** | 12.5% | occurrences of known slop/AI-buzz phrases, normalized per 300 words |
| **Boilerplate** | 10% | cookie/consent banners, legal boilerplate, newsletter blocks, generic marketing passages, **hedge phrases** ("we aim to", "world-class", … — Copy Slop) |
| **Low info density** | 15% | vocabulary diversity (MATTR-50), stopword ratio, mean sentence length, short-paragraph prevalence, **concrete-specifics gap** (Copy Slop: <1 specific per 75 words) |
| **Repetitive structure** | 12.5% | repeated sentence openings, near-identical sentences, repeated paragraphs |
| **Cross-page duplication** | **30%** | word 4-gram Jaccard similarity of MAIN content across up to 5 pages (highest weight) |
| **Build/tool fingerprints** | 10% | public markers of AI builders (v0.dev, Lovable, Framer, Durable, Replit) + generic template markers |
| **Asset slop** | 10% | stock/placeholder image CDN origins, placeholder/generic filenames, missing/generic alt text |

### Weight tables and renormalization

Full seven-category weights (multi-page scans): `filler 0.125, boilerplate
0.10, infoDensity 0.15, repetitive 0.125, crossPage 0.30, fingerprints 0.10,
assets 0.10` — total 1.00; **crossPage is the largest single weight**. The four
v1 categories keep their exact v1 *relative* weights (5 : 4 : 6 : 5) in both
tables; **assets** (the phase-3 addition) carries 0.10 — comparable to
fingerprints: stock/placeholder imagery is a strong slop signal, but not the
dominant one, and it never outranks site-wide duplication. Adding assets
diluted every pre-existing full-table weight proportionally (the previous
six-category table was `filler 0.15, boilerplate 0.12, infoDensity 0.18,
repetitive 0.15, crossPage 0.30, fingerprints 0.10`); crossPage kept its 0.30
because duplication remains the strongest signal.

When a module is skipped (only crossPage returns `score: null`, which happens
when fewer than 2 pages are discoverable), the composite returns to the exact
v1 four-rule weights `{filler 0.25, boilerplate 0.20, infoDensity 0.30,
repetitive 0.25}` — a single-page scan scores bit-identically to v1. The
fingerprints and assets modules still run and their findings appear in the
breakdown, but they contribute weight 0 in this case so single-page results
stay strictly comparable to v1 (evidence-based categories enter the score when
cross-page analysis runs). Any other null module would be dropped and the
remaining weights renormalized to sum 1.00 preserving their ratios.

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
services, Font Awesome default icons) plus generic **layout-trope class
patterns** (hero sections, gradient utilities, bento/card grids,
feature/services/testimonial/pricing/CTA sections, stats/logo-cloud/FAQ/team
blocks); no fabricated fingerprints.

### Asset slop (editable CDN list + alt rules)

`src/rules/assets.json` is a **pure pattern list — no code changes needed to
add signal**. It detects stock/placeholder imagery from `<img>` tags only
(HTML attributes: `src` / `data-src` / first `srcset` candidate) — **no image
downloads, no headless browser, no image analysis**, fully deterministic:

- `stockImageHosts` — hostname suffixes of stock-image CDNs and placeholder
  services (Unsplash, Pexels, Pixabay, Shutterstock, iStock, Getty, Adobe
  Stock, Freepik, via.placeholder.com, placehold.co, dummyimage.com,
  picsum.photos, placeholdit.imgix.net). A host matches when it equals or
  ends with one of these (so `images.unsplash.com` and `media.gettyimages.com`
  hit; `unsplash.com.evil.test` and relative paths never do).
- `placeholderFilenamePatterns` — regex strings matched (case-insensitively)
  against the image filename stem: `placeholder*`, `dummy*`, `screenshot`,
  `imageN`/`photoN`/`imgN`, a bare `logo`, `spacer`, `1x1`, `blank`,
  `pixel`, `transparent`.
- `genericAltTexts` — exact alt values considered generic after trim +
  lowercase (image, photo, picture, placeholder, screenshot, img, pic,
  thumbnail). Alt is flagged as missing when the attribute is absent, as
  empty when it is `""` or whitespace-only (decorative-vs-content logic is
  deliberately not applied — simple and deterministic), and as generic when
  it matches the list.

**Scoring** (deterministic): `round(clamp(100 × (0.50 · stockCdnShare +
0.25 · filenameShare + 0.25 · altShare), 0, 100))` over all `<img>` tags —
a page whose every image is stock-hosted, placeholder-named **and** alt-less
scores 100; half its images from a stock CDN alone scores 25. No images →
score 0, no findings. Findings read "N of M images from stock/placeholder
CDNs", "…with placeholder/generic filenames", "…with missing or generic alt
text" plus per-image details (capped at 8 per signal so the report stays
bounded). **Effect on the overall score:** assets is a full-table category
(weight 0.10 in multi-page scans), so stock-heavy pages score up to 10 points
higher from imagery alone; like fingerprints, it contributes weight 0 to
single-page scans (v1 bit-identity preserved) — its breakdown stays visible
there, the score does not move. Breakdown key: `assets` (JSON
`breakdown.assets = { score, findings }`); HTML report row: "🖼️
Stock/placeholder imagery".

### Copy slop (hedging + concrete specifics)

The Copy Slop extension folds two deterministic copy-quality dimensions into
the EXISTING seven categories — no new breakdown key, no weight changes:

**1. Hedge phrases → boilerplate findings.** Vague marketing constructions are
generic marketing language, so their hits join the boilerplate category's
density math and findings. The phrase list lives in `src/rules/copySlop.json`
(`hedgePhrases` — **edit the file, no code change**): 38 phrases covering the
"we aim/strive/goal" family (`we aim to`, `we strive to`, `our goal is to`,
`our goal is simple`), the "we're here/we understand" family, `we pride
ourselves on`, `we're thrilled`, `we look forward to`, `at the heart of
everything we do`, `in today's fast-paced world`, `seamless experience`,
`innovative solutions`, `cutting-edge`, `state-of-the-art`, `best-in-class`,
`leading provider`, `world-class`, `unlock your potential`, `take it to the
next level`, `revolutionize`, `empower`, `game-changing`, `synergy`, `we're
committed to`, `our mission is simple`, `your trusted partner`, `we are
passionate about`, `your success is our`, `exceed your expectations`, `helping
you`/`helping businesses`, `your journey`, `tailored solutions`. Matching is
lowercased/trimmed substring counting (case-insensitive; `"We Aim To"` hits).
Every hit is counted and the EXACT sentence containing the phrase is quoted in
the findings (`hedge evidence: "We aim to empower your journey."`), capped at 8
quotes so the report stays bounded. The phrase list is deliberately DISJOINT
from the boilerplate rule's own regexes (checked by `test/copySlop.test.js`) so
a single sentence is never double-counted inside the boilerplate category —
phrases the boilerplate rule already owns (`we are committed to`, `we are
dedicated to`, `driven by passion`, `our mission is to`, ...) are not repeated
here. Some phrases also appear in the filler rule's list (e.g. `cutting-edge`,
`world-class`) — that is fine and intended: filler and boilerplate are separate
categories, and the same construction can be both buzz and hedge.

**2. Concrete specifics gap → infoDensity findings.** Substance is an
information-density concern. The rule counts concrete specifics in the visible
copy — digits and numbers (`10,000`, `99.9`), currency (`$2`, `£4.5M`),
percentages (`23%`), dates/years (`2013`, `March 2022`, `12 March 2022`), named
brands (`knownNames` list in `copySlop.json`, e.g. Apple, Adobe, AWS, Figma,
Google, Shopify, Zoom), and capitalized multi-word proper nouns (sentence-
initial capitals are skipped — grammar, not a name). Overlapping spans count
once (`2022` is a year, not a "number and a year"; `$99` is currency).
Threshold: at least **1 concrete specific per 75 words**
(`specificsPerWords` in the config). Below that the page is vague-by-default
and infoDensity gets a findings line with the exact count and quoted examples:
`concrete specifics: 0 found in 210 words — no dates, numbers, prices,
percentages, or named references (need at least 3 per 75 words)`, or the count
variant `concrete specifics: only 2 in 265 words (need at least 4 per 75
words) — e.g. 2022, 3`. A 0–100 gap penalty (proportional: 100 when nothing
concrete at all, smaller for "almost enough") is ADDED to the infoDensity
score. When specifics are plentiful the penalty is exactly **0** and no finding
is emitted — legitimately specific pages are never penalized. Detection is
conservative on purpose (digits/dates/currency are the strongest signals; names
are optional), so a number-free technical page is treated as vague even when
its vocabulary is precise.

**Which categories carry the findings:** hedges → `boilerplate` (`🥱 Generic
marketing language` row in the HTML report; `breakdown.boilerplate.findings` in
JSON, with `N× hedge phrase "…"` labels + `hedge evidence: "…"` quotes); the
specifics gap → `infoDensity` (`📋 Repeated/template content` row;
`breakdown.infoDensity.findings`). Surfaces pick them up automatically — JSON,
HTML report, persisted breakdown, and webhook payload all carry the same
strings. Score effect: hedges raise the boilerplate density (a hedge-heavy page
scores high in boilerplate); a specifics gap raises the infoDensity score. No
new breakdown keys, no weight-table changes — single-page v1 bit-identity and
the seven-category table are untouched.

**How to edit:** add/remove phrases in `src/rules/copySlop.json`
(`hedgePhrases`, `knownNames`, `specificsPerWords`, `maxEvidenceQuotes`) — no
code changes. The rule module is `src/rules/copySlop.js`
(`analyzeHedges`/`analyzeSpecifics`, pure and deterministic); the disjointness
guarantee vs the boilerplate regexes is enforced by the test suite.

### Slop Roast
Every scan gets a punchy on-brand one-liner (the "roast") on top of the score.
It is **deterministic, never random, and never an AI-authorship claim**: the
copy pokes at the *evidence* the rules found (template-like wording, duplicated
pages, thin content, builder fingerprints, stock imagery).

- **Pools file:** `src/roasts.json` — one pool per breakdown category
  (`filler`, `boilerplate`, `infoDensity`, `repetitive`, `crossPage`,
  `fingerprints`, `assets`) plus `clean` for mostly-good sites. Each pool has
  an `emoji`, a `label`, and 15–20 `lines` (1–2 sentences each, ≤180 chars, no
  factual "was written by AI" phrasing — enforced by `test/roast.test.js`).
- **Selection rule** (`src/roast.js`): the pool is picked from the breakdown
  category with the highest *weighted* contribution to the score (same math as
  `computeSlopScore`), provided it clears a 4.0 weighted-point dominance floor
  and the overall score is ≥ 20; otherwise the `clean` pool wins. The exact
  line is chosen by a deterministic FNV-1a hash of the scan id — same id, same
  line, forever; different scans usually land on different lines.
- **How to edit copy:** edit `src/roasts.json` only — no code changes. Keep
  each line 1–2 sentences, ≤180 chars, loud but evidence-based. The chosen
  line is stored on the scan row (`roast` column, nullable: pre-roast rows
  derive it on read) and surfaces in the JSON response, webhook payload, HTML
  report, and share-card PNG alike.
- **Escaping:** the card SVG and HTML report escape the roast like all other
  variable text (`'` → `&apos;` in the SVG; apostrophes stay literal in the
  HTML text node); sharp resolves the entities back to glyphs when it
  rasterizes the card, so users always see the literal apostrophe.

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
  app.js             Express app factory (injectable db path + fetcher +
                     webhookDeliverer + emailSender for tests)
  budget.js          per-scan time budget (SCAN_BUDGET_MS, injectable)
  db.js              SQLite persistence (data/ass-score.db, gitignored; ALTER
                     migration adds partial/note/worst_page for phase 2 and
                     branding for white-label reports)
  text.js            deterministic HTML -> text/sentences/words extraction +
                     extractMainText (main content only) + extractHead
  scorer.js          weighted 0–100 combination (+ renormalization when a module
                     is skipped; FULL_RULE_WEIGHTS for 7 categories)
  fetch/
    ssrf.js          URL validation + blocked-range checks + DNS resolution
    client.js        fetch with re-validated redirects, timeout, 2 MB cap;
                     optional external AbortSignal for budget aborts
  routes/
    scan.js          POST /api/v1/scan (pipeline: target -> discovery -> additional
                     fetches -> rules -> score; branding/email validation;
                     webhook + best-effort email; partial/pages/worstPage)
    scans.js         GET /api/v1/scans/:id (+ HTML report: white-label branding,
                     Worst Page, Templated Content sections) + /card + /share
  card.js            shareable result card: verdictFor() bands, SVG template,
                     sharp PNG rasterizer (deterministic, no headless browser;
                     optional small agency-name line under the brand row, and
                     the Slop Roast line under the verdict)
  roast.js           Slop Roast: deterministic pool pick (weighted-dominance
                     math) + FNV-1a scan-id seed; selectRoast/selectRoastInfo
  roasts.json        Slop Roast copy pools (seven categories + clean, 15-20
                     lines each; edit copy here, no code changes)
  webhook.js         webhookUrl validation + async best-effort deliverer (retries)
  branding.js        white-label branding validation/normalization (strict types,
                     http(s) logo, hex accent; fail-fast 400 invalid_branding)
  email.js           email validation + report content (plain+HTML) + async
                     best-effort Nodemailer sender (SMTP_* env; no-op when
                     SMTP_HOST is unset; subject config with conservative default)
  rules/
    index.js         runRules() aggregator (the four v1 rules)
    filler.js        Rule A   boilerplate.js   Rule B
    infoDensity.js   Rule C   repetitive.js    Rule D   (unchanged in phase 2)
    similarity.js    word 4-gram Jaccard (pure JS)
    discover.js      sitemap-first discovery, link fallback, MAX_TOTAL_PAGES=5
    crossPage.js     cross-page duplication rule (threshold 0.80, score mapping)
    fingerprints.js  build/tool fingerprint matcher (loads fingerprints.json)
    fingerprints.json  extensible pattern list (no code changes to add entries)
    assets.js        asset-slop matcher: stock/placeholder CDN hosts + generic
                     filenames + missing/generic alt (loads assets.json)
    assets.json      editable stock-host / filename-pattern / alt-text lists
    copySlop.js      Copy Slop rule: hedge-phrase counting + concrete-specifics
                     gap (pure; consumed by boilerplate.js and infoDensity.js)
    copySlop.json    editable hedge-phrase / known-name list + specifics thresholds
test/                node:test suites (ssrf, rules/scorer, API pipeline, webhook,
                     phase2: similarity/discovery/fingerprints/scorer + integration
                     against local fixture sites incl. budget-expiry, card:
                     verdict bands, SVG escaping, PNG determinism + /card & /share
                     integration, branding: validation + report/card rendering +
                     injection safety, email: validation + content + best-effort
                     sender semantics, assetSlop: imagery unit + API/HTML surfaces,
                     copySlop: hedge/specifics unit + dedupe + determinism +
                     API/HTML surfaces)
```

## Docker (production: Node 20 on Alpine)

```bash
docker build -t ass-score .
docker run --rm -p 4000:4000 -v "$(pwd)/data:/app/data" ass-score
# Email delivery is OFF by default; pass SMTP_* env vars to enable it:
docker run --rm -p 4000:4000 -v "$(pwd)/data:/app/data" \
  -e SMTP_HOST=smtp.example.com -e SMTP_PORT=587 \
  -e SMTP_USER=user -e SMTP_PASS=secret \
  -e SMTP_FROM='A.S.S. Score <no-reply@ass-score.com>' \
  -e EMAIL_SUBJECT='Your website audit is ready' \
  -e PUBLIC_BASE_URL=https://ass-score.com ass-score
```

> Note: `better-sqlite3` is a native module; the Alpine image installs
> `python3 make g++` as build dependencies (no musl prebuilds are published).
> `sharp` needs no extra build step — it ships prebuilt libvips binaries for
> linux-x64-musl on Node 20 (`@img/sharp-linuxmusl-x64`). The image also
> installs `font-dejavu`: a RUNTIME dependency, because the share card
> rasterizes SVG text server-side and Alpine has no fonts by default.
> `nodemailer` is pure JS — no build step, no extra Alpine packages.
## Deploy to Railway
The repo ships a multi-stage `Dockerfile` (Node 20 on Alpine) and a
`railway.json` that tells Railway to build it and start with `npm start`
(which runs `node src/server.js`). The server binds `process.env.PORT`
(Railway injects PORT automatically) with a 4000 fallback. There is no GitHub
remote — Railway builds from the uploaded directory.

Prerequisites: a Railway account and the Railway CLI
(`npm i -g @railway/cli`), authenticated via `railway login` (or a
`RAILWAY_TOKEN` env var).

Steps — run from this directory:
```bash
railway init          # create/link a project; make it a web service
railway up            # uploads this exact directory and builds it
```
Railway runs the Dockerfile build, then starts the container with `npm start`.
The `healthcheckPath: /health` in `railway.json` lets Railway mark the service
healthy once the app responds (it returns `{"ok":true,"service":"ass-score"}`).

Env vars to set on the service (see `.env.example`):
- `PUBLIC_BASE_URL` — set to the public origin (`https://ass-score.com` once
  the custom domain is wired; use the Railway `*.up.railway.app` domain until
  then). Drives share links, result cards and report emails.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_FROM` — only if email delivery should be enabled; without `SMTP_HOST`
  email is a no-op and scans still succeed. `EMAIL_SUBJECT` optionally
  overrides the report subject.
- `PORT` / `HOST` / `DB_PATH` / `NODE_ENV` — optional; the image defaults
  (4000 / 0.0.0.0 / `./data/ass-score.db` / production) are fine, and Railway
  overrides PORT itself.

Ephemeral disk: Railway's default disk is ephemeral — the SQLite DB lives in
`/app/data` and is **lost on every redeploy**. That is acceptable for now
(scans are re-runnable, and the A.S.S. Score is deterministic — same input,
same score). To persist scans across deploys, attach a Railway volume (e.g.
mounted at `/data`) and set `DB_PATH=/data/ass-score.db`.
