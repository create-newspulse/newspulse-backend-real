const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

function _normalizeLang(v) {
  const s = String(v || '').trim().toLowerCase();
  return (s === 'en' || s === 'hi' || s === 'gu') ? s : null;
}

function _decodeBasicEntities(s) {
  // Google Translate often returns HTML entities even for format:"text".
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function translate(text, sourceLang, targetLang) {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const q = String(text || '').trim();

  const source = _normalizeLang(sourceLang);
  const target = _normalizeLang(targetLang);

  if (!apiKey) return null;
  if (!q) return null;
  if (!source || !target) return null;
  if (source === target) return q;
  if (typeof fetch !== 'function') return null;

  const url = `${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: [q], source, target, format: 'text' }),
    });

    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    const translated = data && data.data && data.data.translations && data.data.translations[0]
      ? data.data.translations[0].translatedText
      : null;

    if (typeof translated !== 'string') return null;
    const cleaned = _decodeBasicEntities(translated).trim();
    return cleaned ? cleaned : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  translate,
};
