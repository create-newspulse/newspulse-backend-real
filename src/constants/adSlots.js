const AD_SLOTS = Object.freeze([
  'HOME_728x90',
  'HOME_BILLBOARD_970x250',
  'HOME_LEFT_300x250',
  'HOME_LEFT_300x600',
  'HOME_RIGHT_300x250',
  'HOME_RIGHT_300x600',
  'HOME_RIGHT_RAIL',
  'ARTICLE_INLINE',
  'ARTICLE_END',
  'FOOTER_BANNER_728x90',
  'BREAKING_SPONSOR',
  'LIVE_UPDATE_SPONSOR',
]);

const REAL_TOGGLEABLE_AD_SLOTS = Object.freeze([
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
]);

const PACKAGE_AD_OPPORTUNITIES = Object.freeze([
  'SPONSORED_FEATURE',
  'SPONSORED_ARTICLE',
  'COMBO_CAMPAIGN',
]);

const TICKER_SPECIAL_AD_OPPORTUNITIES = Object.freeze([
  'BREAKING_TICKER_RED',
  'LIVE_UPDATES_TICKER_BLUE',
  'BREAKING_PAGE_SPONSOR_LINE',
]);

const CANONICAL_AD_OPPORTUNITIES = Object.freeze([
  ...REAL_TOGGLEABLE_AD_SLOTS,
  ...PACKAGE_AD_OPPORTUNITIES,
  ...TICKER_SPECIAL_AD_OPPORTUNITIES,
]);

const AD_OPPORTUNITY_ALIASES = Object.freeze({
  HOME_RIGHT_RAIL: 'HOME_RIGHT_300x250',
  SPONSORED_FEATURE_ARTICLE_COMBO: 'COMBO_CAMPAIGN',
});

const AD_SLOT_MEDIA_KIT_METADATA = Object.freeze({
  HOME_LEFT_300x250: Object.freeze({
    slot: 'HOME_LEFT_300x250',
    displayName: 'Home Left Rail 300×250',
    dimensions: '300x250',
    rateCard: Object.freeze({
      currency: 'INR',
      oneDay: 400,
      oneWeek: 2500,
      oneMonth: 8000,
    }),
  }),
  HOME_LEFT_300x600: Object.freeze({
    slot: 'HOME_LEFT_300x600',
    displayName: 'Home Left Rail 300×600 (Half Page)',
    dimensions: '300x600',
    rateCard: Object.freeze({
      currency: 'INR',
      oneDay: 700,
      oneWeek: 4500,
      oneMonth: 14000,
    }),
  }),
});

function buildSlotEnabledDefaults(defaultEnabled = true, overrides = null) {
  const out = {};
  for (const slot of AD_SLOTS) out[slot] = !!defaultEnabled;

  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [k, v] of Object.entries(overrides)) {
      if (AD_SLOTS.includes(k) && typeof v === 'boolean') out[k] = v;
    }
  }

  return out;
}

function normalizeAdOpportunityKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (CANONICAL_AD_OPPORTUNITIES.includes(raw)) return raw;
  if (AD_OPPORTUNITY_ALIASES[raw]) return AD_OPPORTUNITY_ALIASES[raw];

  const key = raw.replace(/[\s-]+/g, '_').toUpperCase();
  if (CANONICAL_AD_OPPORTUNITIES.includes(key)) return key;
  if (AD_OPPORTUNITY_ALIASES[key]) return AD_OPPORTUNITY_ALIASES[key];

  return null;
}

module.exports = {
  AD_SLOTS,
  REAL_TOGGLEABLE_AD_SLOTS,
  PACKAGE_AD_OPPORTUNITIES,
  TICKER_SPECIAL_AD_OPPORTUNITIES,
  CANONICAL_AD_OPPORTUNITIES,
  AD_OPPORTUNITY_ALIASES,
  AD_SLOT_MEDIA_KIT_METADATA,
  buildSlotEnabledDefaults,
  normalizeAdOpportunityKey,
};
