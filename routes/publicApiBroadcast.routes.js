const express = require('express');
const crypto = require('node:crypto');

const {
  getOrCreateSettings,
  adminSettingsResponse,
  listItemsLast24hByChannel,
  computePublicEnabled,
} = require('../services/broadcastCenter.service');

const googleTranslate = require('../services/googleTranslate.service');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function isDevEnv() {
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return env === 'development' || env === 'dev';
}

function _containsNumToken(s) {
  return /__NUM/i.test(String(s || ''));
}

function _stripNumTokensFromString(s) {
  // Last-resort safety net. We should never emit these tokens.
  return String(s || '')
    .replace(/__NUM(?:_[A-Z]+)*(?:_\d+)?__/gi, '')
    .replace(/__NUM\s*(?=\d)/gi, '')
    .trim();
}

function _guardStripNumTokens(payload, meta = {}) {
  try {
    const p = payload && typeof payload === 'object' ? payload : null;
    if (!p) return payload;

    const scrubItems = (arr, path) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (typeof v !== 'string') continue;
        if (!_containsNumToken(v)) continue;
        const cleaned = _stripNumTokensFromString(v);
        if (cleaned !== v) {
          console.error('[public-api][broadcast] leaked __NUM token stripped', { path, index: i, ...meta });
          arr[i] = cleaned;
        }
      }
    };

    scrubItems(p.breaking && p.breaking.items, 'breaking.items');
    scrubItems(p.live && p.live.items, 'live.items');
  } catch (_) {
    // never block response
  }
  return payload;
}

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function requestedLang(req) {
  const q = (req && req.query) || {};
  const h = (req && req.headers) || {};
  return (
    normalizeLang(q.lang) ||
    normalizeLang(h['x-lang']) ||
    normalizeLang(h['x-language']) ||
    null
  );
}

function wantsNoCache(req) {
  const q = (req && req.query) || {};
  const v = String(q.nocache || q.noCache || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function hashKey(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p ?? ''));
  return h.digest('hex');
}

const router = express.Router();

// In-memory cache: key -> { exp, payload }
const _cache = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Per-text translation cache: key -> { exp, text }
const _trCache = new Map();
const DEFAULT_TR_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_TR_MAX = 5000;

function cacheTtlMs() {
  const v = Number(process.env.PUBLIC_BROADCAST_TRANSLATION_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function trTtlMs() {
  const v = Number(process.env.PUBLIC_API_TRANSLATION_ITEM_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TR_TTL_MS;
}

function trMax() {
  const v = Number(process.env.PUBLIC_API_TRANSLATION_ITEM_CACHE_MAX);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TR_MAX;
}

function debugTranslationEnabled() {
  const v = String(process.env.DEBUG_TRANSLATION || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getCached(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCached(key, payload) {
  _cache.set(key, { exp: Date.now() + cacheTtlMs(), payload });
}

function getTrCached(key) {
  const hit = _trCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _trCache.delete(key);
    return null;
  }
  // LRU-ish: bump recency
  _trCache.delete(key);
  _trCache.set(key, hit);
  return hit.text;
}

function setTrCached(key, text) {
  // LRU eviction
  while (_trCache.size >= trMax()) {
    const oldest = _trCache.keys().next().value;
    if (!oldest) break;
    _trCache.delete(oldest);
  }
  _trCache.set(key, { exp: Date.now() + trTtlMs(), text: String(text || '') });
}

function clip160(s) {
  return String(s || '').trim().slice(0, 160);
}

function resolveSourceLang(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return normalizeLang(d.sourceLang) || normalizeLang(d.language) || null;
}

function normalizeDurationSec(v, fallback = 18) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function mirrorDurationFields(durationSec) {
  const d = normalizeDurationSec(durationSec);
  return {
    durationSec: d,
    tickerSpeedSeconds: d,
    durationSeconds: d,
    speed: d,
    speedSec: d,
  };
}

function resolveTextForLang(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const translations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const pick = (obj) => (obj && typeof obj[lang] === 'string' && obj[lang].trim() ? String(obj[lang]).trim() : null);
  return pick(translations) || pick(i18n) || pick(legacy) || null;
}

function resolveOriginalText(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const sourceLang = resolveSourceLang(d);
  if (sourceLang) {
    const src = resolveTextForLang(d, sourceLang);
    if (src) return clip160(src);
  }
  return resolveSourceText(d);
}

function resolveSourceText(doc) {
  // Prefer the declared sourceLang text; otherwise fall back to any stored text.
  const d = doc && typeof doc === 'object' ? doc : {};
  const srcLang = resolveSourceLang(d);
  const translations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  if (srcLang) {
    const src = resolveTextForLang(d, srcLang);
    if (src) return clip160(src);
  }

  return clip160(
    (translations && typeof translations.gu === 'string' && translations.gu.trim() ? translations.gu : null) ||
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (legacy && typeof legacy.gu === 'string' && legacy.gu.trim() ? legacy.gu : null) ||
    (translations && typeof translations.hi === 'string' && translations.hi.trim() ? translations.hi : null) ||
    (i18n && typeof i18n.hi === 'string' && i18n.hi.trim() ? i18n.hi : null) ||
    (legacy && typeof legacy.hi === 'string' && legacy.hi.trim() ? legacy.hi : null) ||
    (translations && typeof translations.en === 'string' && translations.en.trim() ? translations.en : null) ||
    (i18n && typeof i18n.en === 'string' && i18n.en.trim() ? i18n.en : null) ||
    (legacy && typeof legacy.en === 'string' && legacy.en.trim() ? legacy.en : null) ||
    (typeof d.text === 'string' ? d.text : '')
  );
}

function mapItem(doc, targetLang, translatedText, meta = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  const src = resolveSourceText(d);
  const outText = clip160(translatedText || src);
  return {
    id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    lang: String(targetLang || 'gu'),
    text: outText,
    textOriginal: src,
    textTranslated: outText,
    translationError: Boolean(meta.translationError),
  };
}

async function translateItems({ docs, targetLang }) {
  // IMPORTANT: Never default to Gujarati for unknown/invalid langs.
  const lang = normalizeLang(targetLang) || 'en';
  const items = Array.isArray(docs) ? docs : [];

  let storedHits = 0;
  let cacheHits = 0;
  let translatedCount = 0;
  const sourceLangCounts = { en: 0, hi: 0, gu: 0, unknown: 0 };

  // Resolve per-item sourceLang + sourceText first.
  const sources = items.map((d) => {
    const srcLang = resolveSourceLang(d);
    if (srcLang === 'en' || srcLang === 'hi' || srcLang === 'gu') sourceLangCounts[srcLang]++;
    else sourceLangCounts.unknown++;
    const srcText = clip160(resolveOriginalText(d));
    return { srcLang: srcLang || 'auto', srcText };
  });

  // If targetLang text is already stored, return it without hitting translation.
  const stored = items.map((d) => resolveTextForLang(d, lang));

  // Build initial resolved array: if target==sourceLang, use source; else use stored target if present; else source.
  const resolved = items.map((d, i) => {
    const srcLang = resolveSourceLang(d);
    const srcText = sources[i].srcText;
    if (srcLang && lang === srcLang) return clip160(srcText);
    const st = stored[i];
    if (st) {
      storedHits++;
      return clip160(st);
    }
    return clip160(srcText);
  });

  // Translate only those which do NOT already have targetLang stored.
  const toTranslateIdx = [];
  const toTranslateTexts = [];
  const toTranslateKeys = [];
  for (let i = 0; i < items.length; i++) {
    const d = items[i] && typeof items[i] === 'object' ? items[i] : {};
    const srcLang = resolveSourceLang(d);
    // No translation needed when target equals source.
    if (srcLang && lang === srcLang) continue;
    // No translation needed when target is already stored.
    if (stored[i]) continue;

    const src = sources[i].srcText;
    if (!src) continue;

    const k = `${srcLang || 'auto'}:${lang}:${googleTranslate.stableHash(src)}`;
    const cached = getTrCached(k);
    if (typeof cached === 'string' && cached.trim()) {
      resolved[i] = clip160(cached);
      cacheHits++;
      continue;
    }
    toTranslateIdx.push(i);
    toTranslateTexts.push(src);
    toTranslateKeys.push(k);
  }

  if (!toTranslateTexts.length) {
    return { ok: true, items: resolved.filter(Boolean), usedTranslation: false, translationError: false };
  }

  const tr = await googleTranslate.translateMany(toTranslateTexts, lang).catch((e) => ({ ok: false, error: e && e.message ? e.message : 'translate error' }));
  if (!tr || !tr.ok || !Array.isArray(tr.items) || tr.items.length !== toTranslateTexts.length) {
    if (debugTranslationEnabled()) {
      try {
        console.warn('[public-api][broadcast] translateMany failed', { lang, count: toTranslateTexts.length, error: tr && tr.error ? tr.error : 'translate_failed' });
      } catch (_) {}
    }
    return { ok: false, items: resolved.filter(Boolean), usedTranslation: true, translationError: true, error: tr && tr.error ? tr.error : 'translate_failed' };
  }

  for (let j = 0; j < toTranslateIdx.length; j++) {
    const i = toTranslateIdx[j];
    const v = clip160(tr.items[j]);
    if (v) {
      resolved[i] = v;
      const k = toTranslateKeys[j];
      setTrCached(k, v);
      translatedCount++;
    }
  }

  return {
    ok: true,
    items: resolved.filter(Boolean),
    usedTranslation: true,
    translationError: false,
    meta: {
      targetLang: lang,
      storedHits,
      cacheHits,
      translatedCount,
      sourceLangCounts,
    },
  };
}

// GET /public-api/broadcast?lang=en|hi|gu
router.get('/', async (req, res) => {
  const lang = requestedLang(req) || 'en';
  const bypassCache = wantsNoCache(req);

  if (isDevEnv()) {
    try {
      console.log('[public-api][broadcast] lang resolved', { resolvedLang: lang, targetLang: lang, bypassCache: Boolean(bypassCache) });
    } catch (_) {}
  }

  // Prevent edge/CDN caching from serving the wrong language.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (bypassCache) res.setHeader('X-No-Cache', '1');

  try {
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);

    const itemsBy = await listItemsLast24hByChannel();
    const breakingDocs = Array.isArray(itemsBy?.breaking) ? itemsBy.breaking : [];
    const liveDocs = Array.isArray(itemsBy?.live) ? itemsBy.live : [];

    // Canonical source text + sourceLang summary (used for cache keys + deterministic translation).
    const breakingSources = breakingDocs
      .map((d) => ({ srcLang: resolveSourceLang(d) || 'auto', srcText: resolveOriginalText(d) }))
      .filter((x) => x && x.srcText);
    const liveSources = liveDocs
      .map((d) => ({ srcLang: resolveSourceLang(d) || 'auto', srcText: resolveOriginalText(d) }))
      .filter((x) => x && x.srcText);

    const breakingItemsSrc = breakingSources.map((x) => String(x.srcText)).filter(Boolean);
    const liveItemsSrc = liveSources.map((x) => String(x.srcText)).filter(Boolean);

    const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
    const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

    const base = {
      breaking: {
        enabled: Boolean(breakingEnabled),
        mode: settings.breaking.mode,
        ...mirrorDurationFields(
          settings.breaking.durationSec ??
          settings.breaking.tickerSpeedSeconds ??
          settings.breaking.durationSeconds ??
          settings.breaking.speedSec ??
          settings.breaking.speed
        ),
        items: breakingItemsSrc,
      },
      live: {
        enabled: Boolean(liveEnabled),
        mode: settings.live.mode,
        ...mirrorDurationFields(
          settings.live.durationSec ??
          settings.live.tickerSpeedSeconds ??
          settings.live.durationSeconds ??
          settings.live.speedSec ??
          settings.live.speed
        ),
        items: liveItemsSrc,
      },
    };

    // NOTE: We intentionally do not short-circuit Gujarati: if sourceLang!=gu,
    // target=gu may still require translation.

    const cacheKey = `public-api:broadcast:${lang}:` + hashKey([
      settings.breaking.enabled,
      settings.breaking.mode,
      settings.breaking.tickerSpeedSeconds,
      breakingDocs.map((d) => `${resolveSourceLang(d) || 'auto'}:${resolveOriginalText(d)}`).join('\n'),
      settings.live.enabled,
      settings.live.mode,
      settings.live.tickerSpeedSeconds,
      liveDocs.map((d) => `${resolveSourceLang(d) || 'auto'}:${resolveOriginalText(d)}`).join('\n'),
    ]);

    if (!bypassCache) {
      const cached = getCached(cacheKey);
      if (cached) {
        if (isDevEnv()) {
          try {
            console.log('[public-api][broadcast] response cache hit', { targetLang: lang });
          } catch (_) {}
        }
        return res.status(200).json(cached);
      }
    }

    const [breakingTr, liveTr] = await Promise.all([
      translateItems({ docs: breakingDocs, targetLang: lang }),
      translateItems({ docs: liveDocs, targetLang: lang }),
    ]);

    if (isDevEnv()) {
      try {
        if (breakingTr && breakingTr.meta) {
          console.log('[public-api][broadcast] breaking translation', {
            targetLang: breakingTr.meta.targetLang,
            sourceLangCounts: breakingTr.meta.sourceLangCounts,
            storedHits: breakingTr.meta.storedHits,
            cacheHits: breakingTr.meta.cacheHits,
            translatedCount: breakingTr.meta.translatedCount,
          });
        }
        if (liveTr && liveTr.meta) {
          console.log('[public-api][broadcast] live translation', {
            targetLang: liveTr.meta.targetLang,
            sourceLangCounts: liveTr.meta.sourceLangCounts,
            storedHits: liveTr.meta.storedHits,
            cacheHits: liveTr.meta.cacheHits,
            translatedCount: liveTr.meta.translatedCount,
          });
        }
      } catch (_) {}
    }

    const payload = JSON.parse(JSON.stringify(base));

    const fallback = (!breakingTr.ok) || (!liveTr.ok);
    if (fallback) {
      try {
        console.warn('[public-api][broadcast] translation failed; returning source text', {
          lang,
          breakingOk: breakingTr.ok,
          liveOk: liveTr.ok,
          breakingError: breakingTr.error,
          liveError: liveTr.error,
        });
      } catch (_) {}
    }

    if (breakingTr.items) payload.breaking.items = breakingTr.items;
    if (liveTr.items) payload.live.items = liveTr.items;

    // Critical: do NOT cache fallback payloads; prevents “stuck Gujarati” for en/hi.
    if (!bypassCache && !fallback) setCached(cacheKey, payload);

    return res.status(200).json(_guardStripNumTokens(payload, { lang, fallback }));
  } catch (e) {
    // Never crash: return safe defaults.
    try {
      console.error('[public-api][broadcast] failed', e && e.message ? e.message : e);
    } catch (_) {}

    return res.status(200).json({
      breaking: { enabled: false, mode: 'auto', ...mirrorDurationFields(18), items: [] },
      live: { enabled: false, mode: 'auto', ...mirrorDurationFields(18), items: [] },
    });
  }
});

module.exports = router;
