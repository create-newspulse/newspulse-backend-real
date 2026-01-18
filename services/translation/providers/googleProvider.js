function _isConfigured() {
  return Boolean(String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim());
}

async function translate({ text, sourceLang, targetLang }) {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, engine: 'GOOGLE', status: 'BLOCKED', reasons: ['MISSING_GOOGLE_TRANSLATE_API_KEY'] };
  }

  const q = String(text || '');
  const from = String(sourceLang || '').trim().toLowerCase();
  const to = String(targetLang || '').trim().toLowerCase();

  // Google Translate v2
  const url = new URL('https://translation.googleapis.com/language/translate/v2');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', q);
  url.searchParams.set('source', from);
  url.searchParams.set('target', to);
  url.searchParams.set('format', 'text');

  try {
    const res = await fetch(url.toString(), { method: 'POST' });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, engine: 'GOOGLE', status: 'BLOCKED', reasons: ['GOOGLE_HTTP_ERROR'], details: json || null };
    }

    const translatedText = json && json.data && Array.isArray(json.data.translations)
      ? String(json.data.translations[0]?.translatedText || '')
      : '';

    if (!translatedText.trim()) {
      return { ok: false, engine: 'GOOGLE', status: 'BLOCKED', reasons: ['GOOGLE_EMPTY_OUTPUT'] };
    }

    return { ok: true, engine: 'GOOGLE', text: translatedText };
  } catch (e) {
    return { ok: false, engine: 'GOOGLE', status: 'BLOCKED', reasons: ['GOOGLE_NETWORK_ERROR'], details: e?.message || String(e) };
  }
}

module.exports = {
  name: 'GOOGLE',
  isConfigured: _isConfigured,
  translate,
};
