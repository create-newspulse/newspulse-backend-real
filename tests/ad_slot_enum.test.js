const test = require('node:test');
const assert = require('node:assert/strict');

const Ad = require('../models/Ad');

test('Ad model allows known ad slots', () => {
  const enumValues = Ad.schema.path('slot').enumValues;
  assert.ok(Array.isArray(enumValues));

  const slots = [
    'FOOTER_BANNER_728x90',
    'HOME_RIGHT_300x600',
    'HOME_BILLBOARD_970x250',
    'BREAKING_SPONSOR',
    'LIVE_UPDATE_SPONSOR',
  ];

  for (const slot of slots) {
    assert.ok(enumValues.includes(slot));
    const doc = new Ad({
      slot,
      title: `Test ${slot}`,
      imageUrl: 'https://example.com/ad.jpg',
      targetUrl: 'https://example.com',
      isClickable: true,
      isActive: true,
    });
    const err = doc.validateSync();
    assert.equal(err, undefined);
  }
});
