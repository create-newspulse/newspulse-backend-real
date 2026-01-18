function _isConfigured() {
  return Boolean(String(process.env.MICROSOFT_TRANSLATOR_KEY || '').trim()) &&
    Boolean(String(process.env.MICROSOFT_TRANSLATOR_REGION || '').trim());
}

async function translate({ text, sourceLang, targetLang }) {
  const key = String(process.env.MICROSOFT_TRANSLATOR_KEY || '').trim();
  const region = String(process.env.MICROSOFT_TRANSLATOR_REGION || '').trim();
  if (!key) {
    return { ok: false, engine: 'MICROSOFT', status: 'BLOCKED', reasons: ['MISSING_MICROSOFT_TRANSLATOR_KEY'] };
  }
  if (!region) {
    return { ok: false, engine: 'MICROSOFT', status: 'BLOCKED', reasons: ['MISSING_MICROSOFT_TRANSLATOR_REGION'] };
  }

  const from = String(sourceLang || '').trim().toLowerCase();
  const to = String(targetLang || '').trim().toLowerCase();
  const q = String(text || '');

  const url = new URL('https://api.cognitive.microsofttranslator.com/translate');
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
      },
      body: JSON.stringify([{ Text: q }]),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, engine: 'MICROSOFT', status: 'BLOCKED', reasons: ['MICROSOFT_HTTP_ERROR'], details: json || null };
    }

    const translatedText = Array.isArray(json)
      ? String(json[0]?.translations?.[0]?.text || '')
      : '';

    if (!translatedText.trim()) {
      return { ok: false, engine: 'MICROSOFT', status: 'BLOCKED', reasons: ['MICROSOFT_EMPTY_OUTPUT'] };
    }

    return { ok: true, engine: 'MICROSOFT', text: translatedText };
  } catch (e) {
    return { ok: false, engine: 'MICROSOFT', status: 'BLOCKED', reasons: ['MICROSOFT_NETWORK_ERROR'], details: e?.message || String(e) };
  }
}

module.exports = {
  name: 'MICROSOFT',
  isConfigured: _isConfigured,
  translate,
};
