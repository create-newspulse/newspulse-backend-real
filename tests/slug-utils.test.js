const test = require('node:test');
const assert = require('node:assert/strict');

const { safeDecodeURIComponent, getSlugCandidates, canonicalizeSlug } = require('../lib/slug');

test('safeDecodeURIComponent returns decoded value when valid', () => {
  const encoded = '%E0%A4%85%E0%A4%97%E0%A4%B0'; // "अगर" (Hindi)
  assert.equal(safeDecodeURIComponent(encoded), 'अगर');
});

test('safeDecodeURIComponent returns original value when malformed', () => {
  const malformed = '%E0%A4%ZZ';
  assert.equal(safeDecodeURIComponent(malformed), malformed);
});

test('getSlugCandidates returns both raw+decoded normalized forms', () => {
  const encoded = '%E0%A4%85%E0%A4%97%E0%A4%B0';
  const candidates = getSlugCandidates(encoded);

  // Raw path form is preserved (normalized), plus decoded Unicode.
  assert.ok(candidates.includes(encoded.toLowerCase()));
  assert.ok(candidates.includes('अगर'));
  assert.equal(new Set(candidates).size, candidates.length);
});

test('getSlugCandidates returns a single candidate for already-decoded Unicode', () => {
  const unicode = 'ગુજરાતી-સમાચાર';
  const candidates = getSlugCandidates(unicode);
  assert.deepEqual(candidates, [unicode.toLowerCase()]);
});

test('canonicalizeSlug prefers decoded unicode', () => {
  const encoded = '%E0%A4%85%E0%A4%97%E0%A4%B0';
  assert.equal(canonicalizeSlug(encoded), 'अगर');
});
