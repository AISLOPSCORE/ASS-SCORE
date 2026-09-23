/**
 * Rule B — Boilerplate.
 * Detects generic/template content: cookie/consent banners, legal boilerplate,
 * newsletter blocks, generic marketing passages, and repeated low-variation
 * blocks (duplicate paragraphs). Score maps signal density per ~300 words to 0–100.
 *
 * The Copy Slop hedge dimension (src/rules/copySlop.js) folds into this
 * category: vague marketing constructions ("we aim to", "world-class",
 * "seamless experience") ARE generic marketing language, so their hits add to
 * the same density math and appear in the findings with the exact sentence as
 * evidence. The hedge phrase list (src/rules/copySlop.json) is deliberately
 * disjoint from the regexes below so a single sentence is never counted twice
 * inside this category.
 */

import { analyzeHedges } from './copySlop.js';

const SIGNALS = [
  { re: /\bwe use cookies\b/i, label: 'cookie notice' },
  { re: /\baccept( all)? cookies\b/i, label: 'cookie banner' },
  { re: /\bcookie settings\b/i, label: 'cookie settings' },
  { re: /\bmanage (your )?consent\b/i, label: 'consent manager' },
  { re: /\bprivacy policy\b/i, label: 'privacy policy' },
  { re: /\bterms of (use|service)\b/i, label: 'terms of service' },
  { re: /\ball rights reserved\b/i, label: 'copyright notice' },
  { re: /©\s*\d{4}/i, label: 'copyright line' },
  { re: /\bsubscribe to our newsletter\b/i, label: 'newsletter subscribe block' },
  { re: /\bsign up (for|to) our newsletter\b/i, label: 'newsletter signup' },
  { re: /\bunsubscribe\b/i, label: 'unsubscribe link' },
  { re: /\blorem ipsum\b/i, label: 'lorem ipsum placeholder' },
  { re: /\bplaceholder text\b/i, label: 'placeholder text' },
  { re: /\bfollow us on (twitter|facebook|linkedin|instagram|tiktok|youtube)\b/i, label: 'social-follow block' },
  { re: /\bpowered by\b/i, label: 'powered-by line' },
  { re: /\bleave a reply\b/i, label: 'comment form text' },
  { re: /\bget in touch\b/i, label: 'generic \u201Ccontact us\u201D link' },
  { re: /\blearn more\b/i, label: 'generic \u201Clearn more\u201D link' },
  { re: /\bwe are committed to\b/i, label: 'generic commitment claim' },
  { re: /\bour mission is to\b/i, label: 'generic mission statement' },
  { re: /\bcustomer-centric\b/i, label: 'marketing adjective' },
  { re: /\bindustry-leading\b/i, label: 'marketing superlative' },
  { re: /\bproven track record\b/i, label: 'marketing cliché' },
  { re: /\btake your (business|brand|company) to the next level\b/i, label: 'marketing cliché' },
  { re: /\byour one-stop (shop|solution|destination)\b/i, label: 'marketing cliché' },
  { re: /\bdriven by passion\b/i, label: 'generic corporate claim' },
  { re: /\b(we|our team) (is|are) dedicated to\b/i, label: 'generic corporate claim' },
];

const NORMALIZATION_WORDS = 300;
const MAX_FINDINGS = 8;

/** The boilerplate regex signals (exported for the Copy Slop disjointness
 *  guarantee: the hedge phrase list must never collide with one of these so a
 *  single sentence is never double-counted inside this category). */
export const boilerplateRegexes = Object.freeze(SIGNALS.map((s) => s.re));

/**
 * @param {{ text?: string, words?: string[], sentences?: string[], paragraphs?: string[] }} ctx
 */
export function analyze({ text = '', words = [], sentences = [], paragraphs = [] } = {}) {
  if (!text) return { score: 0, findings: [] };

  const found = [];
  for (const sig of SIGNALS) {
    let count = 0;
    let m;
    const re = new RegExp(sig.re.source, sig.re.flags.includes('g') ? sig.re.flags : sig.re.flags + 'g');
    while ((m = re.exec(text)) !== null && count < 50) {
      count += 1;
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
    if (count > 0) found.push({ label: sig.label, count });
  }

  // Copy Slop hedge dimension: vague marketing constructions count as
  // boilerplate-family signals; quote the exact sentence as evidence.
  const hedges = analyzeHedges(text, sentences);
  for (const h of hedges.hits) {
    found.push({ label: `vague phrase "${h.phrase}"`, count: h.count });
  }

  // Repeated low-variation blocks: exact duplicate paragraphs (normalized).
  const normalizedParas = paragraphs.map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim());
  const seen = new Map();
  for (const p of normalizedParas) seen.set(p, (seen.get(p) || 0) + 1);
  const dupBlocks = [...seen.entries()].filter(([, c]) => c > 1).map(([p, c]) => ({ text: p, count: c }));

  const signalHits = found.reduce((s, f) => s + f.count, 0);
  const dupExtra = dupBlocks.reduce((s, d) => s + (d.count - 1), 0);
  const totalSignals = signalHits + dupExtra;

  const wordCount = Math.max(words.length, 1);
  const density = totalSignals * (NORMALIZATION_WORDS / wordCount);
  const score = Math.max(0, Math.min(100, Math.round(Math.min(density, 12) * (100 / 12))));

  const findings = [
    `${totalSignals} generic wording match${totalSignals === 1 ? '' : 'es'} in ${wordCount} words (${density.toFixed(1)} per ${NORMALIZATION_WORDS} words)`,
    ...found.sort((a, b) => b.count - a.count).slice(0, MAX_FINDINGS).map((f) => `${f.count}× ${f.label}`),
    ...hedges.quotes.map((q) => `vague sentence: "${q.sentence}"`),
    ...dupBlocks.slice(0, 3).map((d) => `${d.count}× repeated block: "${d.text.slice(0, 80)}${d.text.length > 80 ? '…' : ''}"`),
  ];

  return { score, findings };
}