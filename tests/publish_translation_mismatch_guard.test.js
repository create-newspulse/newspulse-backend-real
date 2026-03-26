const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPublishTranslationState } = require('../services/publishAsyncTranslation.service');

test('buildPublishTranslationState does not preserve mismatched full buckets as ready', () => {
  const now = new Date('2026-03-26T00:00:00.000Z');

  const existing = {
    translations: {
      // Corrupted: Gujarati stored under en.
      en: {
        title: 'ગુજરાતી શીર્ષક ગુજરાતી શીર્ષક',
        summary: 'ગુજરાતી સારાંશ ગુજરાતી સારાંશ',
        content: '<p>ગુજરાતી સામગ્રી ગુજરાતી સામગ્રી ગુજરાતી સામગ્રી</p>',
        provider: 'google',
        generatedAt: now,
      },
      // Also corrupted / irrelevant but still Devanagari (should be treated as a cache hit by script rules).
      hi: {
        title: 'लड़कियों के लिए एक अच्छा विकल्प चुनें एक और कदम ठीक है',
        summary: 'मोबाइल फोन की मरम्मत के लिए आवेदन पत्र',
        content: '<p>मोबाइल फोन की मरम्मत के लिए आवेदन पत्र</p>',
        provider: 'google',
        generatedAt: now,
      },
      gu: {
        title: 'મૂળ શીર્ષક',
        summary: 'મૂળ સારાંશ',
        content: '<p>મૂળ સામગ્રી</p>',
        provider: 'manual',
        generatedAt: now,
      },
    },
    translationStatus: { en: 'ready', hi: 'ready', gu: 'ready' },
    translationError: { en: null, hi: null, gu: null },
    translationNextRetryAt: { en: null, hi: null, gu: null },
    translationUpdatedAt: { en: now, hi: now, gu: now },
  };

  const out = buildPublishTranslationState({
    baseLang: 'gu',
    title: 'મૂળ શીર્ષક',
    summary: 'મૂળ સારાંશ',
    content: '<p>મૂળ સામગ્રી</p>',
    existing,
    now,
    translationEnabled: true,
  });

  // en should be pending because the existing full en bucket is clearly Gujarati.
  assert.equal(out.translationStatus.en, 'pending');
  assert.equal(out.translations.en.title, '');
  assert.equal(out.translations.en.summary, '');
  assert.equal(out.translations.en.content, '');

  // hi is Devanagari so it is not script-mismatched; it remains ready as a cache hit.
  assert.equal(out.translationStatus.hi, 'ready');
  assert.equal(typeof out.translations.hi.title, 'string');

  // base should remain ready.
  assert.equal(out.translationStatus.gu, 'ready');
  assert.equal(out.translations.gu.title, 'મૂળ શીર્ષક');
});
