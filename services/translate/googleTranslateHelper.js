// Server-side helper wrapper around Google Translate v2.
// Uses GOOGLE_TRANSLATE_API_KEY only; never expose this client-side.

const { translateMany } = require('../googleTranslate.service');

async function translateText(text, targetLang, options = {}) {
  const res = await translateMany([String(text ?? '')], targetLang, options);
  if (!res || res.ok !== true) {
    return { ok: false, text: null, error: res && res.error ? res.error : 'Translate failed' };
  }
  return { ok: true, text: res.items && res.items[0] ? res.items[0] : '' };
}

module.exports = {
  translateMany,
  translateText,
};
