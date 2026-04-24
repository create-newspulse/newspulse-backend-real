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

module.exports = {
  AD_SLOTS,
  AD_SLOT_MEDIA_KIT_METADATA,
  buildSlotEnabledDefaults,
};
