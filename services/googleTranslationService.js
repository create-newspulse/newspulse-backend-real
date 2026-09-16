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

const FACEBOOK_ALLOWED_HOSTS = new Set(['facebook.com', 'www.facebook.com']);
const FACEBOOK_SHARE_REDIRECT_HOPS = 3;

function isValidFacebookPageOrUser(value) {
  const segment = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,74}$/.test(segment)) return false;
  return !new Set([
    'checkpoint',
    'events',
    'explore',
    'groups',
    'login',
    'marketplace',
    'permalink.php',
    'profile.php',
    'stories',
    'watch',
  ]).has(segment.toLowerCase());
}

function isValidFacebookPostId(value) {
  return /^(?:[1-9]\d{4,30}|pfbid[A-Za-z0-9_-]{10,120})$/.test(String(value || ''));
}

function isValidFacebookReelId(value) {
  return /^[1-9]\d{4,30}$/.test(String(value || ''));
}

function isValidFacebookShareToken(value) {
  return /^[A-Za-z0-9_-]{4,128}$/.test(String(value || ''));
}

function isAllowedFacebookUrlObject(url) {
  return url && url.protocol === 'https:' && FACEBOOK_ALLOWED_HOSTS.has(String(url.hostname || '').toLowerCase());
}

function normalizeFacebookCanonicalUrl(value) {
  const raw = decodeHtmlEntities(String(value || ''));
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (!isAllowedFacebookUrlObject(url)) return null;
    if (url.hash) return null;

    if (url.pathname === '/permalink.php') {
      const storyFbid = url.searchParams.get('story_fbid');
      const id = url.searchParams.get('id');
      if (!isValidFacebookPostId(storyFbid) || !/^[1-9]\d{4,30}$/.test(String(id || ''))) return null;
      const params = new URLSearchParams({ story_fbid: storyFbid, id });
      return `https://www.facebook.com/permalink.php?${params.toString()}`;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2 && parts[0] === 'reel' && isValidFacebookReelId(parts[1])) {
      return `https://www.facebook.com/reel/${parts[1]}`;
    }

    if (parts.length === 3 && parts[1] === 'posts' && isValidFacebookPageOrUser(parts[0]) && isValidFacebookPostId(parts[2])) {
      return `https://www.facebook.com/${parts[0]}/posts/${parts[2]}`;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function getFacebookShareReelToken(value) {
  const raw = decodeHtmlEntities(String(value || ''));
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (!isAllowedFacebookUrlObject(url)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'share' || parts[1] !== 'r') return null;
    return isValidFacebookShareToken(parts[2]) ? parts[2] : null;
  } catch (_) {
    return null;
  }
}

function getRedirectLocation(res) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === 'function') return res.headers.get('location');
  return res.headers.location || res.headers.Location || null;
}

async function resolveFacebookShareUrl(value, options = {}) {
  const token = getFacebookShareReelToken(value);
  if (!token) return { ok: false, error: 'INVALID_FACEBOOK_SHARE_URL' };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'FETCH_UNAVAILABLE' };

  let current = `https://www.facebook.com/share/r/${token}/`;
  const maxRedirects = Number.isFinite(Number(options.maxRedirects)) ? Number(options.maxRedirects) : FACEBOOK_SHARE_REDIRECT_HOPS;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let currentUrl;
    try {
      currentUrl = new URL(current);
    } catch (_) {
      return { ok: false, error: 'UNSAFE_FACEBOOK_REDIRECT' };
    }
    if (!isAllowedFacebookUrlObject(currentUrl)) return { ok: false, error: 'UNSAFE_FACEBOOK_REDIRECT' };

    const canonical = normalizeFacebookCanonicalUrl(current);
    if (canonical) return { ok: true, url: canonical };

    if (!getFacebookShareReelToken(current)) return { ok: false, error: 'UNSUPPORTED_FACEBOOK_SHARE_DESTINATION' };

    if (hop >= maxRedirects) return { ok: false, error: 'FACEBOOK_REDIRECT_LIMIT_EXCEEDED' };

    let res;
    try {
      res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: options.signal });
    } catch (_) {
      return { ok: false, error: 'FACEBOOK_SHARE_RESOLVE_FAILED' };
    }

    const status = Number(res?.status || 0);
    if (status < 300 || status > 399) return { ok: false, error: 'UNSUPPORTED_FACEBOOK_SHARE_DESTINATION' };
    const location = getRedirectLocation(res);
    if (!location) return { ok: false, error: 'UNSUPPORTED_FACEBOOK_SHARE_DESTINATION' };

    let next;
    try {
      next = new URL(location, current);
    } catch (_) {
      return { ok: false, error: 'UNSAFE_FACEBOOK_REDIRECT' };
    }
    if (!isAllowedFacebookUrlObject(next)) return { ok: false, error: 'UNSAFE_FACEBOOK_REDIRECT' };
    current = next.toString();
  }

  return { ok: false, error: 'FACEBOOK_REDIRECT_LIMIT_EXCEEDED' };
}

function isSupportedFacebookUrl(value) {
  return Boolean(normalizeFacebookCanonicalUrl(value));
}

function isControlledFacebookBlockOpening(opening) {
  const block = getHtmlAttribute(opening, 'data-np-block');
  if (block !== 'facebook') return false;
  return isSupportedFacebookUrl(getHtmlAttribute(opening, 'data-np-url'));
}

function getOpeningTag(markup, tagName) {
  const rx = new RegExp(`^<${tagName}\\b[^>]*>`, 'i');
  return String(markup || '').match(rx)?.[0] || '';
}

function getControlledInlineImageMediaId(opening) {
  const tag = String(opening || '');
  const hasCanonicalMarker = /\sdata-np-block\s*=\s*(['"])inline-image\1/i.test(tag) && /\sdata-np-media-id\s*=\s*(['"])[^'"]+\1/i.test(tag);
  if (hasCanonicalMarker) return getHtmlAttribute(tag, 'data-np-media-id');
  const hasLegacyDevelopmentMarker = /\sdata-np-inline-image\s*=\s*(['"])true\1/i.test(tag) && /\sdata-media-id\s*=\s*(['"])[^'"]+\1/i.test(tag);
  if (hasLegacyDevelopmentMarker) return getHtmlAttribute(tag, 'data-media-id');
  const hasPhaseOneDraftMarker = /\sdata-np-block\s*=\s*(['"])image\1/i.test(tag) && /\sdata-media-id\s*=\s*(['"])[^'"]+\1/i.test(tag);
  if (hasPhaseOneDraftMarker) return getHtmlAttribute(tag, 'data-media-id');
  return null;
}

function isControlledInlineImageOpening(opening) {
  return getControlledInlineImageMediaId(opening) !== null;
}

function isControlledGalleryInlineImageFigure(figure) {
  const raw = String(figure || '');
  const opening = getOpeningTag(raw, 'figure');
  if (!opening || !/<\/figure>$/i.test(raw)) return false;
  return isControlledInlineImageOpening(opening);
}

function findMatchingDivEnd(html, startIndex) {
  const rx = /<div\b[^>]*>|<\/div\s*>/gi;
  rx.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = rx.exec(html))) {
    if (/^<div\b/i.test(match[0])) depth += 1;
    else depth -= 1;
    if (depth === 0) return rx.lastIndex;
  }
  return -1;
}

function isControlledGalleryBlock(block) {
  const raw = String(block || '');
  const opening = getOpeningTag(raw, 'div');
  if (!opening || getHtmlAttribute(opening, 'data-np-block') !== 'gallery') return false;
  if (/<(?:script|iframe|embed|object)\b/i.test(raw)) return false;
  const closeStart = raw.lastIndexOf('</div>');
  if (closeStart <= opening.length) return false;

  const figures = [];
  let cursor = opening.length;
  while (cursor < closeStart) {
    const whitespace = raw.slice(cursor, closeStart).match(/^\s*/)?.[0] || '';
    cursor += whitespace.length;
    if (cursor >= closeStart) break;
    const rest = raw.slice(cursor, closeStart);
    const figureOpening = rest.match(/^<figure\b[^>]*>/i)?.[0] || '';
    if (!figureOpening) return false;
    const figureEnd = raw.indexOf('</figure>', cursor);
    if (figureEnd === -1 || figureEnd + '</figure>'.length > closeStart) return false;
    const figure = raw.slice(cursor, figureEnd + '</figure>'.length);
    if (/<figure\b/i.test(figure.slice(figureOpening.length))) return false;
    figures.push(figure);
    cursor = figureEnd + '</figure>'.length;
  }

  if (figures.length < 2 || figures.length > 20) return false;
  const mediaIds = new Set();
  for (const figure of figures) {
    if (!isControlledGalleryInlineImageFigure(figure)) return false;
    const mediaId = getControlledInlineImageMediaId(getOpeningTag(figure, 'figure'));
    if (mediaIds.has(mediaId)) return false;
    mediaIds.add(mediaId);
  }
  return true;
}

function protectNewsPulseInlineImageBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (match) => {
    const opening = match.match(/^<figure\b[^>]*>/i)?.[0] || '';
    if (!isControlledInlineImageOpening(opening)) return match;
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

function protectNewsPulseFacebookBlocks(html) {
  let index = 0;
  const map = new Map();
  const text = String(html || '').replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (match) => {
    const opening = match.match(/^<div\b[^>]*>/i)?.[0] || '';
    if (!isControlledFacebookBlockOpening(opening)) return match;
    const token = `__NP_FACEBOOK_BLOCK_${index}__`;
    index += 1;
    map.set(token, match);
    return token;
  });
  return { text, map };
}

function protectNewsPulseGalleryBlocks(html) {
  const raw = String(html || '');
  let index = 0;
  let lastIndex = 0;
  let text = '';
  const map = new Map();
  const openingRx = /<div\b[^>]*>/gi;
  let match;

  while ((match = openingRx.exec(raw))) {
    const opening = match[0];
    if (getHtmlAttribute(opening, 'data-np-block') !== 'gallery') continue;
    const end = findMatchingDivEnd(raw, match.index);
    if (end === -1) continue;
    const block = raw.slice(match.index, end);
    if (!isControlledGalleryBlock(block)) {
      openingRx.lastIndex = match.index + opening.length;
      continue;
    }
    const token = `__NP_GALLERY_BLOCK_${index}__`;
    index += 1;
    map.set(token, block);
    text += raw.slice(lastIndex, match.index) + token;
    lastIndex = end;
    openingRx.lastIndex = end;
  }

  text += raw.slice(lastIndex);
  return { text, map };
}

function protectNewsPulseControlledMediaBlocks(html) {
  const galleries = protectNewsPulseGalleryBlocks(html);
  const inlineImages = protectNewsPulseInlineImageBlocks(galleries.text);
  const youtubeBlocks = protectNewsPulseYouTubeBlocks(inlineImages.text);
  const xBlocks = protectNewsPulseXBlocks(youtubeBlocks.text);
  const instagramBlocks = protectNewsPulseInstagramBlocks(xBlocks.text);
  const facebookBlocks = protectNewsPulseFacebookBlocks(instagramBlocks.text);
  return {
    text: facebookBlocks.text,
    maps: [facebookBlocks.map, instagramBlocks.map, xBlocks.map, youtubeBlocks.map, inlineImages.map, galleries.map],
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
  protectNewsPulseFacebookBlocks,
  protectNewsPulseGalleryBlocks,
  protectNewsPulseControlledMediaBlocks,
  normalizeFacebookCanonicalUrl,
  resolveFacebookShareUrl,
  splitHtmlIntoChunks,
  splitTextIntoChunks,
  translateBatch,
  translateText,
  detectLanguage,
};