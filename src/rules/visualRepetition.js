import { load } from 'cheerio';
/**
 * Round-1 DESIGN signals (owner-approved 2026-10-05, signals #1 + #2 ONLY),
 * per /home/team/shared/ROUND1-SPEC.md. Both signals are HTML/DOM-only,
 * deterministic, single-pass — no CSS fetching, no browser, no AI.
 *
 * Signal #1 — repeated stock-icon rendering (`stock-icon-repetition`): an
 * element is a stock-icon element when its class tokens or its SVG path match
 * one of the recognized icon libraries (lucide/feather, font-awesome,
 * bootstrap-icons, tabler, material-icons). Elements are grouped by icon
 * identity (the specific class-name token, else `stock path "<d>"`); an
 * identity is evidence only when >=5 elements render it.
 *
 * Signal #2 — repeated identical class sequences
 * (`class-sequence-repetition`): the normalized full `class` attribute
 * (lowercase, whitespace-normalized, token order + duplicates preserved) is a
 * sequence; sequences with >=2 tokens on >=3 elements are candidates; a
 * candidate is evidence when >=5 elements carry it, subject to the E1–E6
 * gating tables (single-token, link lists, structural containers,
 * utility-without-context, specificity floor, bounded in-house design
 * systems).
 *
 * Both rules are count-tiered like the fingerprints vocabulary rules:
 * confidence from the SUM of all eligible identities'/sequences' element
 * counts — 5–19 medium, >=20 high (sub-5 groups are dropped before summing,
 * so the base 'low' band is unreachable by design).
 *
 * Receipts flow through the existing count-token renderer in
 * src/rules/fingerprints.js (extraHits), so threeLayer parsing and the
 * 'count-token' signal-tag gating apply with zero threeLayer changes.
 *
 * Determinism: class tokens are lowercased/whitespace-normalized; paths are
 * matched EXACTLY (SVG path commands are case-sensitive); ordering is count
 * descending with ties broken by first-document-order (cheerio traversal
 * order + stable sort). The known-path allowlist is per-scan (fresh set per
 * call) seeded from the PINNED base + every path observed on classed stock
 * <svg> elements of the page itself — same input always yields the same
 * output, regardless of scan order or prior scans.
 */

// --------------------------------------------------------------------------
// Rule descriptors (config-driven like fingerprints.json — the gating
// vocabularies with the rules live below; ids/labels/tiers are the two new
// fingerprint rules' metadata).
// --------------------------------------------------------------------------
export const VISUAL_REPETITION_RULES = Object.freeze([
  {
    id: 'stock-icon-repetition',
    label: 'repeated stock-icon rendering',
    tiers: Object.freeze([
      { min: 5, confidence: 'medium' },
      { min: 20, confidence: 'high' },
    ]),
  },
  {
    id: 'class-sequence-repetition',
    label: 'repeated identical class sequences',
    tiers: Object.freeze([
      { min: 5, confidence: 'medium' },
      { min: 20, confidence: 'high' },
    ]),
  },
]);

export const CONFIDENCE_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });
const weightOf = (c) => CONFIDENCE_WEIGHT[c] ?? 0;

/**
 * Max possible weight the two new rules can contribute to the DESIGN
 * denominator (each rule's highest tier weight — 3+3, computed exactly like
 * the vocabulary rules' max-tier convention). fingerprints.js adds this to
 * TOTAL_FINGERPRINT_WEIGHT: 49 + 6 = 55.
 */
export const VISUAL_REPETITION_MAX_WEIGHT = VISUAL_REPETITION_RULES.reduce(
  (sum, rule) => sum + Math.max(...rule.tiers.map((t) => weightOf(t.confidence))),
  0,
);

/** Tier resolution for a summed element count (spec §2.4 / §3): 5–19 medium, >=20 high. */
function tierFor(total) {
  return total >= 20 ? 'high' : total >= 5 ? 'medium' : null;
}

// --------------------------------------------------------------------------
// Signal #1 data — icon library gates + known-path allowlist (pinned data;
// future additions require an owner-reviewed PR, like the vocab tokens).
// --------------------------------------------------------------------------
const FA_MODIFIERS = new Set(['fa', 'fab', 'fas', 'far', 'fal', 'fad', 'fat', 'fa-solid', 'fa-regular', 'fa-brands', 'fa-light', 'fa-thin', 'fa-duotone', 'fa-sharp']);
/** A specific icon-name token (e.g. lucide-check, fa-circle-check, bi-check). */
const ICON_NAME_RE = /^((?:lucide|feather|bi|ti|md|fa)-[a-z0-9-]+)$/;
/**
 * Library gates: a class token is a stock-icon token when it matches one of
 * these (exact token, lowercase after normalization). Iterated in list order.
 */
const LIB_ANY_RE = [
  [/^lucide(-[a-z0-9]+)*$/, 'lucide'],
  [/^feather(-[a-z0-9]+)*$/, 'feather'],
  [/^(fa|fab|fas|far|fal|fad|fa-solid|fa-regular|fa-brands|fa-[a-z0-9-]+)$/, 'font-awesome'],
  [/^bi-[a-z0-9-]+$/, 'bootstrap-icons'],
  [/^ti(-[a-z0-9-]+)*$/, 'tabler'],
  [/^md(-[a-z0-9]+)*$|^material-icons$/, 'material-icons'],
];
const isLibToken = (t) => LIB_ANY_RE.some(([re]) => re.test(t));

/**
 * PINNED known-path allowlist (ROUND1-SPEC §2 KNOWN_PATH): every `d`-string
 * observed on a classed stock-icon <svg> during measurement on the
 * blog2posts-home fixture (53 distinct lucide paths, incl. the check path
 * "M20 6 9 17l-5-5"; the spec's measurement described 50 on the live page —
 * the fixture bytes yield 53 under the identical collection rule, and no
 * pinned count depends on the exact size) PLUS the pinned
 * font-awesome-family check glyph observed as 12 identical *unclassed* inline
 * SVGs on seoloupe: "M3 6L8 11L13 6". Paths are matched EXACTLY
 * (case-sensitive — SVG path commands are case-sensitive). Extends only by
 * owner-reviewed PR; classed stock <svg> paths are auto-added per scan (see
 * collectKnownPaths).
 */
export const KNOWN_ICON_PATHS = Object.freeze([
  'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12',
  'M2 14h2',
  'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
  'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17',
  'M3 10h18',
  'M3 6L8 11L13 6',
  'M4 11a9 9 0 0 1 9 9',
  'M4 12h8a4 4 0 0 0 4-4V6',
  'M4 12h8a4 4 0 0 1 4 4v2',
  'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  'M4 18V6',
  'M4 4a16 16 0 0 1 16 16',
  'M4 4v16',
  'M5 12h14',
  'M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z',
  'M8 14h.01',
  'M8 18h.01',
  'M8 2v4',
  'M8 8v12',
  'M9 13v2',
  'M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z',
  'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z',
  'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
  'M12 14h.01',
  'M12 18V2l7 4',
  'M12 18h.01',
  'M12 6v14',
  'M12 8V4H8',
  'M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34',
  'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z',
  'M14 2v5a1 1 0 0 0 1 1h5',
  'M15 13v2',
  'M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z',
  'M16 14h.01',
  'M16 18h.01',
  'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
  'M16 2v4',
  'M16 3.128a4 4 0 0 1 0 7.744',
  'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z',
  'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z',
  'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z',
  'M20 14h2',
  'M20 2v4',
  'M20 6 9 17l-5-5',
  'M22 21v-2a4 4 0 0 0-3-3.87',
  'M22 4h-4',
  'M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z',
  'm10 15 5-3-5-3z',
  'm12 5 7 7-7 7',
  'm15 18-6-6 6-6',
  'm16 6 4 14',
  'm21 21-4.34-4.34',
  'm6 9 6 6 6-6',
  'm9 18 6-6-6-6',
]);

/**
 * Auto-extend the known-path table from the page's own classed stock <svg>
 * elements (per scan — never mutates the pinned base). Every `d` string on a
 * classed stock-icon svg becomes known for THIS scan, so bare-library-class
 * svgs and their sprite paths are resolvable without a pinned literal.
 */
function collectKnownPaths($, knownPaths) {
  $('svg').each((_, e) => {
    const el = $(e);
    const cls = (el.attr('class') ?? '').toLowerCase().split(/\s+/);
    const isStock = cls.some(isLibToken);
    if (!isStock) return;
    el.find('path').each((__, p) => {
      const d = $(p).attr('d');
      if (d) knownPaths.add(d);
    });
  });
}

/**
 * Resolve one element's icon identity (spec §2.2): the specific class-name
 * token (lucide-check, fa-circle-check, ...) when present, else `stock path
 * "<d>"` when the element is an svg whose first path's `d` is in the known
 * table. Returns null when the element carries no stock-icon signal.
 */
function iconIdentity(el, tokens, knownPaths) {
  // Specific icon-name token (modifiers like fa-solid identify style, not icon).
  const nameTok = tokens.find((t) => ICON_NAME_RE.test(t) && !FA_MODIFIERS.has(t));
  if (nameTok) return { name: nameTok };
  // Library-bare token on an svg: identity = known stock path (exact match).
  const libTok = tokens.find(isLibToken);
  if (libTok) {
    const d = el[0]?.tagName === 'svg' ? (el.find('path').first().attr('d') ?? null) : null;
    if (d && knownPaths.has(d)) return { name: `stock path "${d}"` };
    return null; // custom/unknown path: never counts (Stripe's carousel arrows)
  }
  // Unclassed svg with a KNOWN stock path: counts only via the allowlist
  // (SeoLoupe's 12 duplicate inline checkmarks).
  if (el[0]?.tagName === 'svg') {
    const d = el.find('path').first().attr('d') ?? null;
    if (d && knownPaths.has(d)) return { name: `stock path "${d}"` };
  }
  return null;
}

/**
 * Signal #1 analyzer. Returns either null (no evidence) or a fingerprints
 * count-rule hit: { id, label, confidence, scope: 'html', counts } where each
 * counts entry is one icon identity with its element count.
 */
export function analyzeIconRepetition(html) {
  const $ = load(html);
  const knownPaths = new Set(KNOWN_ICON_PATHS);
  collectKnownPaths($, knownPaths);
  const groups = new Map(); // identity name -> element count (first-seen order)
  $('[class],svg').each((_, e) => {
    const el = $(e);
    const cls = (el.attr('class') ?? '').trim().toLowerCase();
    const tokens = cls.split(/\s+/).filter(Boolean);
    const id = iconIdentity(el, tokens, knownPaths);
    if (!id) return;
    groups.set(id.name, (groups.get(id.name) ?? 0) + 1);
  });
  const eligible = [...groups.entries()]
    .filter(([, count]) => count >= 5) // evidence floor: 1–4 identical icons is ordinary use
    .map(([name, count]) => ({ token: name, count }))
    .sort((a, b) => b.count - a.count); // stable: ties keep first-document order
  if (eligible.length === 0) return null;
  const total = eligible.reduce((sum, c) => sum + c.count, 0);
  const confidence = tierFor(total);
  if (!confidence) return null;
  const rule = VISUAL_REPETITION_RULES[0];
  return {
    id: rule.id,
    label: rule.label,
    confidence,
    scope: 'html',
    counts: eligible,
  };
}

// --------------------------------------------------------------------------
// Signal #2 data + gating (spec §3 E1–E6 + the pinned utility vocabulary).
// --------------------------------------------------------------------------
const STRUCTURAL_TAGS = new Set(['header', 'nav', 'footer', 'ul', 'ol', 'menu', 'aside', 'main']);
const ROLE_TOKEN_RE = /(^|[-_])(nav|menu|link|breadcrumb|pagination|social|footer|header|copyright|sitemap)([-_]|$)/i;
const CONTAINER_TOKEN_RE = /(^|[-_])(wrap(per)?|container|layout|section|header|footer|nav|menu|list|sidebar)([-_]|$)/i;
const SEMANTIC_TOKEN_RE = /(^|[-_])(card|box|panel|item|post|feature|testimonial|step|faq|block|hero|cta|price|pricing|tab|accordion|avatar|badge|chip|input|dialog|dropdown|toast|alert|sheet|button|icon|logo|tile|cell|entry|article|summary|excerpt|thumbnail|media|content|title|heading|label|value)([-_]|$)/i;
const stockIconTok = (t) => /^(lucide|feather|fa|bi|ti|md)(-[a-z0-9-]+)?$/.test(t);
const isMeaningToken = (t) => stockIconTok(t) || SEMANTIC_TOKEN_RE.test(t);
/**
 * Pinned Tailwind-utility table (ROUND1-SPEC §3): the standard utility
 * prefixes + full margin/padding forms. A token matching this is a utility,
 * not a component name — never meaning-bearing and never a custom-system stem.
 */
const UTIL_RE = /^(flex|grid|block|inline|inline-block|hidden|absolute|relative|sticky|fixed|static|table|grow|shrink|order-|basis-|inset-|m-|mx-|my-|mt-|mb-|ml-|mr-|ms-|me-|p-|px-|py-|pt-|pb-|pl-|pr-|ps-|pe-|z-|gap-|w-|h-|size-|min-[wh]-|max-[wh]-|items-|justify-|content-|self-|place-|text-|font-|leading-|tracking-|rounded-|border-|shadow-|bg-|opacity-|transition-|duration-|ease-|select-|pointer-|cursor-|overflow-|object-|whitespace-|break-|uppercase|lowercase|capitalize|normal-case|truncate|divide-|space-|top-|right-|bottom-|left-|translate-|scale-|rotate-|skew-|origin-|blur-|brightness-|contrast-|grayscale|invert|saturate|sepia|fill-|stroke-|sr-only|not-sr-only)([\w./[\]%-]*)?$/i;
/**
 * Tailwind-utility test (shared export — also the skeleton tokenizer's
 * specificity floor, see src/rules/skeletonFamily.js; the round-2 detector
 * imports this table rather than duplicating it).
 */
export const isUtility = (t) => UTIL_RE.test(t);
/** Framework variants (md:, dark:, data-[…]:, [&_svg]:, …) — never component names. */
export const FRAMEWORK_VARIANT_RE = /[:[\]&]/;
/**
 * CSS-in-JS / css-modules hash classnames (styled-components, emotion,
 * css-modules output): `css-…`, double-underscore hashes, or short
 * letter-prefix-digit patterns (ROUND2-SPEC §1.3). The skeleton tokenizer
 * drops these so hashed templates are never falsely discriminated.
 */
export const HASH_TOKEN_RE = /^css-|__|^[a-z]{2,3}-\d+$/;
export const isHashToken = (t) => HASH_TOKEN_RE.test(t);
const SEM_WORD_RE = /^(card|box|panel|item|post|feature|testimonial|step|faq|block|hero|cta|price|pricing|tab|accordion|avatar|badge|chip|input|dialog|dropdown|toast|alert|sheet|button|icon|logo|tile|cell|entry|article|summary|excerpt|thumbnail|media|content|title|heading|label|value)$/i;
const SEM_PREFIX_RE = /^(card|box|panel|item|post|feature|testimonial|step|faq|block|hero|cta|price|pricing|tab|accordion|avatar|badge|chip|input|dialog|dropdown|toast|alert|sheet|button|icon|logo|tile|cell|entry|article|summary|excerpt|thumbnail|media|content|title|heading|label|value)[-_:]/i;

/** A token that is neither a utility, stock icon, framework variant, nor a semantic word/prefix — i.e. a candidate custom-system stem. */
function isCustomToken(t) {
  if (isUtility(t)) return false;
  if (stockIconTok(t)) return false;
  if (FRAMEWORK_VARIANT_RE.test(t)) return false;
  if (SEM_WORD_RE.test(t)) return false;
  if (SEM_PREFIX_RE.test(t)) return false;
  return true;
}

/** E6: bounded in-house design system (BEM-form everywhere, or >=50% custom tokens share one stem prefix). Stock-icon sequences are exempt. */
function customSystem(tokens) {
  if (tokens.some(stockIconTok)) return false; // stock-icon sequences exempt (SL fa-* stays eligible)
  // (a) every token is BEM-form (block__elem or block--mod): one bounded system
  if (tokens.every((t) => /^[a-z][\w-]*?(__|--)[\w-]+$/.test(t))) return true;
  // (b) majority of custom tokens share a common stem prefix (hds-, case-study-, ...)
  const usable = tokens.filter(isCustomToken);
  if (usable.length < 2) return false;
  const stems = {};
  for (const t of usable) {
    const m = /^([a-z][a-z0-9]*?[-_:])/.exec(t);
    if (m) stems[m[0]] = (stems[m[0]] ?? 0) + 1;
  }
  return Object.values(stems).some((n) => n / usable.length >= 0.5);
}

/** E2 helper: is this element an <a> inside a link list (role token on itself, or a ul/ol/nav/footer/header ancestor)? */
function inLinkList(el, $, tokens) {
  if (el[0]?.tagName !== 'a') return false;
  if (tokens.some((t) => ROLE_TOKEN_RE.test(t))) return true;
  let cur = el.parent();
  while (cur.length && !cur.is('body')) {
    if (['ul', 'ol', 'nav', 'footer', 'header'].includes(cur[0]?.tagName ?? '')) return true;
    cur = cur.parent();
  }
  return false;
}

/** E4 helper: does any ancestor (up to <body>) carry a meaning-bearing class token? */
function ancestorMeaning(el, $) {
  let cur = el.parent();
  while (cur.length && !cur.is('body')) {
    const cls = (cur.attr('class') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (cls.some(isMeaningToken)) return true;
    cur = cur.parent();
  }
  return false;
}

/**
 * Signal #2 analyzer. Returns either null (no evidence) or a fingerprints
 * count-rule hit: { id, label, confidence, scope: 'html', counts } where each
 * counts entry is one QUOTED class sequence ("flex gap-2") with its element
 * count.
 */
export function analyzeClassSeqRepetition(html) {
  const $ = load(html);
  const bySeq = new Map(); // normalized class attr -> [{ tag, tokens, el }] in first-document order
  $('[class]').each((_, e) => {
    const cls = ($(e).attr('class') ?? '').trim().toLowerCase();
    const tokens = cls.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return; // E1: single-token sequences never enter the pool
    const seq = tokens.join(' ');
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push({ tag: e.tagName, tokens, el: $(e) });
  });
  const eligible = [];
  for (const [seq, items] of bySeq) {
    if (items.length < 3) continue; // candidate pool: >=3 elements
    let reason = null;
    // E2: link lists (Stripe's footer-links hazard, hemingway reading-list rows)
    if (items.every((i) => inLinkList(i.el, $, i.tokens))) reason = 'link-list';
    // E3: structural containers — element tag is a container, or every element's
    // tokens are container words (hentry: hemingway <ul> rows, Stripe section-row*)
    else if (items.every((i) => STRUCTURAL_TAGS.has(i.tag))) reason = 'structural-tag';
    else if (items.every((i) => i.tokens.some((t) => CONTAINER_TOKEN_RE.test(t)))) reason = 'structural-token';
    // E6: bounded in-house design systems (Stripe's entire hds-*/BEM surface)
    else if (customSystem(items[0].tokens)) reason = 'custom-system';
    // E4: utility-only sequences — excluded without a semantic ancestor,
    // eligible via the carve-out WITH one (b2p's "flex gap-2" feature rows)
    else if (!items.some((i) => i.tokens.some(isMeaningToken))) {
      reason = items.every((i) => !ancestorMeaning(i.el, $)) ? 'utility-no-context' : 'utility-with-context';
    }
    // E5: specificity floor — no token is >=5 chars (grid-code short-hands
    // are not component names: acko "g6 ge4 re" ×5)
    else if (!items.some((i) => i.tokens.some((t) => t.length >= 5))) {
      reason = 'specificity-floor';
    }
    if (reason === null || reason === 'utility-with-context') {
      eligible.push({ seq, count: items.length });
    }
  }
  const evidence = eligible
    .filter((s) => s.count >= 5) // evidence floor: 1–4 repetitions below the report band
    .map((s) => ({ token: `"${s.seq}"`, count: s.count }))
    .sort((a, b) => b.count - a.count); // stable: ties keep first-document order
  if (evidence.length === 0) return null;
  const total = evidence.reduce((sum, c) => sum + c.count, 0);
  const confidence = tierFor(total);
  if (!confidence) return null;
  const rule = VISUAL_REPETITION_RULES[1];
  return {
    id: rule.id,
    label: rule.label,
    confidence,
    scope: 'html',
    counts: evidence,
  };
}

/**
 * The two round-1 hits for a page, in [icon, sequence] order, nulls dropped.
 * Single call site shared by src/scan.js and the fixture helpers so the
 * production pipeline and the regression matrix analyze the same shape.
 */
export function visualRepetitionHits(html) {
  return [analyzeIconRepetition(html), analyzeClassSeqRepetition(html)].filter(Boolean);
}