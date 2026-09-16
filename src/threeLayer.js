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
 *               trust, conversion). Group-level, no tokens.
 *   fix       — specific, actionable remediation. Group-level, no tokens.
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

/** Raw pools (key -> { roasts[], whys[], fixes[], compliments[], cleanWhys[], keepUps[] }). Exposed for tests/tooling. */
export const THREE_LAYER_POOLS = Object.freeze(
  Object.fromEntries(Object.entries(DATA.pools).map(([k, v]) => [
    k,
    Object.freeze({
      roasts: Object.freeze([...v.roasts]),
      whys: Object.freeze([...v.whys]),
      fixes: Object.freeze([...v.fixes]),
      compliments: Object.freeze([...(v.compliments ?? [])]),
      cleanWhys: Object.freeze([...(v.cleanWhys ?? [])]),
      keepUps: Object.freeze([...(v.keepUps ?? [])]),
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
    let m = /^(\d+) filler phrase occurrence\(s\) in (\d+) words \(([\d.]+) per \d+ words\)$/.exec(f);
    if (m) return { count: m[1], words: m[2], density: m[3] };
    m = /^(\d+)× "(.+)"$/.exec(f);
    if (m) return { count: m[1], phrase: m[2] };
    return {};
  },
  boilerplate(f) {
    let m = /^(\d+) boilerplate signal\(s\) in (\d+) words \(([\d.]+) per \d+ words\)$/.exec(f);
    if (m) return { count: m[1], words: m[2], density: m[3] };
    m = /^(\d+)× repeated block: "(.+)"$/.exec(f);
    if (m) return { count: m[1], text: m[2] };
    m = /^hedge evidence: "(.+)"$/.exec(f);
    if (m) return { sentence: m[1] };
    m = /^(\d+)× hedge phrase "(.+)"$/.exec(f);
    if (m) return { count: m[1], phrase: m[2] };
    m = /^(\d+)× (.+)$/.exec(f);
    if (m) return { count: m[1], label: m[2] };
    return {};
  },
  infoDensity(f) {
    let m = /^vocabulary diversity \(MATTR-\d+\): ([\d.]+) \(lower = more repetitive vocabulary\)$/.exec(f);
    if (m) return { mattr: m[1] };
    m = /^stopword ratio: ([\d.]+)%$/.exec(f);
    if (m) return { stopwordRatio: m[1] };
    m = /^mean sentence length: ([\d.]+) words \((\d+) sentences\)$/.exec(f);
    if (m) return { meanLen: m[1], sentences: m[2] };
    m = /^short paragraphs \(<25 words\): ([\d.]+)% \((\d+) paragraphs\)$/.exec(f);
    if (m) return { shortPct: m[1], paragraphs: m[2] };
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
    let m = /^cross-page duplication: (\d+) flagged pair\(s\), max similarity ([\d.]+)%$/.exec(f);
    if (m) return { pairCount: m[1], maxSim: m[2] };
    m = /^near-identical page pair: (\S+) ~ (\S+) \(([\d.]+)% similar\)$/.exec(f);
    if (m) return { urlA: m[1], urlB: m[2], sim: m[3] };
    m = /^content duplicated across (\d+) pages \(fully-connected cluster\)$/.exec(f);
    if (m) return { count: m[1] };
    m = /^no page pairs above \d+% similarity \((\d+) pages compared\)$/.exec(f);
    if (m) return { pages: m[1] };
    return {};
  },
  fingerprints(f) {
    const m = /^pattern evidence in (\w+): (.+) \((\w+) confidence, template-like signal\)$/.exec(f);
    if (m) return { scope: m[1], label: m[2], confidence: m[3] };
    return {};
  },
  assets(f) {
    let m = /^(\d+) of (\d+) images from stock\/placeholder CDNs$/.exec(f);
    if (m) return { stockCount: m[1], total: m[2] };
    m = /^(\d+) of (\d+) images with placeholder\/generic filenames$/.exec(f);
    if (m) return { fileCount: m[1], total: m[2] };
    m = /^(\d+) of (\d+) images with missing or generic alt text$/.exec(f);
    if (m) return { altCount: m[1], total: m[2] };
    m = /^(\d+) of (\d+) images flagged for stock\/placeholder signals$/.exec(f);
    if (m) return { cleanCount: m[1], total: m[2] };
    m = /^img\[(\d+)\] stock\/placeholder CDN «([^»]+)» \((.*)\)$/.exec(f);
    if (m) return { index: m[1], host: m[2], src: m[3] };
    m = /^img\[(\d+)\] generic filename "(.+)" \((.*)\)$/.exec(f);
    if (m) return { index: m[1], stem: m[2], src: m[3] };
    m = /^img\[(\d+)\] (missing|empty) alt attribute$/.exec(f);
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
  return parser(String(finding ?? ''));
}

// ---------------------------------------------------------------------------
// CLEAN-evidence matcher — "clean findings should be compliments, not insults"
// (owner rule 2026-09-16). A per-finding DETERMINISTIC judgment derived from
// the rule modules' own evidence formats (mirrored byte-for-byte):
//
//   filler      "0 filler phrase occurrence(s) in N words (0.0 per 300 words)"
//               — only emitted when the detector found zero hits.
//   boilerplate "0 boilerplate signal(s) in N words (0.0 per 300 words)"
//               — same: zero signals across every regex + hedge + dup check.
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
//   fingerprints findings only exist on pattern hits — there is no clean
//               evidence format, so this category never compliments (a clean
//               fingerprints scan simply has no findings/insights at all).
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
    return /^0 filler phrase occurrence\(s\) in \d+ words \(0\.0 per \d+ words\)$/.test(f);
  },
  boilerplate(f) {
    return /^0 boilerplate signal\(s\) in \d+ words \(0\.0 per \d+ words\)$/.test(f);
  },
  infoDensity(f) {
    let m = /^vocabulary diversity \(MATTR-\d+\): ([\d.]+) \(lower = more repetitive vocabulary\)$/.exec(f);
    if (m) return Number(m[1]) >= 0.85; // MATTR zero-penalty band (ttrSub = 0)
    m = /^stopword ratio: ([\d.]+)%$/.exec(f);
    if (m) return Number(m[1]) <= 40.0; // stopSub = 0 at/below the 40% floor
    m = /^mean sentence length: ([\d.]+) words \(\d+ sentences\)$/.exec(f);
    if (m) return Number(m[1]) >= 12 && Number(m[1]) <= 26; // sentSub = 0 in the sweet spot
    m = /^short paragraphs \(<25 words\): (\d+)% \(\d+ paragraphs\)$/.exec(f);
    if (m) return Number(m[1]) === 0; // paraSub = 0 only at zero short paragraphs
    return false; // "concrete specifics: 0 found / only N …" are gap (negative) lines
  },
  repetitive(f) {
    return /^no notable repetitive structure \(\d+ sentences, \d+ paragraphs\)$/.test(f);
  },
  crossPage(f) {
    return /^no page pairs above \d+% similarity \(\d+ pages compared\)$/.test(f);
  },
  fingerprints() {
    return false; // no clean evidence format exists; clean scans have no findings
  },
  assets(f) {
    if (/^0 of \d+ images flagged for stock\/placeholder signals$/.test(f)) return true;
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
 * @returns {Array<{ roast: string, why: string, fix: string, evidence: string, kind?: 'clean' }>}
 */
export function buildCategoryInsights({ category, findings = [], id }) {
  const pool = THREE_LAYER_POOLS[category];
  if (!pool || findings.length === 0) return [];
  // Deterministic distinct-pick bookkeeping for the clean (token-free) lines:
  // per build, a compliment/cleanWhy/keepUp line is used at most once.
  const usedCompliments = new Set();
  const usedCleanWhys = new Set();
  const usedKeepUps = new Set();
  return findings.slice(0, MAX_INSIGHTS_PER_CATEGORY).map((evidence, i) => {
    const tokens = parseEvidenceTokens(category, evidence);

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

    const roasts = eligibleRoasts(pool, tokens, category);
    // Defensive: the eligible set is never empty (every group ships token-free
    // roasts), but stay crash-proof against future copy edits.
    const roastTpl = pickVariant(roasts.length > 0 ? roasts : pool.roasts, `${id}:${category}:${i}:roast`);
    const whyTpl = pickVariant(pool.whys, `${id}:${category}:${i}:why`);
    const fixTpl = pickVariant(pool.fixes, `${id}:${category}:${i}:fix`);
    return {
      roast: interpolate(roastTpl, tokens),
      why: interpolate(whyTpl, tokens),
      fix: interpolate(fixTpl, tokens),
      evidence: String(evidence),
    };
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