/**
 * Phase 2B sample verification — assert the rendered paid-report samples
 * (clean.html / sloppy.html) contain the diagnostic finding cards with the
 * four labeled zones, correct counts + order, the sacred no-`"><` constraint,
 * and that the clean sample has zero cards.
 *
 * Usage: node scripts/verify-phase2b-samples.mjs [dir]
 *   dir defaults to /home/team/shared/phase2b-samples
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = process.argv[2] ?? '/home/team/shared/phase2b-samples';
const clean = fs.readFileSync(path.join(dir, 'clean.html'), 'utf8');
const sloppy = fs.readFileSync(path.join(dir, 'sloppy.html'), 'utf8');

const cards = (html) => (html.match(/<div class="finding-card">/g) ?? []).length;
const roasts = (html) => (html.match(/<p class="ins-roast">/g) ?? []).length;
const details = (html) => (html.match(/<details class="fc-receipts">/g) ?? []).length;

// ---- sloppy (6 negatives: COPY×2, MESSAGING, ORIGINALITY, STRUCTURE, IMAGERY)
assert.equal(cards(sloppy), 6, 'sloppy: six diagnostic cards for six negative findings');
assert.equal(roasts(sloppy), 6, 'sloppy: one roast layer per card');
assert.equal(details(sloppy), 6, 'sloppy: collapsible receipts block per card');
assert.equal((sloppy.match(/<span class="fc-count">Finding \d+<\/span>/g) ?? []).join(','),
  '<span class="fc-count">Finding 1</span>,<span class="fc-count">Finding 2</span>,<span class="fc-count">Finding 3</span>,<span class="fc-count">Finding 4</span>,<span class="fc-count">Finding 5</span>,<span class="fc-count">Finding 6</span>',
  'sloppy: findings numbered 1..6 in report order');
assert.ok(sloppy.includes('The Roast') && sloppy.includes('Why it matters:')
  && sloppy.includes('How to fix it:') && sloppy.includes('Show the receipts:'),
  'sloppy: the four labeled zones are all present');
assert.ok(!sloppy.includes('"><'), 'sloppy: no raw quote-bracket sequence (sacred constraint)');
assert.ok(sloppy.includes('class="fc-state fc-state-priority"'), 'sloppy: PRIORITY badge from existing classification');
assert.ok(['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets']
  .every((a) => sloppy.includes(`id="${a}"`)), 'sloppy: all 7 Phase 2A anchor targets remain');
assert.ok(sloppy.includes('A.S.S. Score: 89 / 100') && sloppy.includes('EXTREMELY ASS'), 'sloppy: hero unchanged');
assert.ok(sloppy.includes('does not detect AI authorship'), 'sloppy: mandated disclaimer verbatim');

// Every card region carries the four zones + its own ordinal.
const starts = [...sloppy.matchAll(/<div class="finding-card">/g)].map((m) => m.index);
for (let i = 0; i < starts.length; i++) {
  const to = i + 1 < starts.length ? starts[i + 1] : sloppy.length;
  const card = sloppy.slice(starts[i], to);
  assert.ok(card.includes('The Roast'), `card ${i + 1}: Roast zone`);
  assert.ok(card.includes('Why it matters:'), `card ${i + 1}: Why zone`);
  assert.ok(card.includes('How to fix it:'), `card ${i + 1}: Fix zone`);
  assert.ok(card.includes('Show the receipts:'), `card ${i + 1}: Receipts zone`);
  assert.ok(card.includes(`Finding ${i + 1}`), `card ${i + 1}: ordinal ${i + 1}`);
  assert.ok(card.includes('<p class="ins-roast">'), `card ${i + 1}: roast paragraph`);
}

// Verbatim receipt strings in order (Phase 1 data is the source of truth).
const receiptSeq = [
  '3× &quot;cutting-edge&quot;',
  '2× &quot;seamless&quot;',
  '1× hedge phrase &quot;we aim to&quot;',
  'concrete specifics: 0 found in 500 words',
  'repeated sentence openings: 5× &quot;the company&quot;',
  '2 of 2 images from stock/placeholder CDNs',
];
let prev = -1;
for (const r of receiptSeq) {
  const at = sloppy.indexOf(r);
  assert.ok(at > prev, `verbatim receipt "${r}" present after the previous card`);
  prev = at;
}

// ---- clean (7/100 CLEANEST): zero cards, compliments only
assert.equal(cards(clean), 0, 'clean: zero finding cards');
assert.equal(roasts(clean), 0, 'clean: zero roast layers');
assert.ok(!clean.includes('How to fix it:'), 'clean: no fix zone');
assert.ok(clean.includes('A.S.S. Score: 7 / 100') && clean.includes('CLEANEST'), 'clean: hero unchanged');
assert.ok(clean.includes('does not detect AI authorship'), 'clean: mandated disclaimer verbatim');
assert.ok(clean.includes('COPY — CLEAN:'), 'clean: compliments still render in What\'s Working');

// ---- CSS: responsive/overflow safety on the card styles (present in both)
for (const [name, html] of [['clean', clean], ['sloppy', sloppy]]) {
  assert.ok(html.includes('.finding-card {'), `${name}: finding-card CSS present`);
  assert.ok(html.includes('overflow-wrap: break-word; word-break: break-word;'), `${name}: no horizontal overflow from long text`);
  assert.ok(html.includes('.fc-head { display: flex; flex-wrap: wrap;'), `${name}: header wraps on mobile`);
}

console.log('phase2b sample verification PASSED (clean + sloppy)');