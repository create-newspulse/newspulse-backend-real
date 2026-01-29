const googleTranslate = require('./googleTranslate.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX = 10_000;

// key -> { exp, text }
const _cache = new Map();

function cacheTtlMs() {
  const v = Number(process.env.BROADCAST_TRANSLATION_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function cacheMax() {
  const v = Number(process.env.BROADCAST_TRANSLATION_CACHE_MAX);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX;
}

function _get(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  // LRU-ish bump
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.text;
}

function _set(key, text) {
  while (_cache.size >= cacheMax()) {
    const oldest = _cache.keys().next().value;
    if (!oldest) break;
    _cache.delete(oldest);
  }
  _cache.set(key, { exp: Date.now() + cacheTtlMs(), text: String(text || '') });
}

function buildTranslationCacheKey({ sourceLang, targetLang, text }) {
  const src = normalizeLang(sourceLang) || 'auto';
  const dst = normalizeLang(targetLang);
  const t = String(text || '').trim();
  if (!dst || !t) return null;
  return `${src}:${dst}:${googleTranslate.stableHash(t)}`;
}

async function translateTextCached({ text, sourceLang, targetLang, translator }) {
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  const raw = String(text || '').trim();

  if (!raw || !dst) return null;
  if (src && dst && src === dst) return raw;

  const key = buildTranslationCacheKey({ sourceLang: src || 'auto', targetLang: dst, text: raw });
  if (key) {
    const cached = _get(key);
    if (typeof cached === 'string' && cached.trim()) return cached;
  }

  if (typeof translator !== 'function') return null;

  const r = await translator(raw, src || 'auto', dst);
  const out = r && r.ok && typeof r.text === 'string' && r.text.trim() ? String(r.text).trim() : null;
  if (out && key) _set(key, out);
  return out;
}

async function buildTextI18n({ text, sourceLang, translator }) {
  const src = normalizeLang(sourceLang) || 'gu';
  const raw = String(text || '').trim().slice(0, 160);
  if (!raw) return { sourceLang: src, text_i18n: { [src]: '' } };

  const out = { [src]: raw };

  for (const dst of SUPPORTED_LANGS) {
    if (dst === src) continue;
    const tr = await translateTextCached({ text: raw, sourceLang: src, targetLang: dst, translator });
    if (typeof tr === 'string' && tr.trim()) out[dst] = tr.trim().slice(0, 160);
  }

  return { sourceLang: src, text_i18n: out };
}

module.exports = {
  normalizeLang,
  buildTranslationCacheKey,
  translateTextCached,
  buildTextI18n,
};
