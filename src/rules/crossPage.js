import { shingleJaccard, roundSimilarity } from './similarity.js';
import { STOPWORDS } from '../text.js';
import { applySkeletonTerm } from './skeletonFamily.js';
/**
 * Cross-Page Duplication rule.
 *
 * Signal: how much of the site's main content is duplicated across pages.
 * Method (documented): pairwise word 4-gram Jaccard similarity over each page's
 * MAIN content only (extractMainText — shared nav/footer/header never counts).
 *
 * Threshold (documented): pairs with similarity >= DUPLICATION_THRESHOLD (0.80)
 * are flagged as findings ("near-identical page pair" / "duplicated across N
 * pages"). Score mapping (documented):
 *
 *   no flagged pairs                          -> 0
 *   otherwise: maxSim over flagged pairs ->
 *     score = round(clamp((maxSim - 0.80) / 0.20 * 100, 0, 100))
 *
 *   0.80 -> 0, 1.00 -> 100 (a fully duplicated site). Linear in between.
 *
 * In-page repeated-phrase component (pass 2, owner 2026-10-01): the REPETITION
 * card's description ("repeated within the same page (e.g. templated
 * testimonials)") is implemented HERE — this module is the internal crossPage
 * rule, which IS the display REPETITION category (src/categories.js), while
 * repetitive.js (display STRUCTURE) stays untouched. A 4–12 word phrase /
 * sentence template that recurs 3+ times on the TARGET page (pages[0] — the
 * page the customer asked to scan) adds an additive score term:
 *
 *   phraseSub   = clamp(extras * PHRASE_EXTRAS_SCALE, 0, 100)  (extras = Σ count-1)
 *   score       = clamp(round(pairwiseScore + phraseSub * PHRASE_SUB_WEIGHT), 0, 100)
 *
 * Pages WITHOUT the signal score byte-identically to the pre-pass-2 module.
 * The in-page component measures the target page only (exactly like the other
 * content categories in the breakdown, which all run on the scanned URL) —
 * documented in the PR body.
 *
 * DOM-skeleton component (pass 3, round 2 — owner-approved 2026-10-06,
 * ROUND2-SPEC.md): the REPETITION card is the only site-wide channel, so the
 * structural twin of duplicated body copy — a repeated DOM template — lives
 * HERE as a second component. scan.js runs the skeleton detector
 * (src/rules/skeletonFamily.js) over the deduped scanned pages and passes the
 * result in as `skeleton`; the fired receipts ("N of the 5 scanned pages
 * share one DOM skeleton") surface in findings exactly like the phrase and
 * pair receipts, and the final score becomes:
 *
 *   score = clamp(round(pairwise + phraseSub + SKEL_SUB_WEIGHT * skeletonScore), 0, 100)
 *
 * Only ONE surface touch inside this module: when the detector fires, its two
 * receipts are appended to findings (single-page scans pass skeleton = null
 * and reproduce pass-2 behavior byte-for-byte — E1/E7).
 *
 * Less than 2 discoverable pages: the pairwise component is gracefully skipped
 * ({ score: null ... }) UNLESS the target page carries a measurable in-page
 * repeated-phrase signal — then the single-page scan still scores the phrase
 * component under REPETITION (a one-page landing site with templated
 * testimonials is the headline case; this is the owner-flagged scoring
 * consequence: crossPage's 0.30 weight now applies where it was previously
 * renormalized away).
 */
export const DUPLICATION_THRESHOLD = 0.8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- in-page repeated-phrase detector (moved from the pass-2 draft in
// --- repetitive.js; the detector itself is unchanged, including the
// --- punctuation->space normalization that unifies "platform-native" with
// --- "platform native").
const PHRASE_MIN_WORDS = 4;    // the 4-word minimum (owner scope)
const PHRASE_MAX_WORDS = 12;   // longer runs are sentence-level dupes anyway
const PHRASE_MIN_COUNT = 3;    // "appearing 3+ times on one page"
const PHRASE_MAX_FINDINGS = 3; // cap reported phrases per page (receipt list stays tight)
const CONTENT_WORD_MIN = 2;    // drop pure function-word runs ("in to the of")
const PHRASE_SUB_WEIGHT = 0.2; // additive share of the phrase subscore
const PHRASE_EXTRAS_SCALE = 12; // one 3× phrase => 24 subscore; caps at 100

/**
 * Normalization for the PHRASE detector ONLY (pass 2, 2026-10-01): non-letter/
 * non-number characters become SPACES (not nothing), so hyphenated compounds
 * like "platform-native" and "platform native" unify into the same phrase —
 * the value-prop line "a month of platform-native content" is the SAME claim
 * repeated as "a month of platform native posts". The three legacy signals in
 * repetitive.js keep their original punctuation-stripping normalization.
 */
const normalizePhrase = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function countContentWords(phrase, stopwords) {
  let n = 0;
  for (const w of phrase.split(' ')) if (!stopwords.has(w)) n += 1;
  return n;
}

/** Distinct paragraphs (and the page title) that contain the phrase, normalized. */
function countLocations(phrase, paragraphs = [], title = '') {
  let paragraphCount = 0;
  for (const p of paragraphs) {
    if (normalizePhrase(p).includes(phrase)) paragraphCount += 1;
  }
  return { title: normalizePhrase(String(title)).includes(phrase), paragraphCount };
}

/**
 * Detect 4–12 word phrases / sentence templates that recur PHRASE_MIN_COUNT
 * times on the page. Corpus = the page <title> (when present) + every
 * sentence, windowed WITHIN sentence bounds (a phrase never spans two
 * sentences), normalized with punctuation-to-space (so "platform-native" and
 * "platform native" unify — the phrase detector's own normalization; the
 * legacy signals keep their punctuation-stripping normalization).
 *
 * Hard filters (deterministic, evidence-backed):
 *   - phrase length >= PHRASE_MIN_WORDS words;
 *   - total occurrences >= PHRASE_MIN_COUNT;
 *   - occurrences spread over >= 2 distinct sentences (a one-line stutter is
 *     not a page-wide template);
 *   - >= CONTENT_WORD_MIN non-stopword words (pure function-word runs are
 *     not a claim being repeated).
 * Containment dedupe: a candidate CONTAINED inside an already-selected longer
 * candidate with the SAME occurrence count adds no information and is dropped
 * (deterministic sort: count desc, then length desc, then lexicographic).
 *
 * The conservative boundary (owner 2026-10-01): this is SENTENCE-TEMPLATE
 * similarity with different fillers — it does NOT do DOM page-skeleton
 * sequence matching, so it can't tell whether the repeated blocks are
 * testimonials vs. section headers. It reports the shared wording (the actual
 * template) with real counts, which is honest for either case.
 *
 * @returns {Array<{phrase: string, count: number}>} selected repeated phrases
 */
export function findRepeatedPhrases({ title = '', sentences = [], paragraphs = [], stopwords = STOPWORDS } = {}) {
  const corpus = [];
  if (String(title || '').trim()) corpus.push(normalizePhrase(String(title)));
  for (const s of sentences) corpus.push(normalizePhrase(s));
  const live = corpus.filter((s) => s.length >= PHRASE_MIN_WORDS);
  if (live.length === 0) return [];

  const counts = new Map();
  for (const sent of live) {
    const words = sent.split(' ');
    const maxN = Math.min(PHRASE_MAX_WORDS, words.length);
    for (let n = PHRASE_MIN_WORDS; n <= maxN; n += 1) {
      for (let i = 0; i + n <= words.length; i += 1) {
        const phrase = words.slice(i, i + n).join(' ');
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }

  const candidates = [];
  for (const [phrase, count] of counts) {
    if (count < PHRASE_MIN_COUNT) continue;
    if (countContentWords(phrase, stopwords) < CONTENT_WORD_MIN) continue;
    let inSents = 0;
    for (const sent of live) {
      if (sent.includes(phrase)) inSents += 1;
    }
    if (inSents < 2) continue;
    candidates.push({ phrase, count });
  }

  const selected = [];
  candidates
    .sort((a, b) => b.count - a.count || b.phrase.split(' ').length - a.phrase.split(' ').length || a.phrase.localeCompare(b.phrase))
    .forEach((c) => {
      const dominated = selected.some((s) => s.count === c.count && s.phrase.includes(c.phrase));
      if (!dominated && selected.length < PHRASE_MAX_FINDINGS) selected.push(c);
    });
  return selected;
}

/**
 * In-page repeated-phrase component for ONE page (the target page in the
 * scan — pages[0]). A page without a sentence corpus (unit-test callers that
 * only pass main words) has nothing to measure and fires nothing.
 *
 * @returns {{ extras: number, receipts: string[] }}
 */
function analyzeInPagePhrases(page = {}) {
  const { sentences = [], paragraphs = [], title = '' } = page;
  const phrases = findRepeatedPhrases({ title, sentences, paragraphs });
  const extras = phrases.reduce((s, p) => s + (p.count - 1), 0);
  const receipts = [];
  if (extras > 0) {
    for (const p of phrases) {
      const location = countLocations(p.phrase, paragraphs, title);
      const bits = [`repeated phrase in the page text: ${p.count}× "${p.phrase}"`];
      if (location.title) bits.push('also in the page title');
      if (location.paragraphCount > 0) {
        bits.push(`in ${location.paragraphCount} paragraph${location.paragraphCount === 1 ? '' : 's'}`);
      }
      receipts.push(bits.join(' — '));
    }
  }
  return { extras, receipts };
}

/**
 * @param {object} opts
 * @param {Array<{ url: string, main: { words: string[] },
 *                 sentences?: string[], paragraphs?: string[], title?: string }>} opts.pages
 *   every page fetched for the scan (target + up to 4 additional), with its
 *   main-content token array. Deterministic caller order. The TARGET page
 *   (pages[0]) may additionally carry its extracted sentence/paragraph/title
 *   context so the in-page repeated-phrase component can fire.
 * @param {null | { fired: boolean, skeletonScore: number, receipts: string[] }|null} [opts.skeleton]
 *   the round-2 skeleton detector result (from scan.js; null when the scan
 *   has < 2 pages). Only the score and the fired receipts are used here.
 * @returns {{ score: number|null, findings: string[],
 *             pairs?: Array<{pageA:string,pageB:string,similarity:number}>,
 *             pages?: string[], note?: string }}
 */
export function analyzeCrossPage({ pages = [], skeleton = null } = {}) {
  const target = pages.length > 0 ? analyzeInPagePhrases(pages[0]) : { extras: 0, receipts: [] };
  const skelScore = skeleton?.skeletonScore ?? 0;
  /** Round-2 fired receipts (exact strings, ROUND2-SPEC §5.1) — appended to
   *  findings ONLY when the detector fires (a below-bar near-miss is a real
   *  measurement but not a finding). */
  const skeletonFindings = skeleton?.fired === true ? [...skeleton.receipts] : [];

  if (pages.length < 2) {
    // Pairwise comparison needs >= 2 pages; the in-page component does not.
    // Null ONLY when there is genuinely nothing to measure (no phrase signal):
    // the scorer then keeps reproducing v1 scoring (its renormalization
    // branch). A single-page scan WITH repeated phrases gets a real score —
    // the owner-flagged scoring consequence (crossPage weight 0.30 applies).
    if (target.extras === 0) {
      return { score: null, findings: [], note: 'needs at least 2 pages to compare' };
    }
    return {
      score: Math.min(100, Math.round(target.extras * PHRASE_EXTRAS_SCALE * PHRASE_SUB_WEIGHT)),
      findings: [...target.receipts],
      pages: pages.map((p) => p.url),
      note: 'single-page scan: in-page repeated-phrase check only (no cross-page comparison possible)',
    };
  }

  const pairs = [];
  // All unordered pairs, i<j in the deterministic page order.
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      // DEFENSIVE GUARD (owner PROMPT 1, 2026-10-05): never compare a document
      // against itself. scan.js dedupes the scanned set by final fetched URL
      // (post-redirect) before calling this, so a converged duplicate can't
      // even arrive here — but if a same-URL pair ever slips through (e.g. a
      // future caller passes a page list with duplicate URL entries), skipping
      // it makes a 1.0 (self-)similarity literally impossible. The TechBullion
      // exploit was exactly this: two sitemap spellings 301-converged onto one
      // final URL, and the engine scored that document against itself → 100.
      if (pages[i].url === pages[j].url) continue;
      const wordsA = pages[i].main?.words ?? [];
      const wordsB = pages[j].main?.words ?? [];
      const sim = roundSimilarity(shingleJaccard(wordsA, wordsB));
      pairs.push({ pageA: pages[i].url, pageB: pages[j].url, similarity: sim });
    }
  }
  const flagged = pairs.filter((p) => p.similarity >= DUPLICATION_THRESHOLD);
  const findings = [];
  if (flagged.length > 0) {
    const maxSim = Math.max(...flagged.map((p) => p.similarity));
    findings.push(`same content on multiple pages: ${flagged.length} page pair${flagged.length === 1 ? '' : 's'}, most similar at ${(maxSim * 100).toFixed(1)}%`);
    for (const p of flagged) {
      findings.push(`near-identical page pair: ${p.pageA} ~ ${p.pageB} (${(p.similarity * 100).toFixed(1)}% similar)`);
    }
    // Component wording: if >= 3 pages form a fully-connected cluster, call it
    // "duplicated across N pages".
    const byUrl = new Map(pages.map((p) => [p.url, new Set()]));
    for (const p of flagged) {
      byUrl.get(p.pageA)?.add(p.pageB);
      byUrl.get(p.pageB)?.add(p.pageA);
    }
    const biggest = [...byUrl.entries()].reduce((n, [, s]) => Math.max(n, s.size + 1), 1);
    if (biggest >= 3) {
      findings.push(`the same content appears on ${biggest} pages (they're essentially the same page)`);
    }
    const score = Math.round(((maxSim - DUPLICATION_THRESHOLD) / (1 - DUPLICATION_THRESHOLD)) * 100);
    if (target.extras === 0) {
      return { score: applySkeletonTerm(score, skelScore), findings: [...findings, ...skeletonFindings], pairs, pages: pages.map((p) => p.url) };
    }
    const phraseContribution = clamp(target.extras * PHRASE_EXTRAS_SCALE, 0, 100) * PHRASE_SUB_WEIGHT;
    return {
      score: applySkeletonTerm(score + phraseContribution, skelScore),
      findings: [...target.receipts, ...findings, ...skeletonFindings],
      pairs,
      pages: pages.map((p) => p.url),
    };
  }
  if (target.extras === 0) {
    return {
      score: applySkeletonTerm(0, skelScore),
      findings: [`no two pages are more than ${(DUPLICATION_THRESHOLD * 100).toFixed(0)}% the same (${pages.length} pages compared)`, ...skeletonFindings],
      pairs,
      pages: pages.map((p) => p.url),
    };
  }
  const phraseContribution = clamp(target.extras * PHRASE_EXTRAS_SCALE, 0, 100) * PHRASE_SUB_WEIGHT;
  return {
    score: applySkeletonTerm(phraseContribution, skelScore),
    findings: [...target.receipts, `no two pages are more than ${(DUPLICATION_THRESHOLD * 100).toFixed(0)}% the same (${pages.length} pages compared)`, ...skeletonFindings],
    pairs,
    pages: pages.map((p) => p.url),
  };
}