const crypto = require('node:crypto');

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function decodeHtmlEntities(s) {
  // Google Translate v2 can return HTML-escaped strings.
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

/**
 * Translate many strings using Google Translate API v2.
 *
 * @param {string[]} texts
 * @param {string} targetLang - e.g. en|hi
 * @param {{ apiKey?: string, fetchImpl?: any, chunkSize?: number }} [options]
 * @returns {Promise<{ ok: true, items: string[] } | { ok: false, error: string }>} 
 */
async function translateMany(texts, targetLang, options = {}) {
  const arr = Array.isArray(texts) ? texts.map(t => String(t ?? '')).filter(t => t.trim()) : [];
  const lang = String(targetLang || '').trim().toLowerCase();
  if (!arr.length) return { ok: true, items: [] };
  if (!lang) return { ok: false, error: 'Missing targetLang' };

  const sourceLangRaw = String(options.sourceLang || options.source || '').trim().toLowerCase();
  const sourceLang = sourceLangRaw ? sourceLangRaw.split(/[-_]/)[0] : '';

  const apiKey = options.apiKey || process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing GOOGLE_TRANSLATE_API_KEY' };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available' };

  const chunkSize = Number.isFinite(Number(options.chunkSize)) ? Number(options.chunkSize) : 50;
  const formatRaw = String(options.format || '').trim().toLowerCase();
  const format = formatRaw === 'html' ? 'html' : 'text';

  const out = [];
  for (const part of chunk(arr, chunkSize)) {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: part, target: lang, ...(sourceLang ? { source: sourceLang } : {}), format }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : `HTTP_${res.status}`;
      return { ok: false, error: `Translate failed: ${msg}` };
    }

    const translations = json && json.data && Array.isArray(json.data.translations) ? json.data.translations : null;
    if (!translations || translations.length !== part.length) {
      return { ok: false, error: 'Translate failed: unexpected response shape' };
    }

    for (const t of translations) out.push(decodeHtmlEntities(t && t.translatedText));
  }

  return { ok: true, items: out };
}

/**
 * Detect language of a single string using Google Translate API v2.
 *
 * @param {string} text
 * @param {{ apiKey?: string, fetchImpl?: any }} [options]
 * @returns {Promise<{ ok: true, lang: string, confidence?: number } | { ok: false, error: string }>}
 */
async function detectLanguage(text, options = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'Missing text' };

  const apiKey = options.apiKey || process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing GOOGLE_TRANSLATE_API_KEY' };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available' };

  const url = `https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: t }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json && json.error && json.error.message ? json.error.message : `HTTP_${res.status}`;
    return { ok: false, error: `Detect failed: ${msg}` };
  }

  const detections = json && json.data && Array.isArray(json.data.detections) ? json.data.detections : null;
  const first = detections && Array.isArray(detections[0]) ? detections[0][0] : null;
  const lang = first && typeof first.language === 'string' ? String(first.language).trim().toLowerCase() : null;
  if (!lang) return { ok: false, error: 'Detect failed: unexpected response shape' };

  const confidence = typeof first.confidence === 'number' ? first.confidence : undefined;
  return { ok: true, lang, ...(confidence !== undefined ? { confidence } : {}) };
}

module.exports = {
  translateMany,
  detectLanguage,
  stableHash,
};
