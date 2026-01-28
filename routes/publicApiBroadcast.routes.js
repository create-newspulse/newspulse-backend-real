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

function normalizeLang(v) {
  const s = String(v || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(s) ? s : null;
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

function resolveTextForLang(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const pick = (obj) => (obj && typeof obj[lang] === 'string' && obj[lang].trim() ? String(obj[lang]).trim() : null);
  return pick(i18n) || pick(legacy) || null;
}

function resolveSourceText(doc) {
  // Prefer Gujarati, then Hindi, then English, then raw.
  const d = doc && typeof doc === 'object' ? doc : {};
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  return clip160(
    resolveTextForLang(d, 'gu') ||
    resolveTextForLang(d, 'hi') ||
    resolveTextForLang(d, 'en') ||
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
  const lang = normalizeLang(targetLang) || 'gu';
  const items = Array.isArray(docs) ? docs : [];

  // If targetLang text is already stored, return it without hitting translation.
  const stored = items.map((d) => resolveTextForLang(d, lang));

  if (lang === 'gu') {
    const texts = stored.map((t, i) => clip160(t || resolveSourceText(items[i]))).filter(Boolean);
    return { ok: true, items: texts, usedTranslation: false, translationError: false };
  }

  const resolved = stored.map((t, i) => clip160(t || resolveSourceText(items[i])));

  // Translate only those which do NOT already have targetLang stored.
  const toTranslateIdx = [];
  const toTranslateTexts = [];
  for (let i = 0; i < items.length; i++) {
    if (stored[i]) continue;
    const src = resolved[i];
    if (!src) continue;
    const k = `${lang}::${src}`;
    const cached = getTrCached(k);
    if (typeof cached === 'string' && cached.trim()) {
      resolved[i] = clip160(cached);
      continue;
    }
    toTranslateIdx.push(i);
    toTranslateTexts.push(src);
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
      const k = `${lang}::${toTranslateTexts[j]}`;
      setTrCached(k, v);
    }
  }

  return { ok: true, items: resolved.filter(Boolean), usedTranslation: true, translationError: false };
}

// GET /public-api/broadcast?lang=en|hi|gu
router.get('/', async (req, res) => {
  const lang = normalizeLang(req.query && req.query.lang) || 'gu';
  const bypassCache = wantsNoCache(req);

  try {
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);

    const itemsBy = await listItemsLast24hByChannel();
    const breakingDocs = Array.isArray(itemsBy?.breaking) ? itemsBy.breaking : [];
    const liveDocs = Array.isArray(itemsBy?.live) ? itemsBy.live : [];

    const breakingItemsSrc = breakingDocs.map(resolveSourceText).map(String).filter(Boolean);
    const liveItemsSrc = liveDocs.map(resolveSourceText).map(String).filter(Boolean);

    const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
    const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

    const base = {
      ok: true,
      success: true,
      data: {
        breaking: {
          enabled: Boolean(breakingEnabled),
          mode: settings.breaking.mode,
          durationSec: settings.breaking.durationSec ?? settings.breaking.tickerSpeedSeconds,
          tickerSpeedSeconds: settings.breaking.tickerSpeedSeconds,
          items: breakingItemsSrc,
        },
        live: {
          enabled: Boolean(liveEnabled),
          mode: settings.live.mode,
          durationSec: settings.live.durationSec ?? settings.live.tickerSpeedSeconds,
          tickerSpeedSeconds: settings.live.tickerSpeedSeconds,
          items: liveItemsSrc,
        },
      },
    };

    // No translation required.
    if (lang === 'gu') {
      return res.status(200).json(base);
    }

    const cacheKey = `public-api:broadcast:${lang}:` + hashKey([
      settings.breaking.enabled,
      settings.breaking.mode,
      settings.breaking.tickerSpeedSeconds,
      breakingItemsSrc.join('\n'),
      settings.live.enabled,
      settings.live.mode,
      settings.live.tickerSpeedSeconds,
      liveItemsSrc.join('\n'),
    ]);

    if (!bypassCache) {
      const cached = getCached(cacheKey);
      if (cached) return res.status(200).json(cached);
    }

    const [breakingTr, liveTr] = await Promise.all([
      translateItems({ docs: breakingDocs, targetLang: lang }),
      translateItems({ docs: liveDocs, targetLang: lang }),
    ]);

    const payload = JSON.parse(JSON.stringify(base));

    const fallback = (!breakingTr.ok) || (!liveTr.ok);
    if (fallback) {
      payload.data.translationFallback = true;
      payload.data.translationError = true;
      if (debugTranslationEnabled()) {
        try {
          console.warn('[public-api][broadcast] translation fallback', {
            lang,
            breakingOk: breakingTr.ok,
            liveOk: liveTr.ok,
            breakingError: breakingTr.error,
            liveError: liveTr.error,
          });
        } catch (_) {}
      }
    }

    if (breakingTr.items) payload.data.breaking.items = breakingTr.items;
    if (liveTr.items) payload.data.live.items = liveTr.items;

    // Optional detailed schema (for new frontend): itemsObjects
    payload.data.breaking.itemsObjects = breakingDocs
      .map((d, i) => mapItem(d, lang, payload.data.breaking.items[i], { translationError: !breakingTr.ok }))
      .filter((x) => x && x.text);
    payload.data.live.itemsObjects = liveDocs
      .map((d, i) => mapItem(d, lang, payload.data.live.items[i], { translationError: !liveTr.ok }))
      .filter((x) => x && x.text);

    // Critical: do NOT cache fallback payloads; prevents “stuck Gujarati” for en/hi.
    if (!bypassCache && !fallback) setCached(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (e) {
    // Never crash: return safe defaults.
    try {
      console.error('[public-api][broadcast] failed', e && e.message ? e.message : e);
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      success: true,
      data: {
        translationFallback: true,
        translationError: true,
        breaking: { enabled: false, mode: 'auto', tickerSpeedSeconds: 18, items: [] },
        live: { enabled: false, mode: 'auto', tickerSpeedSeconds: 18, items: [] },
      },
    });
  }
});

module.exports = router;
