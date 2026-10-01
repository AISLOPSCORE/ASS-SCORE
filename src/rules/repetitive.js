/**
 * Rule D — Repetitive structure.
 * Detects: repeated sentence openings (same first 3 words), near-identical
 * sentences (normalized equality — same words, punctuation and case stripped),
 * and repeated paragraphs. Each signal maps to a 0–100 subscore; final score is
 * a weighted blend (openings 40%, sentence-level dupes 40%, paragraph dupes 20%).
 */

const OPENING_WORDS = 3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const normalizeSentence = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

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

/**
 * @param {{ text?: string, sentences?: string[], paragraphs?: string[] }} ctx
 */
export function analyze({ text = '', sentences = [], paragraphs = [] } = {}) {
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

  const score = Math.round(openingSub * 0.4 + sentSub * 0.4 + paraSub * 0.2);

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
  if (findings.length === 0) {
    findings.push(`no notable repetitive structure (${sentenceCount} sentences, ${paragraphs.length} paragraphs)`);
  }

  return { score, findings };
}