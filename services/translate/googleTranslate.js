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

function _protectByRegex(text, regex, prefix) {
  const s = String(text || '');
  const map = new Map();
  let i = 0;
  const out = s.replace(regex, (m) => {
    const token = `__${prefix}_${i}__`;
    i++;
    map.set(token, m);
    return token;
  });
  return { text: out, map };
}

function _restore(text, map) {
  let out = String(text || '');
  for (const [token, value] of (map || new Map()).entries()) {
    out = out.split(token).join(value);
  }
  return out;
}

async function translate(text, sourceLang, targetLang) {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const raw = String(text || '').trim();

  const source = _normalizeLang(sourceLang);
  const target = _normalizeLang(targetLang);

  if (!apiKey) return null;
  if (!raw) return null;
  if (!source || !target) return null;
  if (source === target) return raw;
  if (typeof fetch !== 'function') return null;

  // Never translate URLs/emails; keep numbers/currency/percentages/dates stable.
  const urlRx = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
  const emailRx = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const numericRx = /(?:₹|\$|€|£)?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?%\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g;

  const { text: t0, map: urlMap } = _protectByRegex(raw, urlRx, 'URL');
  const { text: t1, map: emailMap } = _protectByRegex(t0, emailRx, 'EMAIL');
  const { text: q, map: numMap } = _protectByRegex(t1, numericRx, 'NUM');

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
    if (!cleaned) return null;

    const restored = _restore(_restore(_restore(cleaned, numMap), emailMap), urlMap).trim();
    return restored ? restored : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  translate,
};
