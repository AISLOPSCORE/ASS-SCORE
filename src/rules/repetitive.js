/**
 * Rule D — Repetitive structure.
 * Detects: repeated sentence openings (same first 3 words), near-identical
 * sentences (normalized equality — same words, punctuation and case stripped),
 * repeated paragraphs, and (pass 2, 2026-10-01) in-page repeated phrases —
 * 4+ word phrases / sentence templates that recur 3+ times on the same page
 * (e.g. a value-prop line hammered across hero + sections, or templated
 * testimonials that share a skeleton with different specifics plugged in).
 * Each signal maps to a 0–100 subscore. The final score is a weighted blend
 * (openings 40%, sentence-level dupes 40%, paragraph dupes 20%) plus an
 * ADDITIVE in-page-phrase term capped at +20% (total capped at 100) — the
 * phrase term is additive so pages where the new signal is absent score
 * exactly as before.
 */

import { STOPWORDS } from '../text.js';

const OPENING_WORDS = 3;

const PHRASE_MIN_WORDS = 4;   // the 4-word minimum (deliverable spec)
const PHRASE_MAX_WORDS = 12;  // longer runs are sentence-level dupes anyway
const PHRASE_MIN_COUNT = 3;   // "appearing 3+ times on one page"
const PHRASE_MAX_FINDINGS = 3; // cap reported phrases per page (receipt list stays tight)
const CONTENT_WORD_MIN = 2;   // drop pure function-word runs ("in to the of")
const PHRASE_SUB_WEIGHT = 0.2; // additive cap on the final score (see header)
const PHRASE_EXTRAS_SCALE = 12; // one 3× phrase => 24 subscore; caps at 100

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const normalizeSentence = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Normalization for the PHRASE detector ONLY (pass 2, 2026-10-01): non-letter/
 * non-number characters become SPACES (not nothing), so hyphenated compounds
 * like "platform-native" and "platform native" unify into the same phrase —
 * the value-prop line "a month of platform-native content" is the SAME claim
 * repeated as "a month of platform native posts". The three legacy signals
 * keep the original punctuation-stripping normalizeSentence above so their
 * scores stay byte-identical.
 */
const normalizePhrase = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function firstWords(s, n) {
  const out = [];
  for (const m of String(s).matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?|[\p{L}\p{N}]+/gu)) {
    out.push(m[0].toLowerCase());
    if (out.length >= n) break;
  }
  return out.join(' ');
}

/** Count occurrences of each normalized value, return [{value, count}] with count > 1 first. */
function findDuplicates(items) {
  const counts = new Map();
  for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .filter((d) => d.count > 1)
    .sort((a, b) => b.count - a.count);
}

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
 * @param {{ text?: string, sentences?: string[], paragraphs?: string[], title?: string, stopwords?: Set<string> }} ctx
 */
export function analyze({ text = '', sentences = [], paragraphs = [], title = '', stopwords = STOPWORDS } = {}) {
  // Degenerate pages (no text, or text that carries no sentence split) keep
  // the original contract byte-identical: { score: 0, findings: [] }. The
  // phrase signal cannot fire without >= 2 distinct corpus entries of >= 4
  // words, so a missing sentence list can never contribute anyway.
  if (!text || sentences.length === 0) return { score: 0, findings: [] };

  const sentenceCount = sentences.length;

  // 1. Repeated sentence openings.
  let openingSub = 0;
  if (sentenceCount >= 6) {
    const openings = sentences.map((s) => firstWords(s, OPENING_WORDS)).filter(Boolean);
    const dupOpenings = findDuplicates(openings);
    const extras = dupOpenings.reduce((s, d) => s + (d.count - 1), 0);
    const ratio = extras / sentenceCount;
    openingSub = clamp(ratio * 220, 0, 100); // ratio ~0.45 => 100
  }

  // 2. Near-identical sentences (normalized equality).
  const normalized = sentences.map(normalizeSentence).filter((s) => s.length > 0);
  const dupSentences = findDuplicates(normalized);
  const sentExtras = dupSentences.reduce((s, d) => s + (d.count - 1), 0);
  const sentSub = clamp((sentExtras / Math.max(1, normalized.length)) * 300, 0, 100);

  // 3. Repeated paragraphs.
  let paraSub = 0;
  if (paragraphs.length >= 3) {
    const dupParas = findDuplicates(paragraphs.map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));
    const paraExtras = dupParas.reduce((s, d) => s + (d.count - 1), 0);
    paraSub = clamp((paraExtras / Math.max(1, paragraphs.length)) * 250, 0, 100);
  }

  // 4. In-page repeated phrases / sentence templates (pass 2, 2026-10-01).
  // Additive to the three existing signals: pages without the new signal
  // score EXACTLY as before (no renormalization of the existing blend).
  const repeatedPhrases = findRepeatedPhrases({ title, sentences, paragraphs, stopwords });
  const phraseExtras = repeatedPhrases.reduce((s, p) => s + (p.count - 1), 0);
  const phraseSub = clamp(phraseExtras * PHRASE_EXTRAS_SCALE, 0, 100);

  const score = Math.min(100, Math.round(openingSub * 0.4 + sentSub * 0.4 + paraSub * 0.2 + phraseSub * PHRASE_SUB_WEIGHT));

  const findings = [];
  if (openingSub > 0) {
    const dupOpenings = findDuplicates(sentences.map((s) => firstWords(s, OPENING_WORDS)).filter(Boolean));
    findings.push(`repeated sentence openings: ${dupOpenings.slice(0, 3).map((d) => `${d.count}× "${d.value}…"`).join(', ')}`);
  }
  if (sentSub > 0) {
    findings.push(`near-identical sentences: ${dupSentences.slice(0, 3).map((d) => `${d.count}× "${d.value.slice(0, 60)}${d.value.length > 60 ? '…' : ''}"`).join(', ')}`);
  }
  if (paraSub > 0) {
    const dupParas = findDuplicates(paragraphs.map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));
    findings.push(`repeated paragraphs: ${dupParas.slice(0, 3).map((d) => `${d.count}× "${d.value.slice(0, 60)}${d.value.length > 60 ? '…' : ''}"`).join(', ')}`);
  }
  if (phraseSub > 0) {
    for (const p of repeatedPhrases) {
      const location = countLocations(p.phrase, paragraphs, title);
      const bits = [`repeated phrase in the page text: ${p.count}× "${p.phrase}"`];
      if (location.title) bits.push('also in the page title');
      if (location.paragraphCount > 0) {
        bits.push(`in ${location.paragraphCount} paragraph${location.paragraphCount === 1 ? '' : 's'}`);
      }
      findings.push(bits.join(' — '));
    }
  }
  if (findings.length === 0) {
    findings.push(`no notable repetitive structure (${sentenceCount} sentences, ${paragraphs.length} paragraphs)`);
  }

  return { score, findings };
}