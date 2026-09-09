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
| Invalid branding | `400` | `branding` present but malformed (checked before scanning) |
| Invalid email | `400` | `email` present but not an address (checked before scanning) |
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
(`A.S.S. Score <no-reply@ass-score.com>`, overridable via `SMTP_FROM`).

**Subject decision.** The owner spec asks to spam-test subject lines and keep a
fallback ready. Real spam-testing needs a live SMTP provider, so the shipped
default is the CONSERVATIVE primary `"Your website audit is ready"`
(deliverability-safe: no emoji, no brand token, unlikely to trip filters). The
branded variant `"Your A.S.S. Score is ready 🔴"` exists and is selectable via
`EMAIL_SUBJECT` (or the `emailSubject` app option) — swap it in once the team
inbox can A/B test against real delivery.

**Required env vars at deploy (to turn email ON):**

| Env | Meaning | Default |
| --- | --- | --- |
| `SMTP_HOST` | SMTP server (e.g. `smtp.postmarkapp.com`) | **unset → email is a no-op** |
| `SMTP_PORT` | SMTP port | `587` (or `465` when `SMTP_SECURE=true`) |
| `SMTP_SECURE` | `"true"` for implicit TLS on 465 | `false` |
| `SMTP_USER` | auth username | — |
| `SMTP_PASS` | auth password | — |
| `SMTP_FROM` | sender address | `A.S.S. Score <no-reply@ass-score.com>` |
| `EMAIL_SUBJECT` | subject line variant | `Your website audit is ready` |
| `PUBLIC_BASE_URL` | report-link base | `https://ass-score.com` |

**No credentials → nothing breaks.** When `SMTP_HOST` is missing or empty, the
default sender is a no-op that logs `[email] email not configured (set
SMTP_HOST/...)` and returns `{ ok: false, configured: false }` — the scan still
succeeds with `200`. The transport (Nodemailer over SMTP, no TLS up until
credentials exist) is injectable: the `emailSender` app option is an
`async (scan, to) => result` function, so tests (and future swaps to other
providers) stub or script the transport. No real email is ever sent unless
`SMTP_*` credentials are present in the environment.

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

**Verdict bands** (pure function `verdictFor(score)` in `src/card.js`; the
product's one-line verdicts):

| Score | Verdict | Accent |
| --- | --- | --- |
| 0–19 | Clean as a whistle. Impressive. | green |
| 20–39 | Congrats — less A.S.S. than most. | lime |
| 40–59 | A moderate amount of A.S.S. detected. | yellow |
| 60–79 | Oh no. That's a lot of A.S.S. | orange |
| 80–100 | Your website has a serious slop problem. | red |

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

### Slop Roast
Every scan gets a punchy on-brand one-liner (the "roast") on top of the score.
It is **deterministic, never random, and never an AI-authorship claim**: the
copy pokes at the *evidence* the rules found (template-like wording, duplicated
pages, thin content, builder fingerprints).

- **Pools file:** `src/roasts.json` — one pool per breakdown category
  (`filler`, `boilerplate`, `infoDensity`, `repetitive`, `crossPage`,
  `fingerprints`) plus `clean` for mostly-good sites. Each pool has an `emoji`,
  a `label`, and 15–20 `lines` (1–2 sentences each, ≤180 chars, no factual
  "was written by AI" phrasing — enforced by `test/roast.test.js`).
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
                     is skipped; FULL_RULE_WEIGHTS for 6 categories)
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
  roasts.json        Slop Roast copy pools (six categories + clean, 15-20 lines
                     each; edit copy here, no code changes)
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
test/                node:test suites (ssrf, rules/scorer, API pipeline, webhook,
                     phase2: similarity/discovery/fingerprints/scorer + integration
                     against local fixture sites incl. budget-expiry, card:
                     verdict bands, SVG escaping, PNG determinism + /card & /share
                     integration, branding: validation + report/card rendering +
                     injection safety, email: validation + content + best-effort
                     sender semantics)
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
