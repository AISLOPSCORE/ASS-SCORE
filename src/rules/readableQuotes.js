/**
 * Readable-corpus quote lookups (owner-approved Option B, 2026-10-07).
 *
 * These helpers map DETECTION-side values — normalized strings from the
 * ANALYSIS corpus (extractText/extractMainText, byte-identical to main) —
 * back to their READABLE counterparts (extractReadableText, boundary-spaced)
 * so findings quote what a human sees on the page, never normalized garbage.
 *
 * WHY whitespace-stripped matching: the analysis corpus concatenates adjacent
 * elements with no separator ("Advertise now" + "$29.99 · 30" -> "Advertise
 * now$29.99 · 30"), and punctuation removal in the legacy normalizers MELDS
 * words across that boundary ("now$29.99" -> "now2999"). Stripping ALL
 * whitespace from both sides makes the comparison invariant to WHERE the
 * boundary spaces landed, which is the only difference between the two
 * corpora for the same element text.
 *
 * SCORING GUARANTEE: every function here is read ONLY when building quote
 * strings inside findings. Scores are computed exclusively from the analysis
 * corpus (category .score fields; C1/C2 read infoDensity/fingerprints/
 * crossPage scores) — findings strings never feed scoring in any rule
 * (verified rule-by-rule, investigation.md §5), so these lookups can never
 * move a pinned score.
 */

import { short } from '../truncate.js';

/** Whitespace-stripped form — invariant to element-boundary spacing. */
export const stripWS = (s) => String(s ?? '').replace(/\s+/g, '');

/** Legacy repetitive-rule normalization: lowercase, punctuation REMOVED. */
export const normSentence = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Paragraph normalization: lowercase, whitespace collapsed (punctuation kept). */
export const normParagraph = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Truncate a quote window at `max` chars (whitespace-collapsed), appending
 * '…'. Word-boundary cut via the shared truncation helper (report-trust fix
 * 2026-10-07: the old `slice(0, max).trimEnd()` cut mid-word — the live paid
 * report showed "…LinkedIn and ema…" and "…$29.99 · 3…" where a token ran
 * past the limit; everything here is evidence quoted back to a customer, so
 * the cut now lands at the last space at/before `max`, trailing punctuation
 * is stripped, and only a boundaryless head is hard-sliced).
 */
export function quoteWindow(s, max = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return short(t, max);
}

/**
 * Find the readable sentence corresponding to a fired NEAR-IDENTICAL sentence
 * value (normalized with normSentence). Exact whitespace-stripped equality
 * first (covers both clean pages and element-boundary garble); fallback: the
 * LONGEST readable sentence whose stripped form is contained inside the fired
 * value (covers the case where boundary spacing split one analysis sentence
 * into multiple readable sentences — quote the biggest surviving piece).
 * @returns {string|null} the readable sentence, or null (caller falls back)
 */
export function readableSentenceFor(normValue, readableSentences = []) {
  if (!Array.isArray(readableSentences) || !normValue) return null;
  const v = stripWS(normValue);
  if (!v) return null;
  let best = null;
  let bestLen = -1;
  for (const rs of readableSentences) {
    const sv = stripWS(normSentence(rs));
    if (sv === v) return rs;
    if (v.includes(sv) && sv.length >= 3 && sv.length > bestLen) {
      best = rs;
      bestLen = sv.length;
    }
  }
  return best;
}

/**
 * Find the readable sentence whose OPENING matches a fired repeated-sentence-
 * opening value (first-3-token lowercase). Matched on the stripped normalized
 * form's prefix, so merged boundaries ("Sign up" + "Free" -> "upFree") still
 * find their readable sentence ("Sign up Free …").
 * @returns {string|null} the readable sentence, or null
 */
export function readableOpeningSentenceFor(openingValue, readableSentences = []) {
  if (!Array.isArray(readableSentences) || !openingValue) return null;
  const v = stripWS(openingValue);
  if (!v) return null;
  for (const rs of readableSentences) {
    if (stripWS(normSentence(rs)).startsWith(v)) return rs;
  }
  return null;
}

/**
 * Find the readable paragraph corresponding to a fired repeated-paragraph /
 * repeated-block value (normalized with normParagraph). Whitespace-stripped
 * equality — invariant to boundary spacing.
 * @returns {string|null} the readable paragraph, or null
 */
export function readableParagraphFor(normParaValue, readableParagraphs = []) {
  if (!Array.isArray(readableParagraphs) || !normParaValue) return null;
  const v = stripWS(normParaValue);
  if (!v) return null;
  for (const rp of readableParagraphs) {
    if (stripWS(normParagraph(rp)) === v) return rp;
  }
  return null;
}

/**
 * The readable equivalent of a "first N words" opening quote: the first 3
 * whitespace-separated words of the readable sentence, original case and
 * symbols preserved, trailing period dropped, ellipsis appended.
 */
export function readableOpeningQuote(sentence) {
  const words = quoteWindow(sentence)
    .split(' ')
    .slice(0, 3)
    .join(' ')
    .replace(/\.$/, '');
  return `${words}…`;
}