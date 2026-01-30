const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

test('Translate: numeric placeholders never leak and digits are restored', async () => {
  const prevFetch = global.fetch;

  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          translations: [
            // Simulate translated output containing localized digits.
            { translatedText: 'ચાંદીમાં ભાવ ૨૯૩૦૦૦ પર પહોંચ્યો' },
          ],
        },
      }),
    });

    const googleTranslate = require('../services/translate/googleTranslate');

    const out = await googleTranslate.translate('Price reached 293000', 'en', 'gu');

    assert.ok(out, 'translation should return a string');
    assert.ok(out.includes('293000'), 'digits should be normalized to ASCII');
    assert.ok(!out.includes('__NUM'), `should not contain __NUM tokens. got=${JSON.stringify(out)}`);
  } finally {
    global.fetch = prevFetch;
  }
});
