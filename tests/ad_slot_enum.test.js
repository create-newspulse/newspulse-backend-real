const test = require('node:test');
const assert = require('node:assert/strict');

const Ad = require('../models/Ad');
const {
  AD_SLOT_MEDIA_KIT_METADATA,
  CANONICAL_AD_OPPORTUNITIES,
  REAL_TOGGLEABLE_AD_SLOTS,
  normalizeAdOpportunityKey,
} = require('../src/constants/adSlots');

const REAL_SLOTS = [
  'HOME_728x90',
  'FOOTER_BANNER_728x90',
  'HOME_LEFT_300x250',
  'HOME_RIGHT_300x250',
  'HOME_LEFT_300x600',
  'HOME_RIGHT_300x600',
  'HOME_BILLBOARD_970x250',
  'LIVE_UPDATE_SPONSOR',
  'BREAKING_SPONSOR',
  'ARTICLE_INLINE',
  'ARTICLE_END',
];

const ALL_OPPORTUNITIES = [
  ...REAL_SLOTS,
  'SPONSORED_FEATURE',
  'SPONSORED_ARTICLE',
  'COMBO_CAMPAIGN',
  'BREAKING_TICKER_RED',
  'LIVE_UPDATES_TICKER_BLUE',
  'BREAKING_PAGE_SPONSOR_LINE',
];

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

test('canonical ad opportunity registry includes 11 real slots and 17 total opportunities', () => {
  assert.deepEqual(REAL_TOGGLEABLE_AD_SLOTS, REAL_SLOTS);
  assert.deepEqual(CANONICAL_AD_OPPORTUNITIES, ALL_OPPORTUNITIES);
  assert.equal(CANONICAL_AD_OPPORTUNITIES.length, 17);
  assert.equal(normalizeAdOpportunityKey('SPONSORED_FEATURE_ARTICLE_COMBO'), 'COMBO_CAMPAIGN');
  assert.equal(normalizeAdOpportunityKey('sponsored feature article combo'), 'COMBO_CAMPAIGN');
  assert.equal(normalizeAdOpportunityKey('HOME_RIGHT_RAIL'), 'HOME_RIGHT_300x250');
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

  assert.deepEqual(AD_SLOT_MEDIA_KIT_METADATA.HOME_LEFT_300x600, {
    slot: 'HOME_LEFT_300x600',
    displayName: 'Home Left Rail 300×600 (Half Page)',
    dimensions: '300x600',
    rateCard: {
      currency: 'INR',
      oneDay: 700,
      oneWeek: 4500,
      oneMonth: 14000,
    },
  });
});
