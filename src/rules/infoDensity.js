/**
 * Rule C — Low information density.
 * Four deterministic metrics, each mapped to a 0–100 subscore, then weighted:
 *
 *   metric                     weight  direction (higher score = more slop)
 *   moving-average TTR (50)    0.30    low unique-word ratio = repetitive vocabulary
 *   stopword ratio             0.20    high function-word share = low info per word
 *   mean sentence length       0.20    very long run-ons or very short fragments
 *   short-paragraph prevalence 0.30    one/two-line paragraphs = thin content
 *
 * Pure function: no randomness, no timestamps.
 *
 * The Copy Slop concrete-specifics dimension (src/rules/copySlop.js) attaches
 * here: substance is an information-density concern. When the visible copy is
 * vague by default (fewer than ~1 concrete specific per 75 words — no dates,
 * numbers, prices, percentages, or named references) a gap penalty (0–100) is
 * added to the score and a findings line reports the exact count with quoted
 * examples. When specifics are plentiful the penalty is exactly 0 and no
 * finding is emitted — legitimately specific pages are never penalized.
 */

import { specificsFinding, specificsGapPenalty } from './copySlop.js';

const MATTR_WINDOW = 50;
const MAX_WINDOWS_SAMPLE = 400; // cap on windows evaluated (fixed stride sampling keeps it deterministic)

/**
 * Moving-average type-token ratio — length-normalized measure of vocabulary
 * diversity (window of W consecutive words, averaged over all windows).
 */
export function mattr(words, windowSize = MATTR_WINDOW) {
  const n = words.length;
  if (n === 0) return 0;
  if (n <= windowSize) return new Set(words).size / n;
  const windows = n - windowSize + 1;
  const stride = Math.max(1, Math.ceil(windows / MAX_WINDOWS_SAMPLE));
  let sum = 0;
  let count = 0;
  for (let i = 0; i + windowSize <= n; i += stride) {
    sum += new Set(words.slice(i, i + windowSize)).size / windowSize;
    count += 1;
  }
  return sum / count;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {{ text?: string, words?: string[], sentences?: string[], paragraphs?: string[],
 *           stopwords?: Set<string> }} ctx
 */
export function analyze({ text = '', words = [], sentences = [], paragraphs = [], stopwords } = {}) {
  if (!text || words.length === 0) return { score: 0, findings: [] };

  const wordCount = words.length;

  // 1. Vocabulary diversity (MATTR). Normal English prose sits around 0.75–0.85;
  //    values below that mean the text keeps reusing the same words.
  const ttr = mattr(words);
  const ttrSub = clamp(((0.85 - ttr) / 0.35) * 100, 0, 100);

  // 2. Stopword ratio. English prose is typically ~40–55% function words;
  //    higher means more empty filler and less information per word.
  let stopwordCount = 0;
  if (stopwords && stopwords.size > 0) {
    for (const w of words) if (stopwords.has(w)) stopwordCount += 1;
  } else {
    stopwordCount = 0;
  }
  const stopwordRatio = wordCount > 0 ? stopwordCount / wordCount : 0;
  const stopSub = clamp(((stopwordRatio - 0.4) / 0.25) * 100, 0, 100);

  // 3. Mean sentence length. Sweet spot 12–26 words/sentence; deviations in
  //    either direction (run-ons or staccato fragments) reduce information density.
  let sentSub = 20; // neutral when we have too few sentences to judge
  if (sentences.length >= 5) {
    const meanLen = wordCount / sentences.length;
    if (meanLen >= 12 && meanLen <= 26) sentSub = 0;
    else if (meanLen < 12) sentSub = clamp(((12 - meanLen) / 8) * 100, 0, 100);
    else sentSub = clamp(((meanLen - 26) / 14) * 100, 0, 100);
  }

  // 4. Short-paragraph prevalence. Paragraphs under 25 words are thin content.
  let paraSub = 20; // neutral when no paragraph structure is present
  if (paragraphs.length >= 3) {
    const shortCount = paragraphs.filter((p) => tokenCount(p) < 25).length;
    const frac = shortCount / paragraphs.length;
    paraSub = clamp(frac * 120, 0, 100);
  }

  let score = Math.round(ttrSub * 0.3 + stopSub * 0.2 + sentSub * 0.2 + paraSub * 0.3);

  // Copy Slop concrete specifics: gap penalty is 0 when specifics are
  // plentiful (≥1 per ~75 words) and rises toward 100 as the copy becomes
  // vague by default (0 specifics = fullest penalty). Findings only on a gap.
  const specPenalty = specificsGapPenalty(text, wordCount);
  if (specPenalty > 0) score = clamp(score + specPenalty, 0, 100);
  const specFinding = specificsFinding(text, wordCount);

  const findings = [
    `vocabulary diversity (MATTR-${MATTR_WINDOW}): ${ttr.toFixed(3)} (lower = more repetitive vocabulary)`,
    `stopword ratio: ${(stopwordRatio * 100).toFixed(1)}%`,
    `mean sentence length: ${sentences.length > 0 ? (wordCount / sentences.length).toFixed(1) : 'n/a'} words (${sentences.length} sentences)`,
    `short paragraphs (<25 words): ${paragraphs.length > 0 ? Math.round((paragraphs.filter((p) => tokenCount(p) < 25).length / paragraphs.length) * 100) : 'n/a'}% (${paragraphs.length} paragraphs)`,
    ...(specFinding ? [specFinding] : []),
  ];

  return { score, findings };
}

function tokenCount(str) {
  let count = 0;
  for (const _ of String(str).matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?|[\p{L}\p{N}]+/gu)) count += 1;
  return count;
}