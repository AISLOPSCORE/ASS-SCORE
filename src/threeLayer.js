import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashScanId } from './roast.js';

export { hashScanId } from './roast.js'; // seeding utility, shared with the Slop Roast

/**
 * Three-layer findings — the A.S.S. Score report's spine.
 *
 * Every finding (a breakdown category's evidence string) gains an insight:
 *
 *   { roast, why, fix, evidence }
 *
 *   roast     — funny, blunt, SPECIFIC: references the actual trigger through
 *               one or more {tokens} interpolated ONLY from the finding's own
 *               parsed evidence. A variant is only eligible when EVERY token it
 *               declares exists in the parsed tokens (absolute rule: a roast
 *               must be able to point at the real trigger; never fabricate).
 *               Findings with no interpolatable token at all fall back to the
 *               group's token-free roasts.
 *   why       — real business/credibility reasoning (differentiation, SEO,
 *               trust, conversion). Signal-GATED since the content-integrity
 *               fix: a why/fix entry in threeLayer.json may carry OPTIONAL
 *               "triggers" (see signalTagFor below); a tagged entry is
 *               eligible ONLY for findings whose evidence carries one of its
 *               tags (a cookie/legal line must never ride on a marketing-claim
 *               finding). Untagged entries (plain strings) are eligible for
 *               every finding of the group — they must stay genuinely
 *               signal-agnostic (automated denylist test). No tokens.
 *   fix       — specific, actionable remediation; same trigger/eligibility
 *               rules as why. When a finding has NO eligible line for a layer,
 *               that layer is OMITTED from the insight — never drawn from an
 *               ineligible pool.
 *   evidence  — the finding string itself, verbatim.
 *
 * Copy lives in src/threeLayer.json (one pool per breakdown key): edit copy in
 * the file, NO code changes needed. Selection is deterministic: seeded by the
 * scan id + category + finding index through the same FNV-1a hashScanId the
 * Slop Roast uses — same scan id -> identical insights, forever; different
 * scan ids (a rescan) usually land on different variant picks, which is what
 * makes repeated free rescans feel fresh without ever being random.
 *
 * Wiring: scan.js attaches insights to the stored breakdown (they ride inside
 * the JSON column, so GET and webhook deliveries are stable); routes/scans.js
 * derives them for legacy rows that predate the feature (withInsights is
 * idempotent — stored insights always win). Nothing here touches scoring
 * math, weights, the score flip, verdicts, or rate limiting.
 */

const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'threeLayer.json');
const DATA = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

/**
 * Normalize ONE whys/fixes entry from threeLayer.json: a plain string is an
 * UNTAGGED line (eligible for every finding of the group); an object entry
 * { "text": "...", "triggers": ["tag", ...] } is a signal-gated line (eligible
 * only for findings whose signalTagFor(category, evidence) is one of its
 * triggers). Compliments/cleanWhys/keepUps/roasts stay plain strings.
 */
function normalizeEntry(e) {
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    return {
      text: String(e.text ?? ''),
      triggers: Array.isArray(e.triggers) ? e.triggers.map(String) : [],
    };
  }
  return { text: String(e ?? ''), triggers: [] };
}

/** The copy text of a whys/fixes entry (string or { text, triggers }). */
export function entryText(e) {
  return normalizeEntry(e).text;
}

/** The trigger tags of a whys/fixes entry ([] for plain-string entries). */
export function entryTriggers(e) {
  return normalizeEntry(e).triggers;
}

/**
 * Internal pools (key -> { roasts[], whyEntries[], fixEntries[], compliments[],
 * cleanWhys[], keepUps[] }) — why/fix entries KEEP their trigger tags here;
 * the public THREE_LAYER_POOLS export below flattens them to copy text so
 * existing tests/tooling keep working unchanged.
 */
const POOLS = Object.freeze(
  Object.fromEntries(Object.entries(DATA.pools).map(([k, v]) => [
    k,
    Object.freeze({
      roasts: Object.freeze([...v.roasts]),
      whyEntries: Object.freeze((v.whys ?? []).map(normalizeEntry)),
      fixEntries: Object.freeze((v.fixes ?? []).map(normalizeEntry)),
      compliments: Object.freeze([...(v.compliments ?? [])]),
      cleanWhys: Object.freeze([...(v.cleanWhys ?? [])]),
      keepUps: Object.freeze([...(v.keepUps ?? [])]),
      // Roasts for the boilerplate TOTALS line when the category's ONLY
      // signals are legal/template/cta-type (no marketing phrases) — the
      // generic-wording roasts would mislabel a copyright line as "generic
      // phrase … nothing to say" (audit Q3.2). Token-compatible with the
      // totals line ({count}, {signalsNoun}, {words}); see buildCategoryInsights.
      legalSafeTotalsRoasts: Object.freeze([...(v.legalSafeTotalsRoasts ?? [])]),
      // Roasts for a DETAIL line whose OWN evidence tags as legal/copyright
      // ("1× copyright line", "2× cookie banner", …) — report-quality fix #3
      // (2026-10-01): one legal line is standard furniture, never "a
      // checklist"; {label}/{count}-compatible with the detail evidence
      // format (see buildCategoryInsights).
      legalSafeRoasts: Object.freeze([...(v.legalSafeRoasts ?? [])]),
    }),
  ])),
);

/** Raw pools (key -> { roasts[], whys[], fixes[], compliments[], cleanWhys[], keepUps[], legalSafeTotalsRoasts[], legalSafeRoasts[] }); whys/fixes entries flattened to their copy text (backward-compatible pre-trigger shape). Exposed for tests/tooling. */
export const THREE_LAYER_POOLS = Object.freeze(
  Object.fromEntries(Object.entries(POOLS).map(([k, p]) => [
    k,
    Object.freeze({
      roasts: p.roasts,
      whys: Object.freeze(p.whyEntries.map((e) => e.text)),
      fixes: Object.freeze(p.fixEntries.map((e) => e.text)),
      compliments: p.compliments,
      cleanWhys: p.cleanWhys,
      keepUps: p.keepUps,
      legalSafeTotalsRoasts: p.legalSafeTotalsRoasts,
      legalSafeRoasts: p.legalSafeRoasts,
    }),
  ])),
);

/** Valid pool keys: the seven breakdown categories. */
export const THREE_LAYER_KEYS = Object.freeze(Object.keys(THREE_LAYER_POOLS));

/** Per-category cap on generated insights (report stays bounded). */
export const MAX_INSIGHTS_PER_CATEGORY = 6;

/** Template tokens, e.g. "{phrase}" -> "phrase". */
function templateTokens(tpl) {
  return [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/**
 * Trigger tokens per category: token names that carry VERBATIM evidence
 * content (the quoted phrase, the copied sentence, the repeated text, the
 * page URLs, the image host/alt/kind...). When a finding has ANY trigger
 * token, only roast variants that reference at least one of its triggers are
 * eligible — a roast that can cite the real trigger MUST cite it (this is the
 * product's spine: "every roast must point at something real", and the reason
 * the specificity test can promise the roast shows the exact trigger). When a
 * finding has only contextual tokens (counts, word totals, percentages), any
 * applicable variant is fine — those values ARE the evidence.
 */
const TRIGGER_TOKENS = {
  filler: ['phrase'],
  boilerplate: ['phrase', 'sentence', 'text', 'label'],
  infoDensity: ['mattr', 'stopwordRatio', 'meanLen', 'shortPct', 'examples'],
  repetitive: ['phrase'],
  crossPage: ['urlA', 'urlB'],
  fingerprints: ['label'],
  assets: ['host', 'stem', 'alt', 'altKind'],
};

/** Token names a category treats as verbatim-evidence triggers. */
export function triggerTokensFor(category) {
  return TRIGGER_TOKENS[category] ?? [];
}

/** Replace {token} placeholders with the parsed evidence values. */
function interpolate(tpl, tokens) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, name) =>
    name in tokens ? String(tokens[name]) : `{${name}}`);
}

/** Deterministic pick (FNV-1a seed via scan id + key + index + kind). */
function pickVariant(candidates, seed) {
  return candidates[hashScanId(seed) % candidates.length];
}

/**
 * Signal tags for boilerplate SIGNAL labels (byte-for-byte from
 * src/rules/boilerplate.js SIGNALS — note the curly quotes \u201C \u201D).
 * Unknown/other labels return null from signalTagFor (never guess).
 */
const BOILERPLATE_LABEL_SIGNALS = {
  'generic \u201Clearn more\u201D link': 'learn-more',
  'cookie notice': 'legal',
  'cookie banner': 'legal',
  'cookie settings': 'legal',
  'consent manager': 'legal',
  'privacy policy': 'legal',
  'terms of service': 'legal',
  'copyright notice': 'legal',
  'copyright line': 'legal',
  'unsubscribe link': 'legal',
  'lorem ipsum placeholder': 'template',
  'placeholder text': 'template',
  'powered-by line': 'template',
  'newsletter subscribe block': 'cta',
  'newsletter signup': 'cta',
  'social-follow block': 'cta',
  'generic \u201Ccontact us\u201D link': 'cta',
  'comment form text': 'cta',
  'generic commitment claim': 'marketing',
  'generic mission statement': 'marketing',
  'marketing adjective': 'marketing',
  'marketing superlative': 'marketing',
  'marketing cliché': 'marketing',
  'generic corporate claim': 'marketing',
};

/**
 * Deterministic signal tag for a FINDING's evidence (content-integrity fix):
 * which specific problem did this finding fire on? Used to gate why/fix lines
 * so a cookie/legal/stock/alt-specific line can never ride on a finding about
 * something else. Returns ONE tag or null. null means the finding is eligible
 * for UNTAGGED (signal-agnostic) lines ONLY.
 *
 *   boilerplate:
 *     totals line "N generic wording matches in W words (...)"  -> null
 *     "N× repeated block: \"...\""                             -> 'repeated'
 *     "vague sentence: ..." / "hedge evidence: ..."            -> 'marketing'
 *     "N× vague phrase \"...\"" / "N× hedge phrase \"...\""    -> 'marketing'
 *     "N× <label>"                                             -> label map above
 *     unknown label                                            -> null
 *   assets (evidence formats per EVIDENCE_PARSERS.assets):
 *     "N of N images come from stock photo sites" / "from stock/placeholder
 *       CDNs" / "look generic or placeholder" / "flagged for stock/placeholder
 *       signals"                                                -> 'stock'
 *     "N of N images with placeholder/generic filenames"        -> 'filenames'
 *     "N of N images with missing or generic alt text"          -> 'alt'
 *     "img[N] stock photo host|stock/placeholder CDN «...»"     -> 'stock'
 *     "img[N] generic filename \"...\""                         -> 'filenames'
 *     "img[N] missing|empty alt (text|attribute)" and
 *     "img[N] generic alt \"...\""                              -> 'alt'
 *   every other category: every finding -> null (untagged-only, matches
 *   today's behavior).
 *
 * @param {string} category breakdown key (filler, boilerplate, ...)
 * @param {string} evidence the finding/evidence string
 * @returns {string|null} the signal tag, or null for signal-agnostic findings
 */
export function signalTagFor(category, evidence) {
  const f = String(evidence ?? '');
  if (category === 'boilerplate') {
    if (/^\d+ (?:generic wording match(?:es)?|boilerplate signal(?:\(s\)|s)?) in \d+ words/.test(f)) return null;
    if (/^\d+× repeated block: /.test(f)) return 'repeated';
    if (/^vague sentence: /.test(f) || /^hedge evidence: /.test(f)) return 'marketing';
    if (/^\d+× (?:vague|hedge) phrase /.test(f)) return 'marketing';
    const m = /^\d+× (.+)$/.exec(f);
    if (m) return BOILERPLATE_LABEL_SIGNALS[m[1]] ?? null;
    return null;
  }
  if (category === 'assets') {
    if (/^\d+ of \d+ images (?:come from stock photo sites|from stock\/placeholder CDNs|look generic or placeholder|flagged for stock\/placeholder signals)$/.test(f)) return 'stock';
    if (/^\d+ of \d+ images with placeholder\/generic filenames$/.test(f)) return 'filenames';
    if (/^\d+ of \d+ images with missing or generic alt text$/.test(f)) return 'alt';
    if (/^img\[\d+\] (?:stock photo host|stock\/placeholder CDN) /.test(f)) return 'stock';
    if (/^img\[\d+\] generic filename /.test(f)) return 'filenames';
    if (/^img\[\d+\] (?:missing|empty) alt (?:text|attribute)$/.test(f)) return 'alt';
    if (/^img\[\d+\] generic alt /.test(f)) return 'alt';
    return null;
  }
  return null;
}

/**
 * WHY/FIX ELIGIBILITY (content-integrity fix): an entry (string or
 * { text, triggers }) is eligible for a finding with `signalTag` iff it is
 * UNTAGGED (no triggers — the genuinely signal-agnostic generic fallback) or
 * its triggers include the finding's signal tag. Returns the eligible copy
 * texts in pool order.
 *
 * @param {Array<string|{text: string, triggers: string[]}>} entries
 * @param {string|null} signalTag
 * @returns {string[]}
 */
export function eligibleVariants(entries, signalTag) {
  return (entries ?? [])
    .filter((e) => {
      const triggers = entryTriggers(e);
      if (triggers.length === 0) return true;
      return signalTag !== null && triggers.includes(signalTag);
    })
    .map(entryText);
}

/**
 * Is this a boilerplate AGGREGATE (totals) line — "N generic wording
 * matches/boilerplate signals in W words (D per 300 words)"? The totals line
 * is a MEASUREMENT of the category's signal density, not a distinct signal of
 * its own: one copyright line produces ONE detail line ("1× copyright line")
 * AND this totals line. Report surfaces use this to render one signal as one
 * finding (audit Q3, owner-approved 2026-09-28) while keeping the density
 * measurement visible as a receipt, and the roast/teaser gates use it to
 * never label legal-only pages with generic-phrase copy.
 *
 * @param {string} finding the evidence string
 * @returns {boolean}
 */
export function isBoilerplateAggregateLine(finding) {
  return /^\d+ (?:generic wording match(?:es)?|boilerplate signal(?:\(s\)|s)?) in \d+ words/.test(String(finding ?? ''));
}

/**
 * Pick ONE eligible why/fix line deterministically, or null when the eligible
 * set is empty (the caller then OMITS that layer from the insight — never
 * draw from an ineligible pool). Seed format is unchanged from the original
 * selection (`${id}:${category}:${i}:why` / `:fix`) — same determinism and
 * hash variety WITHIN the eligible set.
 *
 * TRIGGER-PREFERRED SELECTION (report-integrity fix, owner-approved
 * 2026-09-28, audit Q1): when the finding HAS a signal tag AND at least one
 * trigger-matched line exists in the pool, selection happens ONLY inside that
 * trigger-matched subset — the untagged generic fallback becomes a true LAST
 * RESORT, reachable only when the tagged set is empty (or the finding has no
 * tag at all, which already meant untagged-only). This kills the residual
 * mismatch class where a legal finding could still land the marketing
 * fallback ~50% of scan ids: a legal finding always gets legal advice, a
 * marketing finding always gets marketing advice.
 */
export function selectEligible(entries, signalTag, seed) {
  if (signalTag !== null) {
    const tagged = (entries ?? [])
      .filter((e) => entryTriggers(e).includes(signalTag))
      .map(entryText);
    if (tagged.length > 0) return pickVariant(tagged, seed);
  }
  const eligible = eligibleVariants(entries, signalTag);
  if (eligible.length === 0) return null;
  return pickVariant(eligible, seed);
}

/**
 * Deterministic DISTINCT pick: like pickVariant, but never returns a line the
 * `used` set already holds (advances through the pool with salted seeds).
 * Falls back to a plain pick when the pool is too small. Used for the
 * token-free clean pools so one report never repeats a compliment line.
 */
function pickDistinct(candidates, seed, used) {
  if (candidates.length < 2) return pickVariant(candidates, seed);
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const tpl = pickVariant(candidates, `${seed}:distinct:${attempt}`);
    if (!used.has(tpl)) {
      used.add(tpl);
      return tpl;
    }
  }
  const tpl = pickVariant(candidates, seed);
  used.add(tpl);
  return tpl;
}

// ---------------------------------------------------------------------------
// Evidence parsers — turn each rule's finding string into {token: value}.
// Parser output shapes mirror the rule modules byte-for-byte (see src/rules/
// filler.js, boilerplate.js, copySlop.js, infoDensity.js, repetitive.js,
// crossPage.js, fingerprints.js, assets.js). Unparseable strings yield {} and
// fall back to the group's token-free roasts.
// ---------------------------------------------------------------------------

/** First "N× \"phrase\"" pair inside a list line (repetitive openings etc.). */
function firstDupPair(list) {
  const m = /(\d+)× "([^"]+)"/.exec(list);
  return m ? { count: m[1], phrase: m[2] } : {};
}

const EVIDENCE_PARSERS = {
  filler(f) {
    let m = /^(\d+) filler phrase(?:s| occurrence(?:\(s\)|s)?)? in (\d+) words \(([\d.]+) per \d+ words\)$/.exec(f);
    if (m) return { count: m[1], words: m[2], density: m[3] };
    m = /^(\d+)× "(.+)"$/.exec(f);
    if (m) return { count: m[1], phrase: m[2] };
    return {};
  },
  boilerplate(f) {
    let m = /^(\d+) (?:generic wording match(?:es)?|boilerplate signal(?:\(s\)|s)?) in (\d+) words \(([\d.]+) per \d+ words\)$/.exec(f);
    if (m) return { count: m[1], words: m[2], density: m[3] };
    m = /^(\d+)× repeated block: "(.+)"$/.exec(f);
    if (m) return { count: m[1], text: m[2] };
    m = /^vague sentence: "(.+)"$/.exec(f);
    if (m) return { sentence: m[1] };
    m = /^hedge evidence: "(.+)"$/.exec(f);
    if (m) return { sentence: m[1] };
    m = /^(\d+)× vague phrase "(.+)"$/.exec(f);
    if (m) return { count: m[1], phrase: m[2] };
    m = /^(\d+)× hedge phrase "(.+)"$/.exec(f);
    if (m) return { count: m[1], phrase: m[2] };
    m = /^(\d+)× (.+)$/.exec(f);
    if (m) return { count: m[1], label: m[2] };
    return {};
  },
  infoDensity(f) {
    let m = /^(?:word variety|vocabulary diversity \(MATTR-\d+\)): ([\d.]+) \(lower = more repetitive vocabulary\)$/.exec(f);
    if (m) return { mattr: m[1] };
    m = /^common words: ([\d.]+)%/.exec(f);
    if (m) return { stopwordRatio: m[1] };
    m = /^stopword ratio: ([\d.]+)%$/.exec(f);
    if (m) return { stopwordRatio: m[1] };
    m = /^(?:average sentence length|mean sentence length): ([\d.]+) words \((\d+) sentences\)$/.exec(f);
    if (m) return { meanLen: m[1], sentences: m[2] };
    m = /^short paragraphs \(<25 words\): ([\d.]+)% \((\d+) paragraphs\)$/.exec(f);
    if (m) return { shortPct: m[1], paragraphs: m[2] };
    m = /^specific details: only (\d+) in (\d+) words \(need at least (\d+) per \d+ words\)(?: — (.+))?$/.exec(f);
    if (m) return { count: m[1], words: m[2], needed: m[3], ...(m[4] ? { examples: m[4].replace(/^e\.g\.\s*/i, '') } : {}) };
    m = /^specific details: 0 found in (\d+) words — no dates, numbers, prices, percentages, or named references \(need at least (\d+) per \d+ words\)$/.exec(f);
    if (m) return { count: '0', words: m[1], needed: m[2] };
    m = /^concrete specifics: only (\d+) in (\d+) words \(need at least (\d+) per \d+ words\)(?: — (.+))?$/.exec(f);
    if (m) return { count: m[1], words: m[2], needed: m[3], ...(m[4] ? { examples: m[4].replace(/^e\.g\.\s*/i, '') } : {}) };
    m = /^concrete specifics: 0 found in (\d+) words — no dates, numbers, prices, percentages, or named references \(need at least (\d+) per \d+ words\)$/.exec(f);
    if (m) return { count: '0', words: m[1], needed: m[2] };
    return {};
  },
  repetitive(f) {
    let m = /^repeated sentence openings: (.+)$/.exec(f);
    if (m) return { kind: 'sentence openings', openings: m[1], ...firstDupPair(m[1]) };
    m = /^near-identical sentences: (.+)$/.exec(f);
    if (m) return { kind: 'near-identical sentences', openings: m[1], ...firstDupPair(m[1]) };
    m = /^repeated paragraphs: (.+)$/.exec(f);
    if (m) return { kind: 'repeated paragraphs', openings: m[1], ...firstDupPair(m[1]) };
    m = /^no notable repetitive structure \((\d+) sentences, (\d+) paragraphs\)$/.exec(f);
    if (m) return { sentences: m[1], paragraphs: m[2] };
    return {};
  },
  crossPage(f) {
    let m = /^(?:same content on multiple pages: (\d+) page pair(?:\(s\)|s)?, most similar at ([\d.]+)%|cross-page duplication: (\d+) flagged pair(?:\(s\)|s)?, max similarity ([\d.]+)%)$/.exec(f);
    if (m) return { pairCount: m[1] ?? m[3], maxSim: m[2] ?? m[4] };
    m = /^near-identical page pair: (\S+) ~ (\S+) \(([\d.]+)% similar\)$/.exec(f);
    if (m) return { urlA: m[1], urlB: m[2], sim: m[3] };
    m = /^(?:the same content appears on (\d+) pages \(they're essentially the same page\)|content duplicated across (\d+) pages \(fully-connected cluster\))$/.exec(f);
    if (m) return { count: m[1] ?? m[2] };
    m = /^(?:no two pages are more than \d+% the same \((\d+) pages compared\)|no page pairs above \d+% similarity \((\d+) pages compared\))$/.exec(f);
    if (m) return { pages: m[1] ?? m[2] };
    return {};
  },
  fingerprints(f) {
    const m = /^(?:recognizable template sign in the page (\w+): (.+) \((\w+) confidence\)|pattern evidence in (\w+): (.+) \((\w+) confidence, template-like signal\))$/.exec(f);
    if (m) return { scope: m[1] ?? m[4], label: m[2] ?? m[5], confidence: m[3] ?? m[6] };
    return {};
  },
  assets(f) {
    let m = /^(?:(\d+) of (\d+) images come from stock photo sites|(\d+) of (\d+) images from stock\/placeholder CDNs)$/.exec(f);
    if (m) return { stockCount: m[1] ?? m[3], total: m[2] ?? m[4] };
    m = /^(\d+) of (\d+) images with placeholder\/generic filenames$/.exec(f);
    if (m) return { fileCount: m[1], total: m[2] };
    m = /^(\d+) of (\d+) images with missing or generic alt text$/.exec(f);
    if (m) return { altCount: m[1], total: m[2] };
    m = /^(?:(\d+) of (\d+) images look generic or placeholder|(\d+) of (\d+) images flagged for stock\/placeholder signals)$/.exec(f);
    if (m) return { cleanCount: m[1] ?? m[3], total: m[2] ?? m[4] };
    m = /^img\[(\d+)\] (?:stock photo host|stock\/placeholder CDN) «([^»]+)» \((.*)\)$/.exec(f);
    if (m) return { index: m[1], host: m[2], src: m[3] };
    m = /^img\[(\d+)\] generic filename "(.+)" \((.*)\)$/.exec(f);
    if (m) return { index: m[1], stem: m[2], src: m[3] };
    m = /^img\[(\d+)\] (missing|empty) alt (?:text|attribute)$/.exec(f);
    if (m) return { index: m[1], altKind: m[2] };
    m = /^img\[(\d+)\] generic alt "(.+)"$/.exec(f);
    if (m) return { index: m[1], alt: m[2] };
    return {};
  },
};

/** Parse one evidence string into { token: value } (all string values). */
export function parseEvidenceTokens(category, finding) {
  const parser = EVIDENCE_PARSERS[category];
  if (!parser) return {};
  const tokens = parser(String(finding ?? ''));
  // Plural-noun tokens (dashboard final cleanup 2026-09-23 — presentation copy
  // only, never scoring/classification): pool templates may reference
  // {phrasesNoun} / {signalsNoun} / {specificsNoun} / {factsNoun} / {repeatsNoun}
  // / {appearancesNoun} / {pairsNoun} instead of a hard-coded "(s)" placeholder.
  // They carry the correct singular/plural form for the finding's own count
  // token, so "1 generic phrase" and "7 generic phrases" both render cleanly.
  // (Plain-English pass 2026-09-23: signalsNoun pluralizes "phrase(s)",
  // specificsNoun pluralizes "detail(s)" — no jargon nouns in output copy.)
  if ('count' in tokens) {
    const n = Number(tokens.count);
    if (category === 'filler') {
      tokens.phrasesNoun = n === 1 ? 'phrase' : 'phrases';
      tokens.buzzwordsNoun = n === 1 ? 'buzzword' : 'buzzwords';
    } else if (category === 'boilerplate') {
      tokens.signalsNoun = n === 1 ? 'phrase' : 'phrases';
    } else if (category === 'infoDensity') {
      tokens.specificsNoun = n === 1 ? 'detail' : 'details';
      tokens.factsNoun = n === 1 ? 'fact' : 'facts';
    } else if (category === 'repetitive') {
      tokens.repeatsNoun = n === 1 ? 'repeat' : 'repeats';
      tokens.appearancesNoun = n === 1 ? 'appearance' : 'appearances';
    }
  }
  if (category === 'crossPage' && ('pairCount' in tokens || 'count' in tokens)) {
    tokens.pairsNoun = Number(tokens.pairCount ?? tokens.count) === 1 ? 'pair' : 'pairs';
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// CLEAN-evidence matcher — "clean findings should be compliments, not insults"
// (owner rule 2026-09-16). A per-finding DETERMINISTIC judgment derived from
// the rule modules' own evidence formats (mirrored byte-for-byte):
//
//   filler      "0 filler phrase occurrences in N words (0.0 per 300 words)"
//               — only emitted when the detector found zero hits. (Legacy rows
//               wrote the pre-pluralization "occurrence(s)" form; the matcher
//               below tolerates both so stored bytes never change meaning.)
//   boilerplate "0 boilerplate signals in N words (0.0 per 300 words)"
//               — same: zero signals across every regex + hedge + dup check.
//               (Legacy "signal(s)" form also matched.)
//   infoDensity the four metric lines are ALWAYS emitted; a line is clean only
//               inside the rule's zero-penalty band (ttrSub/stopSub/sentSub/
//               paraSub === 0): MATTR >= 0.85, stopwords <= 40%, mean sentence
//               length 12-26 words, short paragraphs 0%. The "concrete
//               specifics: 0 found / only N …" lines are GAP findings (the
//               WORST case for that detector) and are NEVER clean.
//   repetitive  "no notable repetitive structure (N sentences, N paragraphs)"
//               — emitted only when all three sub-detectors came back empty.
//   crossPage   "no page pairs above 80% similarity (N pages compared)"
//               — emitted only when no pair crossed the 0.80 threshold.
//   fingerprints "no recognizable template signs detected" — emitted by the
//               rule module when a scan finds zero pattern hits (added with
//               the report-integrity fix 2026-09-28 so DESIGN compliments like
//               the other six categories). Pattern-hit findings remain the
//               only negative evidence format.
//   assets      "0 of N images flagged for stock/placeholder signals" (full
//               category clean) plus the per-signal zero lines ("0 of N images
//               from stock/placeholder CDNs", "…with placeholder/generic
//               filenames", "…with missing or generic alt text") which measure
//               a specific healthy dimension and may accompany other signals'
//               negative lines — each is complimented on its own evidence.
//
// Anything not matched is a real negative pattern -> normal roast treatment.
// ---------------------------------------------------------------------------
const CLEAN_EVIDENCE = {
  filler(f) {
    return /^0 filler phrase(?:s| occurrence(?:\(s\)|s)?)? in \d+ words \(0\.0 per \d+ words\)$/.test(f);
  },
  boilerplate(f) {
    return /^0 (?:generic wording match(?:es)?|boilerplate signal(?:\(s\)|s)?) in \d+ words \(0\.0 per \d+ words\)$/.test(f);
  },
  infoDensity(f) {
    let m = /^(?:word variety|vocabulary diversity \(MATTR-\d+\)): ([\d.]+) \(lower = more repetitive vocabulary\)$/.exec(f);
    if (m) return Number(m[1]) >= 0.85; // word-variety zero-penalty band (word-variety sub = 0)
    m = /^common words: ([\d.]+)%/.exec(f);
    if (m) return Number(m[1]) <= 40.0; // common-word sub = 0 at/below the 40% floor
    m = /^stopword ratio: ([\d.]+)%$/.exec(f);
    if (m) return Number(m[1]) <= 40.0; // legacy label, same band
    m = /^(?:average sentence length|mean sentence length): ([\d.]+) words \(\d+ sentences\)$/.exec(f);
    if (m) return Number(m[1]) >= 12 && Number(m[1]) <= 26; // average-length sub = 0 in the sweet spot
    m = /^short paragraphs \(<25 words\): (\d+)% \(\d+ paragraphs\)$/.exec(f);
    if (m) return Number(m[1]) === 0; // short-paragraph sub = 0 only at zero short paragraphs
    return false; // "specific details: 0 found / only N …" are gap (negative) lines
  },
  repetitive(f) {
    return /^no notable repetitive structure \(\d+ sentences, \d+ paragraphs\)$/.test(f);
  },
  crossPage(f) {
    return /^(?:no two pages are more than \d+% the same \(\d+ pages compared\)|no page pairs above \d+% similarity \(\d+ pages compared\))$/.test(f);
  },
  fingerprints(f) {
    // DESIGN clean line (report-integrity fix, owner-approved 2026-09-28,
    // audit Q2): analyzeFingerprints now emits "no recognizable template
    // signs detected" when a scan finds zero pattern hits, so DESIGN
    // compliments like the other six categories when truly clean (its
    // compliments pool was previously unreachable dead copy).
    return /^no recognizable template signs detected$/.test(f);
  },
  assets(f) {
    if (/^0 of \d+ images look generic or placeholder$/.test(f)) return true;
    if (/^0 of \d+ images flagged for stock\/placeholder signals$/.test(f)) return true;
    if (/^0 of \d+ images come from stock photo sites$/.test(f)) return true;
    if (/^0 of \d+ images from stock\/placeholder CDNs$/.test(f)) return true;
    if (/^0 of \d+ images with placeholder\/generic filenames$/.test(f)) return true;
    return /^0 of \d+ images with missing or generic alt text$/.test(f);
  },
};

/**
 * Does this evidence string describe a CLEAN measurement (the detector found
 * nothing to penalize)? Deterministic per (category, evidence); mirrors the
 * rule modules' evidence formats and zero-penalty bands exactly. Used by the
 * insight derivation to route clean findings to compliments instead of roasts.
 *
 * @param {string} category breakdown key (filler, boilerplate, ...)
 * @param {string} finding the finding/evidence string
 * @returns {boolean} true when the measurement is clean
 */
export function isCleanEvidence(category, finding) {
  const matcher = CLEAN_EVIDENCE[category];
  return matcher ? matcher(String(finding ?? '')) : false;
}

/**
 * Is this evidence one of the infoDensity METRIC MEASUREMENT lines (the four
 * always-emitted diagnostics: vocabulary diversity, stopword ratio, mean
 * sentence length, short-paragraph prevalence)? Owner rule (2026-09-17,
 * full-report IA §4): "metrics are not automatically findings" — a raw metric
 * reading is a measurement, not a problem; it becomes evidence of a problem
 * only when the existing detector logic flags it as a negative signal. The
 * "concrete specifics" gap lines are NOT metric measurements — they are
 * conditionally-emitted detector findings (only present when the detector
 * found a gap) and always keep their negative-finding semantics.
 *
 * @param {string} category breakdown key
 * @param {string} finding the finding/evidence string
 * @returns {boolean} true when this is one of the four metric measurement lines
 */
export function isMetricFinding(category, finding) {
  if (category !== 'infoDensity') return false;
  const f = String(finding ?? '');
  return (
    /^(?:word variety|vocabulary diversity \(MATTR-\d+\)): [\d.]+ \(lower = more repetitive vocabulary\)$/.test(f) ||
    // The common-words line ships with the rule's parenthetical annotation
    // ("…% (little words like \"the\" and \"and\" — …)"), which must not
    // knock the line out of the metric class — a measurement is a
    // measurement with or without its commentary (report-quality fix #4,
    // owner-approved 2026-10-01). Bare legacy forms still match.
    /^(?:common words|stopword ratio): [\d.]+%(?: \([^)]*\))?$/.test(f) ||
    /^(?:average sentence length|mean sentence length): [\d.]+ words \(\d+ sentences\)$/.test(f) ||
    /^short paragraphs \(<25 words\): \d+% \(\d+ paragraphs\)$/.test(f)
  );
}

/**
 * Classify ONE finding for the REPORT LAYER (owner full-report IA 2026-09-17).
 *
 * The report needs to know, per finding, whether it is:
 *   'negative' — a real detector problem: renders as THE ROAST / WHY IT
 *                MATTERS / HOW TO FIX IT / THE RECEIPTS, counts in summaries,
 *                feeds What To Fix First.
 *   'clean'    — a healthy measurement: renders as a short positive
 *                observation (compliment) with its evidence, never a roast,
 *                never counted as a finding.
 *   'metric'   — a diagnostic METRIC MEASUREMENT line that sits outside the
 *                healthy band: shown as neutral evidence, NEVER a negative
 *                finding/roast, NEVER counted (owner IA §4: metrics are not
 *                automatically findings — a raw metric reading is not a
 *                problem, it is a measurement).
 *
 * Deterministic: derived strictly from the stored insight kind (when present)
 * and the evidence string via isCleanEvidence / isMetricFinding — the same
 * machinery the insight builder uses, so stored and derived results agree.
 *
 * @param {string} category breakdown key (filler, boilerplate, infoDensity, ...)
 * @param {string} finding the finding/evidence string
 * @param {object|null} [insight] the three-layer insight for this finding, if any
 * @returns {'negative'|'clean'|'metric'}
 */
export function classifyFinding(category, finding, insight) {
  const kind = insight && typeof insight.kind === 'string' ? insight.kind : '';
  if (kind === 'clean') return 'clean';
  if (kind === 'metric') return 'metric';
  if (isCleanEvidence(category, finding)) return 'clean';
  if (isMetricFinding(category, finding)) return 'metric';
  return 'negative';
}

/**
 * Verify a template's declared tokens all exist in the parsed evidence AND,
 * when the finding carries verbatim-evidence trigger tokens, that the variant
 * references at least one of them (specificity rule above). Token-free
 * templates are the fallback for findings with no tokens at all (they are
 * deliberately NOT used when evidence tokens exist — a roast that can cite the
 * trigger must cite the trigger).
 */
function eligibleRoasts(pool, tokens, category) {
  const tt = templateTokens;
  const triggers = TRIGGER_TOKENS[category] ?? [];
  const present = Object.keys(tokens);
  const triggerPresent = present.filter((t) => triggers.includes(t));
  return pool.roasts.filter((tpl) => {
    const declared = tt(tpl);
    if (present.length === 0) return declared.length === 0;
    if (declared.length === 0) return false;
    if (!declared.every((t) => t in tokens)) return false;
    if (triggerPresent.length > 0 && !declared.some((t) => triggerPresent.includes(t))) return false;
    return true;
  });
}

/**
 * Signal tags that are NOT marketing phrases — a boilerplate category whose
 * every detail signal is one of these (legal/template/cta/learn-more) must
 * never be roasted as "generic phrase … having nothing to say": the flagged
 * element is standard-issue legal/CTA furniture, not empty marketing copy
 * (audit Q3.2, owner-approved 2026-09-28). 'repeated' and unknown/null tags
 * are deliberately NOT in the safe set — a repeated block or an unrecognized
 * label could be marketing content, so those keep the generic-wording roasts.
 */
const NON_MARKETING_BOILERPLATE_TAGS = new Set(['legal', 'template', 'cta', 'learn-more']);

/**
 * True when a boilerplate findings list is "legal-safe to roast as boilerplate
 * furniture": it carries NO aggregate/totals-only signal, AND every detail
 * line's signal tag is one of the NON-MARKETING tags (legal/template/cta/
 * learn-more). A list with no detail lines (a lone totals line) is NOT
 * legal-safe — conservative: without sibling signals we cannot know.
 * Deterministic (pure function of the evidence strings).
 */
function isLegalSafeBoilerplate(findings) {
  if (!Array.isArray(findings)) return false;
  let sawDetail = false;
  for (const raw of findings) {
    const f = String(raw ?? '');
    if (isBoilerplateAggregateLine(f)) continue;
    sawDetail = true;
    if (!NON_MARKETING_BOILERPLATE_TAGS.has(signalTagFor('boilerplate', f))) return false;
  }
  return sawDetail;
}

/**
 * Build the three-layer insights for ONE category from its findings.
 * Deterministic for a given (category, findings, id): same inputs -> identical
 * insights, always. Capped at MAX_INSIGHTS_PER_CATEGORY (first findings, in
 * list order); insight `i` corresponds to findings `i` (evidence is the
 * finding string itself).
 *
 * CLEAN vs NEGATIVE (owner rule 2026-09-16: "clean findings should be
 * compliments, not insults"):
 *   - a finding whose evidence proves a CLEAN measurement (isCleanEvidence —
 *     zero/none counts, healthy metric bands, "no ... found" lines) emits the
 *     COMPLIMENT variant: { kind: 'clean', roast: <compliment>, why: <cleanWhy>,
 *     fix: <keepUp>, evidence }, picked from that category's compliments /
 *     cleanWhys / keepUps pools.
 *   - a finding with a real negative pattern emits exactly today's roast/why/fix
 *     with NO kind marker (bytes unchanged: new scans of negative findings are
 *     byte-identical to pre-change output).
 * Compliments are token-free by design (the evidence/receipt line carries the
 * measurement verbatim, exactly as roasts' receipts do).
 *
 * @param {object} opts
 * @param {string} opts.category breakdown key (filler, boilerplate, ...)
 * @param {string[]} [opts.findings] the category's evidence strings
 * @param {string} opts.id scan id (seed)
 * @returns {Array<{ roast: string, why?: string, fix?: string, evidence: string, kind?: 'clean' }>}
 *   Negative insights carry why/fix ONLY when the finding has at least one
 *   eligible (untagged or trigger-matched) line for that layer — a layer with
 *   an empty eligible set is omitted (never drawn from an ineligible pool).
 */
export function buildCategoryInsights({ category, findings = [], id }) {
  const pool = POOLS[category];
  if (!pool || findings.length === 0) return [];
  // Legal-safe totality flag (audit Q3.2): when EVERY detail signal behind a
  // boilerplate category is legal/template/cta-type (no marketing phrase), the
  // TOTALS line must not roast "generic phrase … a record for having nothing
  // to say" — the flagged element is a copyright line / legal footer, not
  // empty marketing copy. Computed once per build from the whole findings
  // list; deterministic.
  const legalSafeBoilerplate = category === 'boilerplate' && isLegalSafeBoilerplate(findings);
  // Deterministic distinct-pick bookkeeping for the clean (token-free) lines:
  // per build, a compliment/cleanWhy/keepUp line is used at most once.
  const usedCompliments = new Set();
  const usedCleanWhys = new Set();
  const usedKeepUps = new Set();
  return findings.slice(0, MAX_INSIGHTS_PER_CATEGORY).map((evidence, i) => {
    const tokens = parseEvidenceTokens(category, evidence);
    // (Plural-noun tokens like {phrasesNoun}/{signalsNoun}/{pairsNoun} are
    // synthesized inside parseEvidenceTokens above — presentation copy only.)

    // Owner rule: a clean measurement gets a compliment, never a roast. The
    // clean signal comes from the EVIDENCE ITSELF (deterministic, rule-shaped:
    // zero/none counts and healthy metric bands), so the same input always
    // produces the same variant. Compliments are token-free, so a category's
    // picks are kept DISTINCT (deterministic advance through the pool) — a
    // report never shows the same compliment twice.
    if (isCleanEvidence(category, evidence)) {
      const compTpl = pickDistinct(pool.compliments, `${id}:${category}:${i}:compliment`, usedCompliments);
      const whyTpl = pickDistinct(pool.cleanWhys, `${id}:${category}:${i}:cleanWhy`, usedCleanWhys);
      const keepTpl = pickDistinct(pool.keepUps, `${id}:${category}:${i}:keepUp`, usedKeepUps);
      return {
        kind: 'clean',
        roast: interpolate(compTpl, tokens),
        why: interpolate(whyTpl, tokens),
        fix: interpolate(keepTpl, tokens),
        evidence: String(evidence),
      };
    }

    // METRIC MEASUREMENT LINES (owner full-report IA §4) — the four infoDensity
    // metric lines are always-emitted diagnostics. STORED BYTES stay unchanged
    // for deterministic, backward-compatible insights; the REPORT/teaser layers
    // gate via classifyFinding() (a metric measurement never renders as a
    // negative finding/roast even when its stored insight is a roast-shaped
    // line). In-band metric lines take the kind:'clean' branch above.
    const roasts = eligibleRoasts(pool, tokens, category);
    // CONTENT-INTEGRITY (owner Option 1, approved): why/fix lines are now
    // SIGNAL-GATED. Only entries eligible for this finding's signal tag (see
    // signalTagFor / eligibleVariants) may be picked; the tag is computed here
    // so the roast routing below can also key on it.
    const signalTag = signalTagFor(category, evidence);
    // Audit Q3.2 (owner-approved 2026-09-28): on a legal-safe boilerplate
    // category, the TOTALS line draws from the legalSafeTotalsRoasts pool
    // instead of the generic-wording roasts — a copyright-only page must
    // roast the legal element as what it is, never as "generic phrase …
    // having nothing to say". Other detail lines keep their label-citing
    // roasts (legal-tagged ones route to legalSafeRoasts below).
    let roastCandidates = roasts;
    // Report-quality fix #3 (owner-approved 2026-10-01): a DETAIL finding
    // whose own evidence tags as legal/copyright ("1× copyright line",
    // "2× cookie banner", …) draws its card roast from the legalSafeRoasts
    // pool, never the generic marketing-card roasts ("…it's a checklist",
    // "greatest-hits album" overstate a single legal line as invented
    // clutter). The gate is the finding's OWN tag — template/cta/learn-more
    // and untagged signals keep the generic pools exactly as before.
    if (category === 'boilerplate' && signalTag === 'legal' && pool.legalSafeRoasts?.length > 0) {
      roastCandidates = pool.legalSafeRoasts;
    } else if (legalSafeBoilerplate && isBoilerplateAggregateLine(evidence) && pool.legalSafeTotalsRoasts.length > 0) {
      roastCandidates = pool.legalSafeTotalsRoasts;
    }
    // Defensive: the eligible set is never empty (every group ships token-free
    // roasts), but stay crash-proof against future copy edits.
    const roastTpl = pickVariant(roastCandidates.length > 0 ? roastCandidates : pool.roasts, `${id}:${category}:${i}:roast`);
    const whyTpl = selectEligible(pool.whyEntries, signalTag, `${id}:${category}:${i}:why`);
    const fixTpl = selectEligible(pool.fixEntries, signalTag, `${id}:${category}:${i}:fix`);
    const insight = { roast: interpolate(roastTpl, tokens) };
    if (whyTpl !== null) insight.why = interpolate(whyTpl, tokens);
    if (fixTpl !== null) insight.fix = interpolate(fixTpl, tokens);
    insight.evidence = String(evidence);
    return insight;
  });
}

/**
 * Attach insights to every breakdown category that has findings. Idempotent:
 * a category that already carries a stored `insights` array keeps it (GET on
 * saved scans must return the stored bytes; legacy rows predating the feature
 * get them derived deterministically from the stored id + breakdown).
 *
 * @param {Record<string, { findings?: string[], insights?: any[] }>} breakdown
 * @param {string} id scan id (seed for derivation)
 * @returns {Record<string, any>} new breakdown object (rules cloned, insights added)
 */
export function withInsights(breakdown = {}, id) {
  const out = {};
  for (const [key, rule] of Object.entries(breakdown)) {
    if (rule && typeof rule === 'object' && Array.isArray(rule.findings)) {
      const insights = Array.isArray(rule.insights)
        ? rule.insights
        : buildCategoryInsights({ category: key, findings: rule.findings, id });
      out[key] = { ...rule, insights };
    } else {
      out[key] = rule;
    }
  }
  return out;
}