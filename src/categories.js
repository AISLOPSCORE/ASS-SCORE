/**
 * Customer-facing category names — the ONLY display-label table for the
 * breakdown (owner 2026-09-15 "plain names" mapping). The internal JSON API
 * keys (filler/boilerplate/infoDensity/repetitive/crossPage/fingerprints/
 * assets) NEVER change — edit the visible names HERE and nowhere else.
 * Mapping: filler→COPY, boilerplate→MESSAGING, infoDensity→ORIGINALITY,
 * repetitive→STRUCTURE, crossPage→REPETITION, fingerprints→DESIGN,
 * assets→IMAGERY. (Lead's best-semantic derivation; adjust in place if the
 * owner renames after review.)
 */
export const CATEGORY_LABELS = {
  filler: 'COPY',
  boilerplate: 'MESSAGING',
  infoDensity: 'ORIGINALITY',
  repetitive: 'STRUCTURE',
  crossPage: 'REPETITION',
  fingerprints: 'DESIGN',
  assets: 'IMAGERY',
};

/** Plain-English one-liner per category (Your Breakdown section). */
export const CATEGORY_ONE_LINERS = {
  filler: 'How much of your copy is filler phrasing — words that sound confident but say nothing.',
  boilerplate: 'Generic marketing boilerplate that could describe any business in any industry.',
  infoDensity: 'Whether your content actually says something specific, or just fills the page.',
  repetitive: 'How often your page repeats itself — same sentence openings, same sentences, same paragraphs.',
  crossPage: 'How much of your site is the same text repeated across different pages.',
  fingerprints: 'Telltale template-built design and code fingerprints (AI-looking patterns, build-tool traces).',
  assets: 'Stock and placeholder imagery where real, specific visuals would say more.',
};
