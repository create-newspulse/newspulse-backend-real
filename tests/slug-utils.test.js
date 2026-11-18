const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeDecodeURIComponent, getSlugCandidates, canonicalizeSlug,
  slugifyLocalizedTitle, pickLocalizedArticleSlug, ensureNewsSlugs,
} = require('../lib/slug');

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

  // Raw path form is preserved exactly (to match legacy percent-encoded storage),
  // plus the decoded Unicode.
  assert.ok(candidates.includes(encoded));
  assert.ok(candidates.includes('अगर'));
  assert.equal(new Set(candidates).size, candidates.length);
});

test('getSlugCandidates finds legacy encoded storage from decoded Unicode', () => {
  const unicode = 'ગુજરાતી-સમાચાર';
  const candidates = getSlugCandidates(unicode);
  assert.deepEqual(candidates, [unicode, encodeURIComponent(unicode), encodeURIComponent(unicode).toLowerCase()]);
});

test('canonicalizeSlug prefers decoded unicode', () => {
  const encoded = '%E0%A4%85%E0%A4%97%E0%A4%B0';
  assert.equal(canonicalizeSlug(encoded), 'अगर');
});

test('localized title slugs preserve EN, HI and GU scripts and cannot be mistaken for IDs', () => {
  assert.equal(slugifyLocalizedTitle('Heritage 2026 in Gujarat', 'en'), 'heritage-2026-in-gujarat');
  assert.equal(slugifyLocalizedTitle('गुजरात की विरासत २०२६', 'hi'), 'गुजरात-की-विरासत-२०२६');
  assert.equal(slugifyLocalizedTitle('ગુજરાતનો વારસો ૨૦૨૬', 'gu'), 'ગુજરાતનો-વારસો-૨૦૨૬');
  assert.equal(slugifyLocalizedTitle('ગુજરાતનો વારસો', 'en'), '');
  assert.equal(slugifyLocalizedTitle('507f1f77bcf86cd799439001', 'en'), '507f1f77bcf86cd799439001-en');
});

test('canonical selection rejects foreign, blank and ID-shaped slugs without inventing title URLs', () => {
  const id = '507f1f77bcf86cd799439001';
  const doc = { _id: id, title: 'English title', lang: 'en', slug: 'ગુજરાતી-સમાચાર', slugs: { gu: 'ગુજરાતી-સમાચાર' } };
  for (const slugs of [{}, { en: ' ' }, { en: 'ગુજરાતી-સમાચાર' }, { en: '507f1f77bcf86cd799439002' }]) {
    assert.equal(pickLocalizedArticleSlug({ ...doc, slugs }, 'en'), id);
  }
  assert.equal(pickLocalizedArticleSlug({ ...doc, slugs: { en: 'published-english-url' } }, 'en'), 'published-english-url');
  assert.equal(pickLocalizedArticleSlug({ ...doc, lang: 'gu', slug: 'legacy-transliteration' }, 'en'), id);
  assert.equal(pickLocalizedArticleSlug({ ...doc, isTranslated: true, slug: 'legacy-transliteration', slugs: {} }, 'en'), id);
  assert.equal(pickLocalizedArticleSlug({ ...doc, slug: 'own-english-url', slugs: {} }, 'en'), 'own-english-url');
});

test('slug preparation fills draft locales from their titles but leaves published URL maps unchanged', () => {
  const doc = {
    lang: 'en', title: 'English title', slug: 'editorial-url', slugs: { en: 'editorial-url' },
    translations: { hi: { title: 'हिंदी शीर्षक' }, gu: { title: 'ગુજરાતી શીર્ષક' } },
  };
  for (const publication of [{ status: 'published' }, { status: 'draft', publishedAt: new Date('2020-01-01') }]) {
    const published = { ...structuredClone(doc), ...publication };
    const before = structuredClone(published);
    ensureNewsSlugs(published);
    assert.deepEqual(published, before);
  }
  ensureNewsSlugs(doc);
  assert.deepEqual(doc.slugs, { en: 'editorial-url', hi: 'हिंदी-शीर्षक', gu: 'ગુજરાતી-શીર્ષક' });
  assert.equal(doc.slug, 'editorial-url');
});
