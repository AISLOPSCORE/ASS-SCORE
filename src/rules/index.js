import * as filler from './filler.js';
import * as boilerplate from './boilerplate.js';
import * as infoDensity from './infoDensity.js';
import * as repetitive from './repetitive.js';

/**
 * Run all four rules over extracted text. Each rule is a pure function of the
 * text and returns { score: 0-100, findings: string[] }.
 * The result shape doubles as the per-rule breakdown returned to clients.
 *
 * @param {{ text: string, words: string[], sentences: string[], paragraphs: string[], stopwords: Set<string> }} ctx
 * @returns {{ filler: {score,findings}, boilerplate: {score,findings}, infoDensity: {score,findings}, repetitive: {score,findings} }}
 */
export function runRules(ctx) {
  return {
    filler: filler.analyze(ctx),
    boilerplate: boilerplate.analyze(ctx),
    infoDensity: infoDensity.analyze(ctx),
    repetitive: repetitive.analyze(ctx),
  };
}