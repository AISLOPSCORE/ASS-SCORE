import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Shared helpers for the cached-fixture regression matrix (fingerprint
 * vocabulary expansion, 2026-10-01). Fixtures are RAW saved homepage HTML —
 * never fetched at test time (flake-free, deterministic). The bytes are the
 * source of truth; if the sites change, re-capture the fixtures (one curl per
 * site) and update the expected numbers in fingerprintVocab.test.js.
 */
import { analyzeFingerprints } from '../../src/rules/fingerprints.js';
import { visualRepetitionHits } from '../../src/rules/visualRepetition.js';
import { extractHead, extractText } from '../../src/text.js';
import { runRules } from '../../src/rules/index.js';
import { analyzeAssets } from '../../src/rules/assets.js';
import { computeSlopScore } from '../../src/scorer.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_NAMES = ['blog2posts', 'getcollectionscopilot', 'stripe', 'ass-score'];

/** Load a fixture's raw homepage HTML (fixture files live in this dir). */
export function loadFixture(name) {
  if (!FIXTURE_NAMES.includes(name)) throw new Error(`unknown fixture: ${name}`);
  return fs.readFileSync(path.join(FIXTURES_DIR, `${name}-home.html`), 'utf8');
}

/**
 * Target-page fingerprints exactly like scan.js: the JSON-rule hits plus the
 * round-1 visual-repetition extra hits (same extraHits composition call).
 */
export function analyzeFixtureFingerprints(name) {
  const html = loadFixture(name);
  return analyzeFingerprints({
    html,
    head: extractHead(html),
    text: extractText(html).text,
    extraHits: visualRepetitionHits(html),
  });
}

/**
 * Full target-page breakdown the way scan.js computes it for the requested
 * URL: four text rules on the extracted text + fingerprints (html/head/text)
 * + assets (html only). crossPage is NOT computable from a single fixture, so
 * `crossPageScore` lets callers inject the live scan's crossPage value (0 for
 * ass-score.com) to reproduce the full-weight composite.
 */
export function fixtureBreakdown(name, crossPageScore = 0) {
  const html = loadFixture(name);
  const text = extractText(html);
  const fingerprints = analyzeFingerprints({
    html,
    head: extractHead(html),
    text: text.text,
    extraHits: visualRepetitionHits(html),
  });
  const rules = runRules(text);
  const assets = analyzeAssets(html);
  const breakdown = {
    ...rules,
    crossPage: { score: crossPageScore, findings: [] },
    fingerprints,
    assets,
  };
  return {
    breakdown,
    html,
    text,
    composite: computeSlopScore(breakdown).slopScore,
  };
}