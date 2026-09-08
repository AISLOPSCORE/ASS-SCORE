/**
 * Cross-page similarity — pure, deterministic, no external APIs.
 *
 * Method (documented): word 4-gram shingling with Jaccard similarity.
 *   A word shingle is a sliding window of 4 consecutive lowercase words
 *   (window covers punctuation-stripped tokens; word order matters, so two
 *   pages that reuse the same phrases in the same order score high).
 *   Jaccard(A, B) = |A ∩ B| / |A ∪ B| — identical pages -> 1.0, disjoint -> 0.
 *
 * Deterministic: pure function of the token arrays; no hashing collisions,
 * no randomness, no ordering dependence (the Jaccard formula is symmetric).
 */

export const SHINGLE_SIZE = 4;

/**
 * Build the word-shingle set for a token array.
 * @param {string[]} words lowercase token array (tokenize() output)
 * @param {number} [n] shingle size in words
 * @returns {Set<string>} set of "w1 w2 w3 w4" shingles
 */
export function wordShingles(words, n = SHINGLE_SIZE) {
  const out = new Set();
  if (!Array.isArray(words) || words.length < n) return out;
  for (let i = 0; i + n <= words.length; i += 1) {
    let shingle = '';
    for (let j = 0; j < n; j += 1) {
      shingle += (j === 0 ? '' : ' ') + words[i + j];
    }
    out.add(shingle);
  }
  return out;
}

/**
 * Jaccard similarity between two token arrays over word n-grams.
 * @returns {number} 0..1 (0 for any empty input)
 */
export function shingleJaccard(wordsA, wordsB, n = SHINGLE_SIZE) {
  const a = wordShingles(wordsA, n);
  const b = wordShingles(wordsB, n);
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of smaller) if (larger.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 1; // both empty; unreachable given the guard above
  return inter / union;
}

/** Round a similarity to a stable 3-decimal value (kills float noise). */
export const roundSimilarity = (v) => Math.round(v * 1000) / 1000;