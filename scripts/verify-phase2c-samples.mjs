/**
 * Phase 2C sample verification — assert the rendered paid-report samples
 * (clean.html / sloppy.html) contain the focused Category Views: all 7 cards
 * resolve to distinct per-category view containers wired to their own
 * dashboard sections, each view has a Back to Dashboard control, the dashboard
 * keeps every section (markers in order), and the Phase 2B findings/zones/
 * count contracts are untouched. Also re-checks the sacred constraints (no
 * raw `"><`, exactly one inline script) and the no-JS baseline (views hidden).
 *
 * Usage: node scripts/verify-phase2c-samples.mjs [dir]
 *   dir defaults to /home/team/shared/phase2c-samples
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = process.argv[2] ?? '/home/team/shared/phase2c-samples';
const clean = fs.readFileSync(path.join(dir, 'clean.html'), 'utf8');
const sloppy = fs.readFileSync(path.join(dir, 'sloppy.html'), 'utf8');

const VIEW_KEYS = ['cat-filler', 'cat-boilerplate', 'cat-infodensity', 'cat-repetitive', 'cat-crosspage', 'cat-fingerprints', 'cat-assets'];
const cards = (html) => (html.match(/<div class="finding-card">/g) ?? []).length;
const roasts = (html) => (html.match(/<p class="ins-roast">/g) ?? []).length;
const viewIds = (html) => [...html.matchAll(/<section class="cat-view" id="(view-cat-[a-z]+)" hidden>/g)].map((m) => m[1]);

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

  // --- every category card resolves to a focused view container ---
  const hrefs = [...html.matchAll(/<a class="cat-card[^"]*" href="#(cat-[a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, VIEW_KEYS, `${name}: the 7 category cards remain, engine order`);
  const views = viewIds(html);
  assert.equal(views.length, 7, `${name}: exactly 7 focused view containers`);
  assert.equal(new Set(views).size, 7, `${name}: all 7 view containers distinct`);
  assert.ok(html.indexOf(`id="${VIEW_KEYS[0]}"`) < html.indexOf('id="view-cat-filler"'), `${name}: views sit after the dashboard sections`);
  for (const anchor of VIEW_KEYS) {
    assert.ok(html.includes(`id="view-${anchor}"`), `${name}: card ${anchor} has view container view-${anchor}`);
    const vi = html.indexOf(`id="view-${anchor}"`);
    const vEnd = html.indexOf('<section class="cat-view"', vi + 1);
    const viewHtml = html.slice(vi, vEnd > 0 ? vEnd : vi + 2000);
    assert.ok(viewHtml.includes('class="cat-back" href="#dashboard"'), `${name}: ${anchor} view has Back to Dashboard`);
    assert.ok(viewHtml.includes(`data-source="${anchor}"`), `${name}: ${anchor} view body resolves to dashboard section ${anchor}`);
    assert.ok(html.includes(`id="${anchor}"`), `${name}: dashboard section ${anchor} still present`);
    assert.ok(viewHtml.includes('class="cat-view-state"'), `${name}: ${anchor} view carries the score/state line`);
    assert.ok(viewHtml.includes('hidden>'), `${name}: ${anchor} view hidden by default (no-JS baseline)`);
  }

  // --- sacred constraints ---
  assert.ok(!html.includes('"><'), `${name}: no raw quote-bracket sequence (sacred)`);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, `${name}: exactly the one inline 2C script`);
}

// --- Phase 2B contracts unchanged ---
assert.equal(cards(sloppy), 6, 'sloppy: six diagnostic cards for six negative findings');
assert.equal(roasts(sloppy), 6, 'sloppy: one roast layer per card');
assert.equal((sloppy.match(/<span class="fc-count">Finding \d+<\/span>/g) ?? []).join(','),
  '<span class="fc-count">Finding 1</span>,<span class="fc-count">Finding 2</span>,<span class="fc-count">Finding 3</span>,<span class="fc-count">Finding 4</span>,<span class="fc-count">Finding 5</span>,<span class="fc-count">Finding 6</span>',
  'sloppy: findings numbered 1..6 in report order');
assert.equal(cards(clean), 0, 'clean: zero finding cards');
assert.equal(roasts(clean), 0, 'clean: zero roast layers');
assert.ok(!clean.includes('How to fix it:'), 'clean: no fix zone');
assert.ok(clean.includes('COPY — CLEAN:'), 'clean: compliments still render in What\'s Working');

console.log('phase2c sample verification PASSED (clean + sloppy)');