const AD_SLOTS = Object.freeze([
  'HOME_728x90',
  'HOME_RIGHT_300x250',
  'HOME_RIGHT_RAIL',
  'ARTICLE_INLINE',
  'ARTICLE_END',
  'FOOTER_BANNER_728x90',
]);

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
  buildSlotEnabledDefaults,
};
