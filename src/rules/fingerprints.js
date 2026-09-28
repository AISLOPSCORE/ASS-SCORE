import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build/Tool fingerprints rule.
 *
 * Evidence: publicly known markers of AI website builders and generic template
 * patterns (script/CDN origins for v0.dev, Lovable, Framer, Durable, Replit;
 * meta generator tags; 'Made with <builder>' footers; stock/placeholder image
 * services; default icon libraries). The pattern list lives in
 * fingerprints.json — it is EXTENSIBLE WITHOUT CODE CHANGES (add/remove
 * entries; each has id, label, confidence, scope, patterns[]).
 *
 * Scope determines which string a pattern matches against:
 *   head  — raw <head> inner HTML
 *   html  — the whole raw HTML document
 *   text  — the extracted page text
 *
 * Wording rule (HARD): findings are pattern-evidence only — "template-like",
 * "AI-builder-associated", "unmodified-template marker". This module NEVER
 * asserts AI authorship.
 *
 * Scoring (documented): each hit contributes its confidence weight
 * (high 3, medium 2, low 1), normalised against the total weight of ALL
 * fingerprints in the list: score = round(100 * hitWeight / totalWeight),
 * clamped 0–100 (a page exhibiting every known marker scores 100).
 * Deterministic: JSON order + pattern order, first match per fingerprint id.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fingerprints.json');
export const FINGERPRINTS = Object.freeze(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')));

export const CONFIDENCE_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

export const TOTAL_FINGERPRINT_WEIGHT = FINGERPRINTS.reduce(
  (sum, fp) => sum + (CONFIDENCE_WEIGHT[fp.confidence] ?? 0),
  0,
);

// Cache compiled regexes: deterministic, built once from the JSON pattern strings.
const COMPILED = FINGERPRINTS.map((fp) => ({
  ...fp,
  regexes: (fp.patterns ?? []).map((p) => new RegExp(p, 'i')),
}));

/**
 * @param {object} opts
 * @param {string} [opts.html] full raw HTML of the page
 * @param {string} [opts.head] raw <head> inner HTML (see extractHead)
 * @param {string} [opts.text] extracted page text
 * @returns {{ score: number, findings: string[], hits: Array<{id,label,confidence,scope,pattern}> }}
 */
export function analyzeFingerprints({ html = '', head = '', text = '' } = {}) {
  const hitWeightMap = new Map(); // id -> hit record
  const lower = { head: head.toLowerCase(), html: html.toLowerCase(), text: text.toLowerCase() };

  for (const fp of COMPILED) {
    const weight = CONFIDENCE_WEIGHT[fp.confidence] ?? 0;
    if (weight === 0) continue; // defensive: unknown confidence is ignored
    const scopeText = lower[fp.scope] ?? '';
    // Deterministic: first pattern in list order that matches wins.
    for (const re of fp.regexes) {
      if (re.test(scopeText)) {
        hitWeightMap.set(fp.id, { id: fp.id, label: fp.label, confidence: fp.confidence, scope: fp.scope, pattern: re.source });
        break;
      }
    }
  }

  const hits = [...hitWeightMap.values()]; // insertion order == fingerprint list order
  const hitWeight = hits.reduce((sum, h) => sum + CONFIDENCE_WEIGHT[h.confidence], 0);
  const score = TOTAL_FINGERPRINT_WEIGHT > 0
    ? clamp(Math.round((hitWeight / TOTAL_FINGERPRINT_WEIGHT) * 100), 0, 100)
    : 0;

  // DESIGN clean line (report-integrity fix, owner-approved 2026-09-28,
  // audit Q2): a scan with zero pattern hits emits ONE clean measurement line
  // — matching the other six categories' clean-evidence formats — so DESIGN
  // can compliment like the rest when it is genuinely clean (its compliments
  // pool in threeLayer.json was previously unreachable dead copy). The line
  // only fires when the pattern list is non-empty (an empty list proves
  // nothing to scan); CLEAN_EVIDENCE.fingerprints in src/threeLayer.js
  // classifies it. Never emits when hits exist — pattern evidence only.
  const findings = hits.length === 0 && TOTAL_FINGERPRINT_WEIGHT > 0
    ? ['no recognizable template signs detected']
    : hits.map(
        (h) => `recognizable template sign in the page ${h.scope}: ${h.label} (${h.confidence} confidence)`,
      );

  return { score, findings, hits };
}