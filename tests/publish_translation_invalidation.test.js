const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPublishTranslationState } = require('../services/publishAsyncTranslation.service');

test('buildPublishTranslationState invalidates non-base cached translations when source text changes', () => {
  const now = new Date('2026-03-29T00:00:00.000Z');

  const result = buildPublishTranslationState({
    baseLang: 'en',
    title: 'Updated English title',
    summary: 'Updated English summary',
    content: '<p>Updated English body without stale URL</p>',
    now,
    existing: {
      title: 'Old English title',
      description: 'Old English summary',
      content: '<p>Old English body</p>',
      translations: {
        en: { title: 'Old English title', summary: 'Old English summary', content: '<p>Old English body</p>', provider: 'manual', generatedAt: new Date('2026-03-28T00:00:00.000Z') },
        hi: { title: 'पुराना', summary: 'पुराना सार', content: '<p>https://x.com/Pirat_Nation/status/2028742176705069126</p>', provider: 'google', generatedAt: new Date('2026-03-28T00:00:00.000Z') },
        gu: { title: 'જૂનું', summary: 'જૂનો સાર', content: '<p>https://x.com/Pirat_Nation/status/2028742176705069126</p>', provider: 'google', generatedAt: new Date('2026-03-28T00:00:00.000Z') },
      },
      translationStatus: { en: 'ready', hi: 'ready', gu: 'ready' },
      translationError: { en: null, hi: null, gu: null },
      translationNextRetryAt: { en: null, hi: null, gu: null },
      translationUpdatedAt: {
        en: new Date('2026-03-28T00:00:00.000Z'),
        hi: new Date('2026-03-28T00:00:00.000Z'),
        gu: new Date('2026-03-28T00:00:00.000Z'),
      },
    },
  });

  assert.equal(result.translations.en.content, '<p>Updated English body without stale URL</p>');
  assert.equal(result.translationStatus.en, 'ready');

  assert.equal(result.translations.hi.title, '');
  assert.equal(result.translations.hi.summary, '');
  assert.equal(result.translations.hi.content, '');
  assert.equal(result.translationStatus.hi, 'pending');
  assert.equal(result.translationError.hi, null);
  assert.equal(result.translationNextRetryAt.hi, null);

  assert.equal(result.translations.gu.title, '');
  assert.equal(result.translations.gu.summary, '');
  assert.equal(result.translations.gu.content, '');
  assert.equal(result.translationStatus.gu, 'pending');
});