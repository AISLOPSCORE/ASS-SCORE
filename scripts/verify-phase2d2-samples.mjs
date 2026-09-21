/**
 * Phase 2D-2 sample verification — assert the polished paid-report samples
 * keep every Phase 1/2A/2B/2C/2D-1 contract and carry the new Phase 2D-2
 * presentation hooks:
 *   - hero: giant score number + band fill gauge (width = score, direction
 *     0=best/100=worst), scale caption, verdict pill
 *   - category cards: per-category meter fill + findings-or-not line
 *   - findings: roast-first premium cards with a receipts drawer + real
 *     evidence-line count
 *   - What To Fix First: ranked fix cards with category pill + receipt +
 *     link to the underlying finding
 *   - What's Working: real compliment items on clean reports; intentional
 *     A.S.S.-voiced empty panel when the scan has no compliments
 * Regression: no raw `"><`, section order, 7 views, paywall-held free page.
 *
 * Usage: node scripts/verify-phase2d2-samples.mjs [dir]
 *   dir defaults to /home/team/shared/phase2d2-samples
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = process.argv[2] ?? '/home/team/shared/phase2d2-samples';
const clean = fs.readFileSync(path.join(dir, 'clean.html'), 'utf8');
const sloppy = fs.readFileSync(path.join(dir, 'sloppy.html'), 'utf8');

const VIEW_KEYS = ['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets'];
const cards = (html) => (html.match(/<div class="finding-card">/g) ?? []).length;
const roasts = (html) => (html.match(/<p class="ins-roast">/g) ?? []).length;

for (const [name, html] of [['clean', clean], ['sloppy', sloppy]]) {
  // --- dashboard fully present, markers in order (P2A contract) ---
  const seq = ['A.S.S. Score: ', 'The Verdict', 'Your Breakdown', "What's Working",
    'The Actual Findings', 'Page That Needs The Most Work', 'What To Fix First', 'Final Verdict', 'Methodology'];
  let prev = -1;
  for (const marker of seq) {
    const at = html.indexOf(marker);
    assert.ok(at > prev, `${name}: "${marker}" still ordered after the previous section`);
    prev = at;
  }
  assert.ok(html.includes('does not detect AI authorship'), `${name}: mandated disclaimer verbatim`);
  assert.ok(html.includes('id="dashboard"'), `${name}: dashboard wrapper present (no-JS default view)`);

  // --- sacred constraints ---
  assert.ok(!html.includes('"><'), `${name}: no raw quote-bracket sequence (sacred)`);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, `${name}: exactly the one inline 2C script`);

  // --- Phase 2D-2 hero: giant band-colored number + severity gauge ---
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('The Verdict'));
  assert.ok(hero.includes('class="hero-num"'), `${name}: giant score number block present`);
  assert.ok(hero.includes('class="hero-gauge"'), `${name}: severity gauge present`);
  assert.ok(hero.includes('class="hero-val"'), `${name}: score value element present`);
  assert.ok(hero.includes('0 = LEAST ASS / 100 = MAX ASS'), `${name}: direction scale caption present`);
  assert.ok(hero.includes('class="hero-scale"'), `${name}: scale caption element present`);

  // --- category cards: 7 cards, meter fill + findings line ---
  const hrefs = [...html.matchAll(/<a class="cat-card[^"]*" href="#(cat-[a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, VIEW_KEYS, `${name}: the 7 category cards remain, engine order`);
  assert.ok(html.includes('class="cat-meter"'), `${name}: per-category severity meters present`);
  assert.ok(html.includes('class="cat-meter-fill"'), `${name}: per-category meter fills present`);
  assert.ok(html.includes('cat-findings'), `${name}: findings-or-not lines present`);
  for (const anchor of VIEW_KEYS) {
    assert.ok(html.includes(`id="${anchor}"`), `${name}: card target ${anchor} still present`);
  }

  // --- finding cards: receipts drawer carries the real line count ---
  if (name === 'sloppy') {
    assert.equal(cards(sloppy), 6, 'sloppy: six diagnostic cards for six negative findings');
    assert.ok(sloppy.includes('class="rec-count">1 line of evidence<'), 'sloppy: receipts drawer shows the real evidence-line count');
  } else {
    assert.equal(cards(clean), 0, 'clean: zero finding cards');
  }
}

// --- sloppy specifics ---
assert.equal(roasts(sloppy), 6, 'sloppy: one roast layer per card');
assert.ok(sloppy.includes('class="cat-detail cat-detail-priority"'), 'sloppy: PRIORITY section accent hook');
assert.ok(sloppy.includes('class="cat-detail cat-detail-needs-attention"'), 'sloppy: NEEDS ATTENTION section accent hook');
assert.ok(sloppy.includes('class="cat-detail cat-detail-watch"'), 'sloppy: WATCH section accent hook');
assert.ok(sloppy.includes('cv-state cv-state-needs-attention'), 'sloppy: view state badge class normalized');
assert.equal((sloppy.match(/<span class="fc-count">Finding \d+<\/span>/g) ?? []).length, 6, 'sloppy: findings numbered 1..6');
// hero: 89 -> gauge fill 89%, val 89
assert.ok(sloppy.includes('<span class="hero-val">89</span>'), 'sloppy: hero value is 89');
assert.ok(sloppy.includes('style="width:89%"'), 'sloppy: hero gauge fill = 89% (higher = worse)');
// fix-first: capped ranked cards, each linking to its category finding
const fixLis = (sloppy.match(/<li class="fix-item/g) ?? []).length;
assert.equal(fixLis, 5, 'sloppy: fix-first capped at top 5 ranked cards');
const fixLinks = [...sloppy.matchAll(/class="fix-link" href="#(cat-[a-z]+)"/g)].map((m) => m[1]);
assert.equal(fixLinks.length, 5, 'sloppy: every fix card links to its underlying finding');
for (const anchor of fixLinks) assert.ok(sloppy.includes(`id="${anchor}"`), `sloppy: fix link target ${anchor} exists`);
assert.ok(sloppy.includes('class="fix-problem"'), 'sloppy: fix cards carry the problem');
assert.ok(sloppy.includes('class="fix-action"'), 'sloppy: fix cards carry the specific action');
assert.ok(sloppy.includes('class="fix-evidence"'), 'sloppy: fix cards carry the receipt');
assert.ok(sloppy.includes('Nothing to compliment this scan'), 'sloppy: no compliments -> intentional A.S.S. empty state (never invented)');
assert.ok(sloppy.includes('class="working-empty"'), 'sloppy: empty state panel class present');
assert.ok(sloppy.includes('4 roasts — see receipts') || sloppy.includes('roast — see receipts'), 'sloppy: category cards carry roast counts');
assert.equal((sloppy.match(/class="working-item"/g) ?? []).length, 0, 'sloppy: zero invented compliments');

// --- clean specifics ---
assert.ok(clean.includes('<span class="hero-val">7</span>'), 'clean: hero value is 7');
assert.ok(clean.includes('style="width:7%"'), 'clean: hero gauge fill = 7% (low = good)');
assert.equal((clean.match(/class="working-item"/g) ?? []).length, 16, 'clean: real compliments render as reward items across the dashboard and its category views (never invented)');
assert.ok(!clean.includes('class="working-empty"'), 'clean: real compliments -> no empty panel');
assert.ok(clean.includes('No negative findings to fix this scan'), 'clean: fix-first says nothing needs fixing');
assert.ok(!clean.includes('class="fix-item"'), 'clean: zero fix cards');
assert.ok(clean.includes('COPY — CLEAN:'), 'clean: compliments still render with the CLEAN label');
assert.ok(clean.includes('MESSAGING — CLEAN:'), 'clean: MESSAGING compliment intact');
assert.ok(clean.includes('ORIGINALITY — CLEAN:'), 'clean: ORIGINALITY metric compliment intact');

// --- Phase 2C views remain fully wired ---
for (const [name, html] of [['clean', clean], ['sloppy', sloppy]]) {
  const views = [...html.matchAll(/<section class="cat-view" id="(view-cat-[a-z]+)" hidden>/g)].map((m) => m[1]);
  assert.equal(views.length, 7, `${name}: exactly 7 focused view containers`);
  assert.equal(new Set(views).size, 7, `${name}: all 7 view containers distinct`);
  for (const anchor of VIEW_KEYS) {
    assert.ok(html.includes(`id="view-${anchor}"`), `${name}: view container view-${anchor} present`);
    assert.ok(html.includes(`data-source="${anchor}"`), `${name}: view ${anchor} wired to its dashboard section`);
    assert.ok(html.includes('class="cat-back" href="#dashboard"'), `${name}: ${anchor} view has Back to Dashboard`);
  }
}

console.log('phase2d2 sample verification PASSED (clean + sloppy)');