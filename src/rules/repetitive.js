/**
 * Rule D — Repetitive structure.
 * Detects: repeated sentence openings (same first 3 words), near-identical
 * sentences (normalized equality — same words, punctuation and case stripped),
 * and repeated paragraphs. Each signal maps to a 0–100 subscore; final score is
 * a weighted blend (openings 40%, sentence-level dupes 40%, paragraph dupes 20%).
 *
 * Quote strings (findings) come from the READABLE corpus when the caller passes
 * one (owner-approved Option B, 2026-10-07): detection and score math always
 * read the provided analysis-corpus args; the readable variant only supplies
 * evidence quotes that read like the page (boundary-spaced, original case).
 */

import { readableSentenceFor, readableOpeningSentenceFor, readableParagraphFor, readableOpeningQuote, quoteWindow } from './readableQuotes.js';
import { short } from '../truncate.js';

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
 * @param {{ text?: string, sentences?: string[], paragraphs?: string[] }|null} [readable]
 *   readable corpus — quoted evidence only, never scores.
 */
export function analyze({ text = '', sentences = [], paragraphs = [] } = {}, readable = null) {
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

  // --- readable quote lookups (boundary-spaced evidence only) -----------------
  const readableSentences = readable?.sentences?.length ? readable.sentences : null;
  const readableParas = readable?.paragraphs?.length ? readable.paragraphs : null;
  // Opening quote = first 3 words of the readable sentence, original case.
  const openingQuote = (d) => {
    const rs = readableOpeningSentenceFor(d.value, readableSentences ?? []);
    return rs ? readableOpeningQuote(rs) : `${d.value}…`;
  };
  // Near-identical quote = the readable sentence, word-boundary truncated at
  // 60 (report-trust fix 2026-10-07: the old bare slice cut mid-word — the
  // live paid report showed "…LinkedIn and ema…" for "…email").
  const sentenceQuote = (d) => {
    const rq = readableSentenceFor(d.value, readableSentences ?? []);
    const base = rq ?? d.value;
    return short(base, 60);
  };
  // Paragraph quote = the readable paragraph (truncated at 60 as today).
  const paragraphQuote = (d) => {
    const rq = readableParagraphFor(d.value, readableParas ?? []);
    const base = rq ?? d.value;
    return `${quoteWindow(base, 60)}`;
  };

  const findings = [];
  if (openingSub > 0) {
    const dupOpenings = findDuplicates(sentences.map((s) => firstWords(s, OPENING_WORDS)).filter(Boolean));
    findings.push(`repeated sentence openings: ${dupOpenings.slice(0, 3).map((d) => `${d.count}× "${openingQuote(d)}"`).join(', ')}`);
  }
  if (sentSub > 0) {
    findings.push(`near-identical sentences: ${dupSentences.slice(0, 3).map((d) => `${d.count}× "${sentenceQuote(d)}"`).join(', ')}`);
  }
  if (paraSub > 0) {
    const dupParas = findDuplicates(paragraphs.map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));
    findings.push(`repeated paragraphs: ${dupParas.slice(0, 3).map((d) => `${d.count}× "${paragraphQuote(d)}"`).join(', ')}`);
  }
  if (findings.length === 0) {
    findings.push(`no notable repetitive structure (${sentenceCount} sentences, ${paragraphs.length} paragraphs)`);
  }

  return { score, findings };
}