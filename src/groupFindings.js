/**
 * ONE PROBLEM = ONE FINDING (owner direction 2026-10-07) — finding grouping.
 *
 * The report must practice what it preaches: a single underlying problem on
 * the scanned page must render as ONE finding card, with every piece of
 * trigger evidence preserved as receipts underneath it.
 *
 * Two phases, both additive and deterministic:
 *
 *   Phase A — WITHIN-category collapse. A summary/aggregate line and its
 *   detail lines are one problem: the summary becomes the card, the details
 *   become receipts. Works on stored evidence strings alone, so it applies to
 *   LEGACY rows (no new data needed). Generalizes the existing boilerplate
 *   totals demotion (ONE SIGNAL = ONE FINDING, audit Q3) to the assets
 *   aggregate/detail structure ("5 of N images with placeholder filenames" +
 *   its `img[N] …` detail lines → one card). When the mapping between an
 *   aggregate and its details is ambiguous, the lines stay individual findings
 *   — we never merge on a guess.
 *
 *   Phase B — CROSS-category grouping (NEW scans only). Rules that match an
 *   element emit a stable `src` (component key) per finding, stored additively
 *   as `breakdown.<cat>.sources[i]` parallel to `findings[i]` (see
 *   attachSources). The report merges negative findings that share a src
 *   ACROSS categories into ONE card — the primary card is the first member in
 *   the report's category order, the other members' original evidence lines
 *   become receipts labeled with their category name. Legacy rows lack
 *   `sources` and get Phase A only.
 *
 * Score/verdict/three-layer copy pools are NEVER touched — grouping is
 * presentation only, and every receipt is a real trigger evidence string.
 */

import * as cheerio from 'cheerio';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Elements whose text must never be treated as page content (scripts carry
 *  framework payloads that duplicate the visible DOM). */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** Collapse runs of whitespace (mirrors the shared evidence normalization). */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Phase A — within-category summary/detail collapse (evidence strings only)
// ---------------------------------------------------------------------------

const ASSETS_AGGREGATE_RE = /^\d+ of \d+ images (?:come from stock photo sites|with placeholder\/generic filenames|with missing or generic alt text)$/;
const ASSETS_AGGREGATE_SIGNALS = [
  { aggregate: /stock photo sites$/, detail: /stock photo host/ },
  { aggregate: /placeholder\/generic filenames$/, detail: /generic filename/ },
  { aggregate: /missing or generic alt text$/, detail: /missing alt text|empty alt text|generic alt/ },
];

/**
 * Is this an assets AGGREGATE (totals) line — "N of M images …"? These are
 * count summaries of the category's flagged images; the `img[N] …` detail
 * lines carry the actual per-image evidence. One flagged image must read as
 * one problem, not as a totals line + a detail line.
 *
 * @param {string} finding the evidence string
 * @returns {boolean}
 */
export function isAssetsAggregateLine(finding) {
  return ASSETS_AGGREGATE_RE.test(String(finding ?? ''));
}

/**
 * Is this an assets DETAIL line — `img[N] …`? Only detail lines can be
 * collapsed under their aggregate; other finding shapes stay individual.
 *
 * @param {string} finding the evidence string
 * @returns {boolean}
 */
export function isAssetsDetailLine(finding) {
  return /^img\[\d+\] /.test(String(finding ?? ''));
}

/**
 * Phase A — collapse one category's negative findings into groups of one
 * problem. Every group is { primary, receipts } where `primary` is the card
 * and `receipts` are the other members' original evidence items (folded into
 * the card's receipts drawer). A finding that participates in no collapse is
 * its own group of one.
 *
 * Existing behavior preserved exactly: boilerplate totals demotion (a totals
 * line that is the category's ONLY negative line keeps its finding
 * semantics). New: assets aggregate + matching details -> one group.
 *
 * @param {string} key breakdown category key
 * @param {Array<{finding: string, insight: object|null, idx: number}>} negatives
 * @returns {Array<{primary: object, receipts: Array<object>}>}
 */
export function collapseSummaries(key, negatives) {
  if (negatives.length === 0) return [];
  if (key === 'boilerplate') {
    // ONE SIGNAL = ONE FINDING (audit Q3): the totals line is a measurement of
    // the same detail signals, never its own finding when details exist.
    const [first, ...rest] = negatives;
    if (rest.length > 0 && /^\d+ (?:generic wording match(?:es)?|boilerplate signal(?:\(s\)|s)?) in \d+ words/.test(first.finding)) {
      return rest.map((n, i) => ({ primary: n, receipts: i === 0 ? [{ text: first.finding, catKey: null }] : [] }));
    }
    return [{ primary: first, receipts: [] }, ...rest.map((n) => ({ primary: n, receipts: [] }))];
  }
  if (key === 'assets') {
    // Aggregate lines are the counts; the matching `img[N]` detail lines are
    // per-image receipts. Signal wording in the aggregate line determines which
    // details belong to it (deterministic, evidence-based).
    const groups = [];
    const used = new Set();
    for (const n of negatives) {
      if (!isAssetsAggregateLine(n.finding)) continue;
      const signal = ASSETS_AGGREGATE_SIGNALS.find((s) => s.aggregate.test(n.finding));
      if (!signal) continue;
      const details = negatives.filter(
        (x) => isAssetsDetailLine(x.finding) && signal.detail.test(x.finding),
      );
      for (const d of details) used.add(d);
      groups.push({ primary: n, receipts: details.map((d) => ({ text: d.finding, catKey: null })) });
    }
    // Leftover items (details whose aggregate never fired, non-detail lines)
    // stay individual cards in stored order.
    const primarySet = new Set(groups.map((g) => g.primary));
    for (const n of negatives) {
      if (used.has(n) || primarySet.has(n)) continue;
      groups.push({ primary: n, receipts: [] });
    }
    return groups;
  }
  return negatives.map((n) => ({ primary: n, receipts: [] }));
}

// ---------------------------------------------------------------------------
// Phase B — component keys (src). Shared DOM helper used by attachSources.
// ---------------------------------------------------------------------------

/**
 * Boundary-spaced text: every descendant text node contributes its content,
 * joined with single spaces at element boundaries. Plain textContent
 * concatenation loses boundaries ("SponsorOOrbitype"), while the findings'
 * evidence quotes are boundary-spaced (the same extraction the readable
 * quotes use — see src/text.js), so matching must use the same spacing.
 *
 * @param {object} el cheerio/parse5 element node
 * @param {object} $ cheerio instance
 * @returns {string} normalized boundary-spaced text of the element
 */
function boundaryText(el, $) {
  const parts = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (!child) continue;
      if (child.type === 'text') {
        const t = String(child.data ?? '').replace(/\s+/g, ' ');
        if (t) parts.push(t);
      } else if (child.type === 'tag' || child.type === 'script') {
        if ((child.type === 'tag' || child.type === 'script') && SKIP_TAGS.has(String(child.tagName ?? child.name ?? '').toLowerCase())) continue;
        parts.push(' ');
        walk(child);
        parts.push(' ');
      }
    }
  };
  walk(el);
  return norm(parts.join(' '));
}

/**
 * The COMPONENT KEY of an element: the first ancestor (including the element
 * itself) with an id appearing exactly once in the parsed DOM, else the first
 * class token appearing exactly once. Returns null when the walk reaches the
 * page root without one — a page-level key is NOT a component, and findings
 * must never merge on it (nav/footer/rail text spans the whole page shell).
 *
 * @param {object} el cheerio/parse5 element node
 * @param {object} $ cheerio instance
 * @param {Map<string, number>} counts token -> visible-element occurrences
 * @returns {string|null} e.g. ".premiumSection" / "#results" / null
 */
export function componentKey(el, $, counts) {
  let cur = el;
  while (cur && (cur.tagName || cur.nodeName)) {
    const id = $(cur).attr('id');
    if (id && (counts.get(`#${id}`) ?? 0) === 1) return `#${id}`;
    const cls = $(cur).attr('class');
    if (cls) {
      for (const c of String(cls).split(/\s+/).filter(Boolean)) {
        if ((counts.get(`.${c}`) ?? 0) === 1) return `.${c}`;
      }
    }
    cur = cur.parent;
  }
  return null;
}

/** Depth of an element in the parse tree (root = 0). */
function depthOf(el) {
  let d = 0;
  let cur = el;
  while (cur.parent && (cur.parent.tagName || cur.parent.nodeName)) {
    d += 1;
    cur = cur.parent;
  }
  return d;
}

/** Is `ancestor` an ancestor (or self) of `el`? */
function isAncestorOf(ancestor, el) {
  let cur = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Locate the element a quoted phrase came from: the LEAF-MOST (deepest)
 * visible element whose boundary-spaced text contains the phrase, taking the
 * FIRST in document order when several leaves match at the same depth. When
 * the phrase spans multiple leaves (it crosses an element boundary in the
 * page text), no leaf contains it and we fall back to the deepest CONTAINER
 * (the smallest element whose text includes the whole quote). Returns null
 * when nothing visible contains the phrase.
 *
 * @param {string} phrase the quoted evidence phrase (trailing "…" allowed)
 * @param {object} $ cheerio instance
 * @param {Map<object, string>} texts element -> boundary text
 * @returns {object|null} element node or null
 */
export function locatePhrase(phrase, $, texts) {
  const p = norm(String(phrase ?? '')).replace(/…\s*$/, '');
  if (p.length < 12) return null;
  const matches = [];
  $('*').each((_, el) => {
    const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const t = texts.get(el);
    if (!t) return;
    if (!t.includes(p)) return;
    matches.push(el);
  });
  if (matches.length === 0) return null;
  // Leaves: matches that are not an ancestor of another match. Document order
  // is preserved by the $('*') iteration, so the FIRST leaf wins.
  const leaves = matches.filter((m) => !matches.some((o) => o !== m && isAncestorOf(m, o)));
  if (leaves.length > 0) return leaves[0];
  // Phrase spans elements: deepest container, first on ties.
  let best = null;
  let bestDepth = -1;
  for (const m of matches) {
    const d = depthOf(m);
    if (d > bestDepth) {
      bestDepth = d;
      best = m;
    }
  }
  return best;
}

/**
 * Attach the Phase-B `sources` array to every category rule in a breakdown.
 * `sources[i]` = component key of the element findings[i] points at (or null
 * when the finding has no locatable phrase / no component). Computed on the
 * TARGET page HTML at scan time, purely additive: findings and insights are
 * untouched; a scan without this step stores no sources (legacy rows lack the
 * key entirely and Phase B no-ops).
 *
 * Deterministic: same html + same findings -> identical sources.
 *
 * @param {string} html raw HTML of the scanned (target) page
 * @param {Record<string, {findings?: unknown[]}>} breakdown categories
 * @returns {Record<string, {findings?: unknown[], sources?: Array<string|null}>} the same object with sources filled in
 */
export function attachSources(html, breakdown) {
  const $ = cheerio.load(String(html ?? ''));
  const counts = new Map();
  const texts = new Map();
  $('*').each((_, el) => {
    const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const id = $(el).attr('id');
    if (id) counts.set(`#${id}`, (counts.get(`#${id}`) ?? 0) + 1);
    const cls = $(el).attr('class');
    if (cls) {
      for (const c of String(cls).split(/\s+/).filter(Boolean)) {
        counts.set(`.${c}`, (counts.get(`.${c}`) ?? 0) + 1);
      }
    }
    texts.set(el, boundaryText(el, $));
  });
  for (const rule of Object.values(breakdown ?? {})) {
    if (!rule || typeof rule !== 'object' || !Array.isArray(rule.findings)) continue;
    const sources = [];
    for (const f of rule.findings) {
      const m = /"([^"]+)"/.exec(String(f ?? ''));
      const el = m ? locatePhrase(m[1], $, texts) : null;
      sources.push(el ? componentKey(el, $, counts) : null);
    }
    rule.sources = sources;
  }
  return breakdown;
}

// ---------------------------------------------------------------------------
// Grouping helpers shared by the renderer
// ---------------------------------------------------------------------------

/**
 * First quoted phrase of a finding string (the evidence quote), or null.
 *
 * @param {string} finding evidence string
 * @returns {string|null}
 */
export function firstQuote(finding) {
  const m = /"([^"]+)"/.exec(String(finding ?? ''));
  return m ? m[1] : null;
}

/**
 * The stored src for one finding item, guarded to a string or null.
 *
 * @param {Array<string|null>|undefined} sources stored sources array
 * @param {number} idx finding index
 * @returns {string|null}
 */
const srcOf = (sources, idx) => {
  if (!Array.isArray(sources)) return null;
  const s = sources[idx];
  return typeof s === 'string' && s.length > 0 ? s : null;
};

/** Normalize a receipt to { text, catKey } (handles Phase-A item receipts,
 *  within-category-merger receipts and plain strings). */
const receiptAs = (r, catKey) => {
  if (r && typeof r === 'object' && 'text' in r) return { text: String(r.text), catKey: r.catKey ?? catKey };
  if (r && typeof r === 'object' && 'finding' in r) return { text: String(r.finding), catKey };
  return { text: String(r ?? ''), catKey };
};

/**
 * Phase B — group negative findings ACROSS categories by shared src.
 *
 * Input: one entry per category with its NEGATIVE findings (already Phase-A
 * collapsed into within-category groups). Output: a flat list of problem
 * cards. Members with the same non-null src merge into one group; the primary
 * is the first in the report's category order (then findings order). The
 * merged group's receipts carry every member's original evidence (labeled
 * with the member's category at render time) plus the primary's own collapsed
 * receipts.
 *
 * @param {Array<{key: string, groups: Array<{primary: object, receipts: Array<object>}>, sources: Array<string|null>|undefined}>} perCategory
 * @returns {Array<{key: string, primary: object, receipts: Array<object>, members: Array<{key: string, item: object}>}>}
 */
export function groupAcrossCategories(perCategory) {
  const order = [];
  const index = new Map(); // src -> flat group
  const out = [];
  for (const cat of perCategory) {
    for (const group of cat.groups) {
      const src = srcOf(cat.sources, group.primary.idx);
      if (src === null) {
        // No component: individual card.
        const g = { key: cat.key, primary: group.primary, receipts: [...group.receipts], members: [] };
        out.push(g);
        order.push(g);
        continue;
      }
      const existing = index.get(src);
      if (existing) {
        // Merge: the member's primary evidence + its collapsed receipts ride
        // in the merged card's receipts, category-labeled at render time.
        existing.members.push({ key: cat.key, item: group.primary });
        existing.receipts.push({ text: group.primary.finding, catKey: cat.key });
        for (const r of group.receipts) {
          existing.receipts.push(receiptAs(r, cat.key));
        }
      } else {
        const g = {
          key: cat.key,
          primary: group.primary,
          receipts: group.receipts.map((r) => receiptAs(r, cat.key)),
          members: [],
        };
        index.set(src, g);
        out.push(g);
        order.push(g);
      }
    }
  }
  return out;
}

/**
 * WITHIN-category grouped negatives: Phase A collapse plus same-src merging
 * inside ONE category (a category's own view of its problems). Cross-category
 * merging is NOT applied here — it lives only in the flat list.
 *
 * @param {string} key category key
 * @param {Array<{finding: string, insight: object|null, idx: number}>} negatives
 * @param {Array<string|null>|undefined} sources
 * @returns {Array<{primary: object, receipts: Array<object>}>}
 */
export function withinCategoryGroups(key, negatives, sources) {
  const collapsed = collapseSummaries(key, negatives);
  const out = [];
  const index = new Map();
  for (const group of collapsed) {
    const src = srcOf(sources, group.primary.idx);
    if (src === null) {
      out.push(group);
      continue;
    }
    const existing = index.get(src);
    if (existing) {
      existing.receipts.push({ text: group.primary.finding, catKey: null }, ...group.receipts.map((r) => ({ text: r.finding, catKey: null })));
    } else {
      index.set(src, group);
      out.push(group);
    }
  }
  return out;
}