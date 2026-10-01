import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Build/Tool fingerprints rule.
 *
 * Evidence: publicly known markers of AI website builders and generic template
 * patterns (script/CDN origins for v0.dev, Lovable, Framer, Durable, Replit;
 * meta generator tags; 'Made with <builder>' footers; stock/placeholder image
 * services; default icon libraries) PLUS the component-library class/token
 * vocabulary of unmodified starter kits (shadcn/ui, MUI, Bootstrap, stock
 * Tailwind palette utilities). The rule list lives in fingerprints.json — it
 * is EXTENSIBLE WITHOUT CODE CHANGES (add/remove entries; each has id, label,
 * confidence, scope, and EITHER patterns[] (boolean) or countTokens[] +
 * tiers[] (count-tiered)).
 *
 * Two rule kinds (a rule is never both):
 *   boolean   — `patterns`: regex sources; scope text is matched case-
 *               insensitively, FIRST pattern in list order that matches wins
 *               (deterministic). Hit confidence = the rule's base confidence.
 *   count     — `countTokens`: string tokens counted literally (case-
 *               insensitive, global; tokens are escaped, never treated as
 *               regex) against the scoped text; the SUM of the counts is the
 *               trigger. total === 0 -> no hit. Otherwise confidence = the
 *               highest `tiers[].min` tier whose min is <= total (tiers
 *               sorted ascending by min; if no tier matches, fall back to the
 *               rule's base confidence). The hit carries the per-token
 *               counts so findings embed real receipts.
 *
 * Scope determines which string a rule matches against:
 *   head  — raw <head> inner HTML
 *   html  — the whole raw HTML document
 *   text  — the extracted page text
 *
 * Wording rule (HARD): findings are pattern-evidence only — "template-like",
 * "AI-builder-associated", "unmodified-template marker", "token usages".
 * This module NEVER asserts AI authorship.
 *
 * Scoring (documented): each hit contributes its confidence weight
 * (high 3, medium 2, low 1), normalised against the total weight of ALL
 * fingerprints in the list: score = round(100 * hitWeight / totalWeight),
 * clamped 0–100 (a page exhibiting every known marker scores 100).
 * TOTAL_FINGERPRINT_WEIGHT recomputes from the JSON: boolean rules count
 * their base confidence; count rules count their MAX possible tier confidence
 * (the denominator is stable and deterministic — independent of what any
 * given page actually contains). Deterministic: JSON order + pattern/token
 * order, first match per fingerprint id.
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fingerprints.json');
export const FINGERPRINTS = Object.freeze(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')));
export const CONFIDENCE_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });
const confidenceWeight = (c) => CONFIDENCE_WEIGHT[c] ?? 0;
/** Escape a literal string so it matches itself, not as a regex. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Weight ONE rule toward the denominator. Boolean rules use their base
 * confidence. Count rules use their MAX possible tier confidence (the largest
 * contribution such a rule can ever make) so the denominator is stable and
 * deterministic. Tiers carry only confidence names; we pick the one whose
 * weight is largest.
 */
function ruleMaxWeight(fp) {
  if (Array.isArray(fp.countTokens) && fp.countTokens.length > 0) {
    const tierWeights = (fp.tiers ?? []).map((t) => confidenceWeight(t.confidence));
    if (tierWeights.length > 0) return Math.max(...tierWeights);
  }
  return confidenceWeight(fp.confidence);
}
export const TOTAL_FINGERPRINT_WEIGHT = FINGERPRINTS.reduce(
  (sum, fp) => sum + ruleMaxWeight(fp),
  0,
);
// Cache compiled regexes: deterministic, built once from the JSON strings.
// Boolean patterns stay regex sources (matched case-insensitively, first
// match); count tokens are escaped literals matched GLOBALLY so every
// occurrence counts (case-insensitive).
const COMPILED = FINGERPRINTS.map((fp) => ({
  ...fp,
  regexes: (fp.patterns ?? []).map((p) => new RegExp(p, 'i')),
  tokenRegexes: (fp.countTokens ?? []).map((t) => new RegExp(escapeRegExp(t), 'gi')),
}));
/**
 * Resolve the tiered confidence for a token-count total: the highest tier
 * whose `min` is <= total (tiers sorted ascending by min; deterministic).
 * Returns null when no tier matches, meaning the caller falls back to the
 * rule's base confidence.
 *
 * @param {object} fp fingerprint rule
 * @param {number} total summed token count on the scoped text
 * @returns {string|null} confidence name (high/medium/low) or null
 */
export function resolveTierConfidence(fp, total) {
  const tiers = (fp.tiers ?? []).slice().sort((a, b) => a.min - b.min);
  let best = null;
  for (const tier of tiers) {
    if (total >= tier.min) best = tier.confidence;
  }
  return best;
}
/**
 * @param {object} opts
 * @param {string} [opts.html] full raw HTML of the page
 * @param {string} [opts.head] raw <head> inner HTML (see extractHead)
 * @param {string} [opts.text] extracted page text
 * @returns {{ score: number, findings: string[], hits: Array<{id,label,confidence,scope,pattern?|counts?}> }}
 */
export function analyzeFingerprints({ html = '', head = '', text = '' } = {}) {
  const hitWeightMap = new Map(); // id -> hit record
  const lower = { head: head.toLowerCase(), html: html.toLowerCase(), text: text.toLowerCase() };
  for (const fp of COMPILED) {
    const baseWeight = confidenceWeight(fp.confidence);
    if (baseWeight === 0) continue; // defensive: unknown confidence is ignored
    const scopeText = lower[fp.scope] ?? '';
    const isCountRule = Array.isArray(fp.countTokens) && fp.countTokens.length > 0;
    if (isCountRule) {
      // Count-tiered rule: the COUNT is the trigger. Boolean patterns are NOT
      // consulted (a rule is either count-based or pattern-based). Every
      // token is counted literally, case-insensitively, across the whole
      // scoped text; the counts are the quotable receipt.
      const counts = fp.tokenRegexes.map((re, i) => {
        const count = (scopeText.match(re) ?? []).length; // fresh global scan per token
        return { token: fp.countTokens[i], count };
      });
      const present = counts.filter((c) => c.count > 0); // zero-count tokens are not evidence
      const total = present.reduce((sum, c) => sum + c.count, 0);
      if (total === 0) continue;
      // Highest tier whose min is <= total; none matched -> base confidence.
      const confidence = resolveTierConfidence(fp, total) ?? fp.confidence;
      const resolvedWeight = confidenceWeight(confidence);
      if (resolvedWeight === 0) continue;
      // Deterministic order: by count desc, ties break by JSON order (the
      // map input order — stable sort keeps it).
      const top = present.slice().sort((a, b) => b.count - a.count);
      hitWeightMap.set(fp.id, {
        id: fp.id,
        label: fp.label,
        confidence,
        scope: fp.scope,
        counts: top,
      });
      continue;
    }
    // Boolean pattern rule: Deterministic: first pattern in list order that
    // matches wins. Behavior unchanged from the pre-countToken runner.
    for (const re of fp.regexes) {
      if (re.test(scopeText)) {
        hitWeightMap.set(fp.id, { id: fp.id, label: fp.label, confidence: fp.confidence, scope: fp.scope, pattern: re.source });
        break;
      }
    }
  }
  const hits = [...hitWeightMap.values()]; // insertion order == fingerprint list order
  const hitWeight = hits.reduce((sum, h) => sum + confidenceWeight(h.confidence), 0);
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
    : hits.map((h) => {
        if (Array.isArray(h.counts)) {
          // Count-tiered receipt: <label> — <N> token usages (<top> ×<n>, ...)
          // (list capped at 6, top by count, JSON-order tie-break).
          const total = h.counts.reduce((sum, c) => sum + c.count, 0);
          const list = h.counts.slice(0, 6).map((c) => `${c.token} ×${c.count}`).join(', ');
          return `recognizable template sign in the page ${h.scope}: ${h.label} — ${total} token usages (${list}) (${h.confidence} confidence)`;
        }
        return `recognizable template sign in the page ${h.scope}: ${h.label} (${h.confidence} confidence)`;
      });
  return { score, findings, hits };
}