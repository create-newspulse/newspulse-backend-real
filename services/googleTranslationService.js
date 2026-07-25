const crypto = require('node:crypto');
const {
  applyProtectedTermsPre,
  applyProtectedTermsPost,
  enforceProtectedTermsPostFix,
  getAbbreviationsList,
} = require('./translate/protectedTerms');

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(primary) ? primary : null;
}

function validateGoogleTranslationConfig() {
  const configured = Boolean(String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim());
  return {
    ok: configured,
    configured,
    provider: 'google_translate',
    message: configured ? 'Google Translation configured' : 'GOOGLE_TRANSLATE_API_KEY is not configured',
  };
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function protectByRegex(text, regex, prefix) {
  let index = 0;
  const map = new Map();
  const out = String(text || '').replace(regex, (match) => {
    const token = `__NP_${prefix}_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text: out, map };
}

function restoreMap(text, map) {
  let out = String(text || '');
  for (const [token, value] of map.entries()) out = out.split(token).join(value);
  return out;
}

function protectHtmlAttributes(text) {
  return protectByRegex(String(text || ''), /\s(?:href|src|alt|title|class|id|style|data-[\w-]+)=("[^"]*"|'[^']*'|[^\s>]+)/gi, 'ATTR');
}

function protectCommonTokens(text) {
  let current = String(text || '');
  const maps = [];
  for (const [regex, prefix] of [
    [/\b(?:https?:\/\/|www\.)[^\s<>'"]+/gi, 'URL'],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'EMAIL'],
    [/(^|\s)#[\p{L}\p{N}_-]+/gu, 'HASH'],
  ]) {
    const protectedResult = protectByRegex(current, regex, prefix);
    current = protectedResult.text;
    maps.push(protectedResult.map);
  }

  const abbr = getAbbreviationsList();
  if (abbr.length) {
    let i = 0;
    const map = new Map();
    for (const term of abbr.slice().sort((a, b) => b.length - a.length)) {
      const source = String(term || '').trim();
      if (!source) continue;
      const rx = new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const token = `__NP_ABBR_${i}__`;
      if (rx.test(current)) {
        rx.lastIndex = 0;
        current = current.replace(rx, token);
        map.set(token, source);
        i += 1;
      }
    }
    maps.push(map);
  }

  return { text: current, maps };
}

function protectText(text, { html = false } = {}) {
  const pre = applyProtectedTermsPre(String(text || ''));
  let current = pre.text;
  const maps = [];
  if (html) {
    const attrs = protectHtmlAttributes(current);
    current = attrs.text;
    maps.push(attrs.map);
  }
  const common = protectCommonTokens(current);
  current = common.text;
  maps.push(...common.maps);
  return { text: current, protectedTerms: pre.tokenMap, maps };
}

function restoreText(text, protection, targetLang) {
  let out = decodeHtmlEntities(text);
  for (const map of [...(protection?.maps || [])].reverse()) out = restoreMap(out, map);
  out = applyProtectedTermsPost(out, protection?.protectedTerms, targetLang);
  out = enforceProtectedTermsPostFix(out, targetLang);
  return out;
}

function splitHtmlIntoChunks(html, maxChars = 4500) {
  const raw = String(html || '');
  if (raw.length <= maxChars) return raw ? [raw] : [];
  const blocks = raw.match(/<\/(?:p|h[1-6]|li|blockquote|ul|ol|div)>|[^<]+|<[^>]+>/gi) || [raw];
  const chunks = [];
  let current = '';

  for (const block of blocks) {
    if ((current + block).length <= maxChars) {
      current += block;
      continue;
    }
    if (current.trim()) chunks.push(current);
    if (block.length <= maxChars) {
      current = block;
    } else {
      for (let i = 0; i < block.length; i += maxChars) chunks.push(block.slice(i, i + maxChars));
      current = '';
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function splitTextIntoChunks(text, maxChars = 4500) {
  const raw = String(text || '');
  if (raw.length <= maxChars) return raw ? [raw] : [];
  const parts = raw.split(/(?<=[.!?।])\s+|\n{2,}/g);
  const chunks = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current} ${part}` : part;
    if (next.length <= maxChars) current = next;
    else {
      if (current.trim()) chunks.push(current);
      current = part.length <= maxChars ? part : '';
      if (!current) for (let i = 0; i < part.length; i += maxChars) chunks.push(part.slice(i, i + maxChars));
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function isRetryableStatus(status) {
  const n = Number(status);
  return n === 429 || (n >= 500 && n <= 599);
}

async function translateBatch(texts, targetLang, options = {}) {
  const target = normalizeLang(targetLang);
  const source = normalizeLang(options.sourceLang || options.sourceLanguage);
  const arr = Array.isArray(texts) ? texts.map((item) => String(item ?? '')) : [];
  if (!target) return { ok: false, error: 'Missing target language' };
  if (!arr.length) return { ok: true, items: [] };

  const apiKey = String(options.apiKey || process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'Google Translation is not configured' };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available' };

  const format = options.format === 'html' ? 'html' : 'text';
  const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Number(options.maxRetries) : 2;
  let attempt = 0;
  let lastError = 'Translate failed';

  while (attempt <= maxRetries) {
    try {
      const res = await fetchImpl(`${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: arr, target, ...(source ? { source } : {}), format }),
        signal: options.signal,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        lastError = `Translate failed: HTTP_${res.status}`;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          attempt += 1;
          continue;
        }
        const providerMessage = json?.error?.message ? String(json.error.message).slice(0, 160) : lastError;
        return { ok: false, error: providerMessage.replace(apiKey, '[redacted]') };
      }
      const translations = json?.data && Array.isArray(json.data.translations) ? json.data.translations : null;
      if (!translations || translations.length !== arr.length) return { ok: false, error: 'Translate failed: unexpected response shape' };
      return { ok: true, items: translations.map((item) => decodeHtmlEntities(item?.translatedText || '')) };
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'Translate failed: timeout' : 'Translate failed: network error';
      if (attempt >= maxRetries) return { ok: false, error: lastError };
      attempt += 1;
    }
  }

  return { ok: false, error: lastError };
}

async function translateText(text, sourceLang, targetLang, options = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: true, text: raw };
  const html = options.format === 'html';
  const chunks = html ? splitHtmlIntoChunks(raw, options.maxChars) : splitTextIntoChunks(raw, options.maxChars);
  const protectedChunks = chunks.map((chunk) => protectText(chunk, { html }));
  const res = await translateBatch(protectedChunks.map((chunk) => chunk.text), targetLang, {
    ...options,
    sourceLang,
    format: html ? 'html' : 'text',
  });
  if (!res.ok) return res;
  const restored = res.items.map((item, index) => restoreText(item, protectedChunks[index], targetLang));
  return { ok: true, text: restored.join('') };
}

async function detectLanguage(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'Missing text' };
  const apiKey = String(options.apiKey || process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'Google Translation is not configured' };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available' };

  const res = await fetchImpl(`${GOOGLE_TRANSLATE_ENDPOINT}/detect?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: raw }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: `Detect failed: HTTP_${res.status}` };
  const first = Array.isArray(json?.data?.detections?.[0]) ? json.data.detections[0][0] : null;
  const lang = normalizeLang(first?.language);
  return lang ? { ok: true, lang, confidence: first?.confidence } : { ok: false, error: 'Detect failed: unsupported language' };
}

module.exports = {
  normalizeLang,
  validateGoogleTranslationConfig,
  stableHash,
  splitHtmlIntoChunks,
  splitTextIntoChunks,
  translateBatch,
  translateText,
  detectLanguage,
};