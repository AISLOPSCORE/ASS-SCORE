import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy Slop rule — the "hedge-y/vague writing vs concrete specifics" dimension.
 *
 * Two orthogonal deterministic signals, both pure functions of the extracted
 * page text (no randomness, same input -> same output, always):
 *
 *   1. HEDGE PHRASES (analyzeHedges) — vague marketing constructions that
 *      promise value without saying anything ("we aim to", "world-class",
 *      "seamless experience", "in today's fast-paced world", ...). The phrase
 *      list lives in copySlop.json (edit the file, no code change) and is
 *      matched lowercased/trimmed, so "We Aim To" and "we aim to" both hit.
 *      Each hit is counted and the EXACT sentence containing the phrase is
 *      quoted as evidence (capped) so reports can point at the real trigger.
 *
 *      These findings attach to the BOILERPLATE category (they ARE generic
 *      marketing language — the same family as the boilerplate rule's
 *      "generic commitment claim" / "marketing cliché" signals). The new
 *      phrase list is deliberately disjoint from the boilerplate rule's own
 *      regexes so the same sentence is never double-counted inside the
 *      boilerplate category (e.g. "we are committed to"/"we are dedicated to"
 *      already live in src/rules/boilerplate.js and are NOT repeated here).
 *
 *   2. CONCRETE SPECIFICS (analyzeSpecifics) — evidence of real substance in
 *      the copy: digits, prices/currency, percentages, dates/years, named
 *      brands, and capitalized multi-word proper nouns. The signal is the
 *      ABSENCE: when a page falls below ~1 concrete specific per
 *      `specificsPerWords` (75) words it is vague-by-default and gets a
 *      findings entry; when specifics are plentiful the score contribution is
 *      exactly 0 (legitimately specific pages are never penalized).
 *
 *      These findings attach to the infoDensity category (content substance
 *      is an information-density concern). Detection is conservative: digits,
 *      dates and currency are the strongest signals; names are a small
 *      editable brand list plus capitalized multi-word proper nouns that do
 *      not start a sentence (sentence-initial capitals are usually just
 *      grammar, so they are skipped to avoid inflating heading text).
 *
 * Evidence wording rule: pattern/absence evidence only ("hedge phrase",
 * "no dates, numbers, prices, or named references") — never an assertion
 * about how the copy was produced.
 */

const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'copySlop.json');
const CONFIG = Object.freeze(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')));

/** Hedge phrases (lowercase, trimmed). Editable in copySlop.json. */
export const HEDGE_PHRASES = Object.freeze([...(CONFIG.hedgePhrases ?? [])]);

/** Known brand names (lowercase). Editable in copySlop.json. */
export const KNOWN_NAMES = Object.freeze([...(CONFIG.knownNames ?? [])]);

/** Words of copy per concrete specific needed to NOT flag the gap. */
export const SPECIFICS_PER_WORDS = Number(CONFIG.specificsPerWords) || 75;

/** Max evidence quotes per signal (aggregate counts always exact). */
export const MAX_EVIDENCE_QUOTES = Number(CONFIG.maxEvidenceQuotes) || 8;

const HEDGE_SENTINEL = Object.freeze({
  total: 0,
  hits: [],
  quotes: [],
});

/**
 * Lowercased occurrence counting (indexOf loop, no regex) — deterministic.
 * Returns { total, hits: [{ phrase, count }] sorted by count desc (ties keep
 * config order), quotes: [{ phrase, sentence }] capped at MAX_EVIDENCE_QUOTES.
 *
 * @param {string} text analysis-corpus text (DETECTION — counts are computed
 *   here, never from `readable`)
 * @param {string[]} sentences analysis-corpus sentences
 * @param {{ text?: string, sentences?: string[] }|null} [readable] readable
 *   variant (extractReadableText, boundary-spaced) consumed ONLY for the
 *   quoted evidence sentence — absent/empty keeps the current behavior.
 */
export function analyzeHedges(text = '', sentences = [], readable = null) {
  if (!text) return { total: 0, hits: [], quotes: [] };
  const lower = text.toLowerCase();

  const hits = [];
  let total = 0;
  for (const phrase of HEDGE_PHRASES) {
    let count = 0;
    let idx = lower.indexOf(phrase);
    let firstIdx = idx;
    while (idx !== -1 && count < 50) {
      count += 1;
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
    if (count > 0) hits.push({ phrase, count, firstIdx });
    total += count;
  }

  const sorted = hits.sort((a, b) => b.count - a.count || HEDGE_PHRASES.indexOf(a.phrase) - HEDGE_PHRASES.indexOf(b.phrase));

  // Quote the exact sentence for each hit phrase (deterministic: first hit of
  // each phrase, in the sorted order, capped overall). With a readable corpus
  // present, the quote comes from THERE (boundary-spaced — reads like the
  // page) while the count above still comes from the analysis corpus.
  const quoteSentences = readable?.sentences?.length ? readable.sentences : sentences;
  const quoteText = readable?.text ? readable.text : text;
  const quotes = [];
  for (const h of sorted) {
    if (quotes.length >= MAX_EVIDENCE_QUOTES) break;
    const sentence = sentenceContaining(h.phrase, h.firstIdx ?? -1, lower, quoteSentences, quoteText);
    if (sentence) quotes.push({ phrase: h.phrase, sentence });
  }

  return { total, hits: sorted.map(({ phrase, count }) => ({ phrase, count })), quotes };
}

/** The original-case sentence containing the phrase (fallback: ±80 chars). */
function sentenceContaining(phrase, firstIdx, lowerText, sentences, windowText = null) {
  if (Array.isArray(sentences)) {
    for (const s of sentences) {
      if (s.toLowerCase().includes(phrase)) return s;
    }
  }
  // Fallback for sentences that the splitter never produced: walk the raw
  // text and cut a window around the first occurrence. `windowText` is the
  // original-case text (readable when present — the analysis corpus is
  // lowercase only in `lowerText`).
  const raw = windowText ?? lowerText;
  const idx = raw.toLowerCase().indexOf(phrase);
  if (idx === -1) return phrase;
  const from = Math.max(0, idx - 60);
  const to = Math.min(raw.length, idx + phrase.length + 60);
  let snippet = raw.slice(from, to).replace(/\s+/g, ' ').trim();
  if (snippet.length > 140) snippet = `${snippet.slice(0, 140)}…`;
  return snippet;
}

/** @returns { typeof HEDGE_SENTINEL } */
export function hedgeSummary(text = '', sentences = []) {
  const r = analyzeHedges(text, sentences);
  return r;
}

// ---------------------------------------------------------------------------
// Concrete specifics
// ---------------------------------------------------------------------------

const MONTHS =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

/** Signal regexes, strongest first (used for span prioritization on overlap). */
const SPECIFIC_SIGNALS = [
  { name: 'currency', re: new RegExp(`\\$\\s?\\d[\\d,]*(?:\\.\\d+)?|€\\s?\\d[\\d,]*(?:\\.\\d+)?|£\\s?\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:USD|EUR|GBP)`, 'g') },
  { name: 'percent', re: /\d[\d,]*(?:\.\d+)?\s?%/g },
  { name: 'monthDate', re: new RegExp(`\\b(?:${MONTHS})\\s+\\d{4}\\b|\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\s+\\d{4}\\b`, 'g') },
  { name: 'year', re: /\b(?:19|20)\d{2}\b/g },
  { name: 'name', re: new RegExp(`\\b(?:${KNOWN_NAMES.join('|')})\\b`, 'gi') },
  { name: 'properNoun', re: /(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g },
  { name: 'number', re: /\b\d[\d,]*(?:\.\d+)?\b/g },
];

const SENTENCE_START = /(?:^|[.!?]\s+)$/;

/**
 * Count concrete specifics in the page text. Overlapping spans (e.g. "2022"
 * is both a year and a digit; "$99" is both currency and a digit) are merged
 * and counted ONCE per span, keeping the most specific kind. Deterministic.
 *
 * @param {string} text original-case page text
 * @returns {{ count: number, needed: number, gap: boolean, examples: string[],
 *            kinds: Record<string, number> }}
 */
export function analyzeSpecifics(text = '', wordCount = 0) {
  const empty = { count: 0, needed: 1, gap: false, examples: [], kinds: {} };
  if (!text) return empty;

  // Collect spans [start, end, kind, matchedText] from every signal.
  const spans = [];
  for (const sig of SPECIFIC_SIGNALS) {
    const re = new RegExp(sig.re.source, sig.re.flags.includes('g') ? sig.re.flags : sig.re.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      if (sig.name === 'properNoun') {
        // Skip sentence-initial capitals (grammar, not a named reference).
        const before = text.slice(0, m.index);
        if (SENTENCE_START.test(before.trimEnd())) {
          continue;
        }
      }
      spans.push({ start: m.index, end: m.index + m[0].length, kind: sig.name, text: m[0] });
    }
  }

  // Merge overlapping spans (sort by start; a later span that started inside
  // the current one is absorbed) keeping the more specific kind.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (PRIORITY[s.kind] < PRIORITY[last.kind]) {
        last.kind = s.kind;
        last.text = s.text;
        last.end = Math.max(last.end, s.end);
      }
      continue;
    }
    merged.push({ ...s });
  }

  const count = merged.length;
  const words = Math.max(1, Number(wordCount) || 0);
  const needed = Math.max(1, Math.ceil(words / SPECIFICS_PER_WORDS));
  const gap = count < needed;
  const examples = merged.slice(0, MAX_EVIDENCE_QUOTES).map((s) => s.text.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const kinds = {};
  for (const s of merged) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;

  return { count, needed, gap, examples, kinds };
}

/** Lower number = more specific; used to pick the winning kind on overlap. */
const PRIORITY = Object.freeze({
  currency: 0,
  percent: 1,
  monthDate: 2,
  year: 3,
  name: 4,
  properNoun: 5,
  number: 6,
});

/** Human summary finding for the infoDensity category (empty when no gap). */
export function specificsFinding(text = '', wordCount = 0) {
  const s = analyzeSpecifics(text, wordCount);
  if (!s.gap) return null;
  if (s.count === 0) {
    return `specific details: 0 found in ${wordCount} words — no dates, numbers, prices, percentages, or named references (need at least ${s.needed} per ${SPECIFICS_PER_WORDS} words)`;
  }
  const ex = s.examples.length > 0 ? ` — e.g. ${s.examples.join(', ')}` : '';
  return `specific details: only ${s.count} in ${wordCount} words (need at least ${s.needed} per ${SPECIFICS_PER_WORDS} words)${ex}`;
}

/** 0 when specifics are plentiful; 0–100 gap severity (100 = zero specifics). */
export function specificsGapPenalty(text = '', wordCount = 0) {
  const s = analyzeSpecifics(text, wordCount);
  if (!s.gap) return 0;
  const ratio = (s.needed - s.count) / s.needed;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}