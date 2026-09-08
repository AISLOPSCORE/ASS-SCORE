import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../src/text.js';
import { runRules } from '../src/rules/index.js';
import { computeSlopScore, RULE_WEIGHTS } from '../src/scorer.js';

const SLOP_HTML = `<!doctype html><html><head><title>Revolutionary Product</title></head><body>
<h1>Unlock the Future with Our Game-Changer</h1>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the digital landscape. Furthermore, our robust platform leverages seamless synergy to elevate your business to the next level. Moreover, we are committed to unleashing transformative, world-class experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the digital landscape. Furthermore, our robust platform leverages seamless synergy. Moreover, we are committed to unleashing transformative, world-class experiences.</p>
<p>In today's fast-paced world, it's no secret that cutting-edge solutions will revolutionize the digital landscape. Furthermore, our robust platform leverages seamless synergy.</p>
<p>Learn more. Subscribe to our newsletter. Follow us on Twitter. All rights reserved.</p>
</body></html>`;

const CLEAN_HTML = `<!doctype html><html><head><title>Kernel Internals</title></head><body>
<p>The scheduler assigns CPU time to threads according to priority and fairness policies.</p>
<p>Each thread carries its own register set and stack while sharing the address space of its process.</p>
<p>Context switches are expensive, so schedulers batch work and avoid preempting threads too often.</p>
<p>On multicore machines the run queue distributes ready threads across per-CPU queues to reduce lock contention.</p>
<p>The idle path powers down cores when no thread is runnable, trading wake latency for energy.</p>
</body></html>`;

const ctx = (html) => extractText(html);

test('rules are deterministic: same input -> identical output', () => {
  const a = runRules(ctx(SLOP_HTML));
  const b = runRules(ctx(SLOP_HTML));
  assert.deepEqual(a, b);
});

test('slop page scores clearly higher than a clean page on filler + boilerplate', () => {
  const slop = runRules(ctx(SLOP_HTML));
  const clean = runRules(ctx(CLEAN_HTML));
  assert.ok(slop.filler.score > clean.filler.score + 30, `filler ${slop.filler.score} vs ${clean.filler.score}`);
  assert.ok(slop.boilerplate.score > clean.boilerplate.score + 20, `boilerplate ${slop.boilerplate.score} vs ${clean.boilerplate.score}`);
});

test('every rule returns score in 0..100 and string findings', () => {
  for (const [name, rule] of Object.entries(runRules(ctx(CLEAN_HTML)))) {
    assert.ok(Number.isInteger(rule.score) && rule.score >= 0 && rule.score <= 100, `${name}.score`);
    assert.ok(Array.isArray(rule.findings), `${name}.findings is array`);
    for (const f of rule.findings) assert.equal(typeof f, 'string');
  }
});

test('overall score: weights are used and result is clamped to 0..100', () => {
  assert.deepEqual(RULE_WEIGHTS, { filler: 0.25, boilerplate: 0.2, infoDensity: 0.3, repetitive: 0.25 });
  assert.equal(computeSlopScore({ filler: { score: 100 }, boilerplate: { score: 100 }, infoDensity: { score: 100 }, repetitive: { score: 100 } }).slopScore, 100);
  assert.equal(computeSlopScore({ filler: { score: 0 }, boilerplate: { score: 0 }, infoDensity: { score: 0 }, repetitive: { score: 0 } }).slopScore, 0);
  assert.equal(computeSlopScore({ filler: { score: 100 }, boilerplate: { score: 0 }, infoDensity: { score: 0 }, repetitive: { score: 0 } }).slopScore, 25);
  assert.equal(computeSlopScore({}).slopScore, 0); // missing rules default to 0
});

test('MATTR discriminates repetitive from diverse vocabulary', async () => {
  const { mattr } = await import('../src/rules/infoDensity.js');
  const repetitiveWords = Array(200).fill('smoke');
  const diverseWords = Array.from({ length: 200 }, (_, i) => `token${i}`);
  assert.ok(mattr(repetitiveWords) < 0.1);
  assert.ok(mattr(diverseWords) > 0.95);
  assert.ok(mattr(diverseWords) > mattr(repetitiveWords));
});