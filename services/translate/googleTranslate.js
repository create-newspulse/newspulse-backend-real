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

function _normalizeDigitsToAscii(s) {
  // Convert common localized digit sets to ASCII digits.
  // (Prevents Gujarati/Devanagari numerals from leaking to UI.)
  const str = String(s || '');
  const map = {
    // Devanagari ०..९
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
    // Gujarati ૦..૯
    '૦': '0', '૧': '1', '૨': '2', '૩': '3', '૪': '4', '૫': '5', '૬': '6', '૭': '7', '૮': '8', '૯': '9',
    // Arabic-Indic ٠..٩
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    // Eastern Arabic-Indic ۰..۹
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };
  return str.replace(/[०-९૦-૯٠-٩۰-۹]/g, (ch) => map[ch] || ch);
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

function _restoreNumericTokensFuzzy(text, numMap) {
  let out = String(text || '');
  // First pass: exact replacement.
  out = _restore(out, numMap);

  // Second pass: attempt to recover if Google altered token shape.
  // Example seen in wild: "__NUM__NUM_NUM_5__" or "__NUM_NUM_5__".
  out = out.replace(/__NUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = numMap && typeof numMap.get === 'function' ? numMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  // Some providers drop the leading "__" while keeping the trailing "__".
  out = out.replace(/\bNUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = numMap && typeof numMap.get === 'function' ? numMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  // Final safety: strip any remaining NUM tokens (should be impossible after restore).
  out = out.replace(/__NUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  out = out.replace(/\bNUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  // Some mangles drop the trailing "__" and concatenate with digits.
  out = out.replace(/__NUM\s*(?=\d)/g, '');
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
  const numericRx = /(?:₹|\$|€|£)?\d+(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?%\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g;

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

    const restoredNums = _restoreNumericTokensFuzzy(cleaned, numMap);
    const restored = _restore(_restore(restoredNums, emailMap), urlMap).trim();
    const normalizedDigits = _normalizeDigitsToAscii(restored).trim();
    return normalizedDigits ? normalizedDigits : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  translate,
};
