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

function getHtmlAttribute(opening, name) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(opening || '').match(rx);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

function isValidYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || '').trim());
}

function getYouTubeVideoIdFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^(?:https?:)?\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      if (url.pathname.startsWith('/embed/') || url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/').filter(Boolean)[1] || null;
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

function isSupportedYouTubeUrlForVideoId(value, videoId) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const parsedVideoId = getYouTubeVideoIdFromUrl(raw);
  return parsedVideoId === String(videoId || '').trim() && isValidYouTubeVideoId(parsedVideoId);
}

function isControlledYouTubeBlockOpening(opening) {
  const block = getHtmlAttribute(opening, 'data-np-block');
  if (String(block || '').trim() !== 'youtube') return false;
  const videoId = getHtmlAttribute(opening, 'data-np-video-id');
  if (!isValidYouTubeVideoId(videoId)) return false;
  return isSupportedYouTubeUrlForVideoId(getHtmlAttribute(opening, 'data-np-url'), videoId);
}

function isValidXPostId(value) {
  return /^[1-9]\d{0,19}$/.test(String(value || ''));
}

function getXPostIdFromUrl(value) {
  const raw = String(value || '');
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[1] !== 'status') return null;
    return parts[2];
  } catch (_) {
    return null;
  }
}

function isSupportedXUrlForPostId(value, postId) {
  const parsedPostId = getXPostIdFromUrl(value);
  return parsedPostId === String(postId || '') && isValidXPostId(parsedPostId);
}

function isControlledXBlockOpening(opening) {
  const block = getHtmlAttribute(opening, 'data-np-block');
  if (block !== 'x') return false;
  const postId = getHtmlAttribute(opening, 'data-np-post-id');
  if (!isValidXPostId(postId)) return false;
  return isSupportedXUrlForPostId(getHtmlAttribute(opening, 'data-np-url'), postId);
}

function isValidInstagramShortcode(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(String(value || ''));
}

function getInstagramShortcodeFromUrl(value) {
  const raw = String(value || '');
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (!['instagram.com', 'www.instagram.com'].includes(host)) return null;
    if (url.hash) return null;
    const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)\/$/);
    if (!match) return null;
    const shortcode = match[2];
    return isValidInstagramShortcode(shortcode) ? shortcode : null;
  } catch (_) {
    return null;
  }
}

function isSupportedInstagramUrlForShortcode(value, shortcode) {
  const parsedShortcode = getInstagramShortcodeFromUrl(value);
  return parsedShortcode === String(shortcode || '') && isValidInstagramShortcode(parsedShortcode);
}

function isControlledInstagramBlockOpening(opening) {
  const block = getHtmlAttribute(opening, 'data-np-block');
  if (block !== 'instagram') return false;
  const shortcode = getHtmlAttribute(opening, 'data-np-shortcode');
  if (!isValidInstagramShortcode(shortcode)) return false;
  return isSupportedInstagramUrlForShortcode(getHtmlAttribute(opening, 'data-np-url'), shortcode);
}

function protectNewsPulseInlineImageBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (match) => {
    const opening = match.match(/^<figure\b[^>]*>/i)?.[0] || '';
    const hasCanonicalMarker = /\sdata-np-block\s*=\s*(['"])inline-image\1/i.test(opening) && /\sdata-np-media-id\s*=\s*(['"])[^'"]+\1/i.test(opening);
    const hasLegacyDevelopmentMarker = /\sdata-np-inline-image\s*=\s*(['"])true\1/i.test(opening) && /\sdata-media-id\s*=\s*(['"])[^'"]+\1/i.test(opening);
    const hasPhaseOneDraftMarker = /\sdata-np-block\s*=\s*(['"])image\1/i.test(opening) && /\sdata-media-id\s*=\s*(['"])[^'"]+\1/i.test(opening);
    const isControlled = hasCanonicalMarker || hasLegacyDevelopmentMarker || hasPhaseOneDraftMarker;
    if (!isControlled) return match;
    const token = `__NP_INLINE_IMAGE_BLOCK_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text, map };
}

function protectNewsPulseYouTubeBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (match) => {
    const opening = match.match(/^<div\b[^>]*>/i)?.[0] || '';
    if (!isControlledYouTubeBlockOpening(opening)) return match;
    const token = `__NP_YOUTUBE_BLOCK_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text, map };
}

function protectNewsPulseXBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (match) => {
    const opening = match.match(/^<div\b[^>]*>/i)?.[0] || '';
    if (!isControlledXBlockOpening(opening)) return match;
    const token = `__NP_X_BLOCK_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text, map };
}

function protectNewsPulseInstagramBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (match) => {
    const opening = match.match(/^<div\b[^>]*>/i)?.[0] || '';
    if (!isControlledInstagramBlockOpening(opening)) return match;
    const token = `__NP_INSTAGRAM_BLOCK_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text, map };
}

function protectNewsPulseControlledMediaBlocks(html) {
  const inlineImages = protectNewsPulseInlineImageBlocks(html);
  const youtubeBlocks = protectNewsPulseYouTubeBlocks(inlineImages.text);
  const xBlocks = protectNewsPulseXBlocks(youtubeBlocks.text);
  const instagramBlocks = protectNewsPulseInstagramBlocks(xBlocks.text);
  return {
    text: instagramBlocks.text,
    maps: [instagramBlocks.map, xBlocks.map, youtubeBlocks.map, inlineImages.map],
  };
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
  const controlledMedia = html ? protectNewsPulseControlledMediaBlocks(raw) : { text: raw, maps: [] };
  const chunks = html ? splitHtmlIntoChunks(controlledMedia.text, options.maxChars) : splitTextIntoChunks(raw, options.maxChars);
  const protectedChunks = chunks.map((chunk) => protectText(chunk, { html }));
  const res = await translateBatch(protectedChunks.map((chunk) => chunk.text), targetLang, {
    ...options,
    sourceLang,
    format: html ? 'html' : 'text',
  });
  if (!res.ok) return res;
  const restored = res.items.map((item, index) => restoreText(item, protectedChunks[index], targetLang));
  const restoredHtml = html
    ? [...controlledMedia.maps].reverse().reduce((out, map) => restoreMap(out, map), restored.join(''))
    : restored.join('');
  return { ok: true, text: restoredHtml };
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
  protectNewsPulseInlineImageBlocks,
  protectNewsPulseYouTubeBlocks,
  protectNewsPulseXBlocks,
  protectNewsPulseInstagramBlocks,
  protectNewsPulseControlledMediaBlocks,
  splitHtmlIntoChunks,
  splitTextIntoChunks,
  translateBatch,
  translateText,
  detectLanguage,
};