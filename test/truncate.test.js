import { test } from 'node:test';
import assert from 'node:assert/strict';
import { short, shortUrl } from '../src/truncate.js';
import { short as shortReexport } from '../src/reportHtml.js';

// ---------------------------------------------------------------------------
// Report-trust truncation helpers (2026-10-07): one shared word-boundary
// truncation for every customer-facing string + URL tail preservation.
// ---------------------------------------------------------------------------

test('truncate: short() lands on word boundaries and strips trailing punctuation/space', () => {
  assert.equal(short('word1 word2 word3 word4', 14), 'word1 word2…');
  assert.equal(short('The quick brown fox jumps over the lazy dog', 16), 'The quick brown…');
  assert.equal(short('Alpha beta, gamma delta', 15), 'Alpha beta…', 'trailing comma stripped');
  assert.equal(short('Alpha beta. gamma', 13), 'Alpha beta…', 'trailing period stripped');
  assert.equal(short('Alpha beta  gamma delta', 12), 'Alpha beta…', 'trailing whitespace stripped');
  assert.equal(short('Quote "word" tail', 10), 'Quote…', 'trailing quote stripped');
  assert.equal(short('x'.repeat(50), 20), `${'x'.repeat(20)}…`, 'single over-long token hard-cuts');
  assert.ok(short('abcdef', 1).length >= 1, 'never truncates to the empty string');
  assert.equal(short('short text', 120), 'short text', 'under the limit returned whole');
  assert.equal(short(12345, 120), '12345', 'non-strings stringified');
  assert.equal(short('anything', 0), '…', 'limit 0 collapses to the ellipsis');
});

test('truncate: shortUrl() keeps the identifying host + filename tail', () => {
  const long = 'https://cdn.publishyoursaas.com/uploads/screenshots/Screenshot_6_xlarge.png';
  assert.equal(shortUrl(long, 80), long, 'URL at/under the limit passes through verbatim');
  assert.equal(shortUrl(long, 55), 'cdn.publishyoursaas.com…/Screenshot_6_xlarge.png', 'host + "…/" + basename keeps which image is meant');
  assert.equal(shortUrl(long, 30).endsWith('…/Screenshot_6_xlarge.png'), false, 'shorter budgets further shorten the host side');
  assert.ok(shortUrl(long, 30).includes('…/'), 'ellipsis separator always present when cut');
  assert.equal(shortUrl('/images/img_1410.jpg', 8), '…410.jpg', 'non-parsable keeps the tail — the filename lives at the end');
  assert.equal(shortUrl('/images/img_1410.jpg', 5), '….jpg', 'non-parsable tail shrinks to the last limit-1 chars');
  assert.equal(shortUrl('', 70), '', 'empty stays empty');
});

test('truncate: reportHtml re-exports the same implementation (single source of truth)', () => {
  assert.equal(shortReexport, short, 'reportHtml.js re-exports truncate.js short (no fork)');
});