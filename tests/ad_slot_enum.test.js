const test = require('node:test');
const assert = require('node:assert/strict');

const Ad = require('../models/Ad');

test('Ad model allows FOOTER_BANNER_728x90 slot', () => {
  const enumValues = Ad.schema.path('slot').enumValues;
  assert.ok(Array.isArray(enumValues));
  assert.ok(enumValues.includes('FOOTER_BANNER_728x90'));

  const doc = new Ad({
    slot: 'FOOTER_BANNER_728x90',
    title: 'Footer Banner',
    imageUrl: 'https://example.com/ad.jpg',
    targetUrl: 'https://example.com',
    isClickable: true,
    isActive: true,
  });

  const err = doc.validateSync();
  assert.equal(err, undefined);
});
