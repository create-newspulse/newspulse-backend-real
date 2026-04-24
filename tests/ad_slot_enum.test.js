const test = require('node:test');
const assert = require('node:assert/strict');

const Ad = require('../models/Ad');
const { AD_SLOT_MEDIA_KIT_METADATA } = require('../src/constants/adSlots');

test('Ad model allows known ad slots', () => {
  const enumValues = Ad.schema.path('slot').enumValues;
  assert.ok(Array.isArray(enumValues));

  const slots = [
    'FOOTER_BANNER_728x90',
    'HOME_LEFT_300x250',
    'HOME_LEFT_300x600',
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

test('Ad slot metadata includes Home Left Rail rate-card entry', () => {
  assert.deepEqual(AD_SLOT_MEDIA_KIT_METADATA.HOME_LEFT_300x250, {
    slot: 'HOME_LEFT_300x250',
    displayName: 'Home Left Rail 300×250',
    dimensions: '300x250',
    rateCard: {
      currency: 'INR',
      oneDay: 400,
      oneWeek: 2500,
      oneMonth: 8000,
    },
  });
});
