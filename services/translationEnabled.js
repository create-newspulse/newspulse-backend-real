function _isFalseyFlag(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['0', 'false', 'no', 'off'].includes(s);
}

function isTranslationEnabled() {
  // Default: enabled unless explicitly disabled.
  if (process.env.TRANSLATION_ENABLED === undefined || process.env.TRANSLATION_ENABLED === null || String(process.env.TRANSLATION_ENABLED).trim() === '') {
    return true;
  }
  return !_isFalseyFlag(process.env.TRANSLATION_ENABLED);
}

function hasGoogleTranslateApiKey() {
  return Boolean(String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim());
}

function isGoogleTranslateConfigured() {
  return isTranslationEnabled() && hasGoogleTranslateApiKey();
}

module.exports = {
  isTranslationEnabled,
  hasGoogleTranslateApiKey,
  isGoogleTranslateConfigured,
};
