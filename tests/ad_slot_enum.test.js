const test = require('node:test');
const assert = require('node:assert/strict');

const Ad = require('../models/Ad');
const AdPerformanceDaily = require('../models/AdPerformanceDaily');
const { AD_SLOTS, normalizeSlot } = require('../lib/ads');
const {
  AD_IMAGE_SLOT_SIZES,
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
  'TOP_HOME_BILLBOARD_970x250',
  'CATEGORY_TOP_970x90',
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
    'TOP_HOME_BILLBOARD_970x250',
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

test('canonical ad opportunity registry includes 13 real slots and 19 total opportunities', () => {
  assert.deepEqual(REAL_TOGGLEABLE_AD_SLOTS, REAL_SLOTS);
  assert.deepEqual(CANONICAL_AD_OPPORTUNITIES, ALL_OPPORTUNITIES);
  assert.equal(REAL_TOGGLEABLE_AD_SLOTS.length, 13);
  assert.equal(CANONICAL_AD_OPPORTUNITIES.length, 19);
  assert.equal(normalizeAdOpportunityKey('SPONSORED_FEATURE_ARTICLE_COMBO'), 'COMBO_CAMPAIGN');
  assert.equal(normalizeAdOpportunityKey('sponsored feature article combo'), 'COMBO_CAMPAIGN');
  assert.equal(normalizeAdOpportunityKey('HOME_RIGHT_RAIL'), 'HOME_RIGHT_300x250');
});

test('top-home billboard is a distinct display and performance slot, not an alias', () => {
  const slot = 'TOP_HOME_BILLBOARD_970x250';
  assert.equal(AD_SLOTS.filter((value) => value === slot).length, 1);
  assert.equal(normalizeSlot('top home billboard 970x250'), slot);
  assert.equal(normalizeAdOpportunityKey(slot), slot);
  assert.equal(normalizeSlot('HOME_RIGHT_RAIL'), 'HOME_RIGHT_300x250');
  assert.equal(normalizeSlot('HOME_728x90'), 'HOME_728x90');
  assert.equal(normalizeSlot('HOME_BILLBOARD_970x250'), 'HOME_BILLBOARD_970x250');
  const ad = new Ad({ slot, imageUrl: 'https://example.com/ad.jpg', isClickable: false });
  assert.equal(ad.validateSync(), undefined);
  assert.equal(ad.isActive, false);
  assert.equal(ad.priority, 0);
  assert.equal(ad.startAt, null);
  assert.equal(ad.endAt, null);
  assert.deepEqual(ad.stats.toObject(), { impressions: 0, clicks: 0 });
  const daily = new AdPerformanceDaily({ adId: ad._id, dateKey: '2026-10-01', slot });
  assert.equal(daily.validateSync(), undefined);
  assert.ok(AdPerformanceDaily.schema.path('slot').enumValues.includes(slot));
  assert.equal(AD_SLOT_MEDIA_KIT_METADATA[slot], undefined);
});

test('category-top is an independent display and analytics slot with dimensions and no pricing', () => {
  const slot = 'CATEGORY_TOP_970x90';
  assert.deepEqual(AD_SLOTS, [
    'HOME_728x90', 'HOME_BILLBOARD_970x250', 'HOME_LEFT_300x250',
    'HOME_LEFT_300x600', 'HOME_RIGHT_300x250', 'HOME_RIGHT_300x600',
    'HOME_RIGHT_RAIL', 'ARTICLE_INLINE', 'ARTICLE_END', 'FOOTER_BANNER_728x90',
    'BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR', 'TOP_HOME_BILLBOARD_970x250', slot,
  ]);
  assert.equal(normalizeSlot(slot), slot);
  assert.equal(normalizeAdOpportunityKey(slot), slot);
  assert.equal(normalizeSlot('UNKNOWN'), null);
  assert.equal(normalizeSlot('CATEGORY_TOP_BILLBOARD'), null);
  const ad = new Ad({ slot, imageUrl: 'https://example.com/ad.jpg', isClickable: false });
  assert.equal(ad.validateSync(), undefined);
  const daily = new AdPerformanceDaily({ adId: ad._id, dateKey: '2026-10-08', slot });
  assert.equal(daily.validateSync(), undefined);
  const invalid = new Ad({ slot: 'UNKNOWN', imageUrl: ad.imageUrl, isClickable: false });
  assert.ok(invalid.validateSync().errors.slot);
  assert.deepEqual(AD_SLOT_MEDIA_KIT_METADATA[slot], {
    slot,
    displayName: 'Category Top Banner 970×90',
    dimensions: '970x90',
  });
});

test('creative sizes cover dimensioned image slots without inventing unsized placement dimensions', () => {
  assert.deepEqual(Object.keys(AD_IMAGE_SLOT_SIZES), [
    'HOME_728x90', 'CATEGORY_TOP_970x90', 'FOOTER_BANNER_728x90',
    'HOME_LEFT_300x250', 'HOME_RIGHT_300x250', 'ARTICLE_INLINE', 'ARTICLE_END', 'HOME_LEFT_300x600',
    'HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250', 'TOP_HOME_BILLBOARD_970x250',
  ]);
  for (const [slot, size] of Object.entries(AD_IMAGE_SLOT_SIZES)) {
    assert.ok(AD_SLOTS.includes(slot));
    assert.equal(size.slot, slot);
    if (slot === 'ARTICLE_INLINE' || slot === 'ARTICLE_END') {
      assert.equal(size.width, 300);
      assert.equal(size.height, 250);
      assert.equal(size.aspectRatio, 6 / 5);
    } else {
      assert.ok(slot.endsWith(`${size.width}x${size.height}`));
    }
    assert.equal(size.aspectRatio, size.width / size.height);
    assert.ok(Object.isFrozen(size));
  }
  assert.equal(AD_IMAGE_SLOT_SIZES[normalizeSlot('HOME_RIGHT_RAIL')].width, 300);
  for (const slot of ['BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR']) {
    assert.equal(AD_IMAGE_SLOT_SIZES[slot], undefined);
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
