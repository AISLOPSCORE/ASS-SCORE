/**
 * Rule A — Filler phrasing.
 * Counts known slop/AI-buzz phrases (case-insensitive, substring match) and maps
 * the hit density (hits per ~300 words, so short pages are comparable to long ones)
 * to a 0–100 score. Pure function of the extracted text: no randomness, no time.
 */

const PHRASES = [
  "in today's fast-paced world", "in today's fast paced world", "in today's digital age",
  'game-changer', 'game changer', 'delve into', 'unlock the', 'revolutionize', 'revolutionise',
  'cutting-edge', 'cutting edge', 'seamless', 'seamlessly', 'elevate', 'elevating',
  'furthermore', 'moreover', "it's no secret", 'ever-evolving', 'ever evolving',
  'landscape', 'robust', 'in conclusion', 'navigate the', 'world-class', 'state-of-the-art',
  'best-in-class', 'at the end of the day', 'think outside the box', 'synergy', 'leverage',
  'leveraging', 'streamline', 'streamlining', 'next-level', 'next level', 'harness the power',
  'unleash', 'empower', 'empowering', 'transformative', 'paradigm shift', 'mission-critical',
  'stay ahead of the curve', 'hit the ground running', 'fast-paced', 'digital landscape',
  'competitive landscape', 'business landscape', 'tech landscape', 'when it comes to',
  'in the realm of', 'it goes without saying', 'a treasure trove of', 'unlock the potential',
];

const NORMALIZATION_WORDS = 300; // hits are normalized to this many words
const MAX_FINDINGS = 8;

/** @param {{ text?: string, words?: string[] }} ctx */
export function analyze({ text = '', words = [] } = {}) {
  if (!text || words.length === 0) return { score: 0, findings: [] };

  const lower = text.toLowerCase();
  const hits = [];
  for (const phrase of PHRASES) {
    let count = 0;
    let idx = lower.indexOf(phrase);
    while (idx !== -1 && count < 50) {
      count += 1;
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
    if (count > 0) hits.push({ phrase, count });
  }

  const totalHits = hits.reduce((sum, h) => sum + h.count, 0);
  const wordCount = Math.max(words.length, 1);
  const density = totalHits * (NORMALIZATION_WORDS / wordCount);
  // 0 hits -> 0; ~12 normalized hits per 300 words -> 100 (capped).
  const score = Math.max(0, Math.min(100, Math.round(Math.min(density, 12) * (100 / 12))));

  const findings = [
    `${totalHits} filler phrase occurrence${totalHits === 1 ? '' : 's'} in ${wordCount} words (${density.toFixed(1)} per ${NORMALIZATION_WORDS} words)`,
    ...hits.sort((a, b) => b.count - a.count)
      .slice(0, MAX_FINDINGS)
      .map((h) => `${h.count}× "${h.phrase}"`),
  ];

  return { score, findings };
}