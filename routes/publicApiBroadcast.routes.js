const express = require('express');
const crypto = require('node:crypto');

const {
  getOrCreateSettings,
  adminSettingsResponse,
  listItemsLast24hByChannel,
  computePublicEnabled,
} = require('../services/broadcastCenter.service');

const { translateMany } = require('../services/googleTranslate.service');

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

function cacheTtlMs() {
  const v = Number(process.env.PUBLIC_BROADCAST_TRANSLATION_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
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

function resolveItemText(doc) {
  // Keep this simple: prefer new i18n fields, then legacy, then raw.
  const d = doc && typeof doc === 'object' ? doc : {};
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  return (
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (legacy && typeof legacy.gu === 'string' && legacy.gu.trim() ? legacy.gu : null) ||
    (typeof d.text === 'string' ? d.text : '')
  ).trim();
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

    const breakingItemsSrc = breakingDocs.map(resolveItemText).map(String).filter(Boolean);
    const liveItemsSrc = liveDocs.map(resolveItemText).map(String).filter(Boolean);

    const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
    const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

    const base = {
      ok: true,
      success: true,
      data: {
        breaking: {
          enabled: Boolean(breakingEnabled),
          mode: settings.breaking.mode,
          tickerSpeedSeconds: settings.breaking.tickerSpeedSeconds,
          items: breakingItemsSrc,
        },
        live: {
          enabled: Boolean(liveEnabled),
          mode: settings.live.mode,
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
      translateMany(breakingItemsSrc, lang).catch((e) => ({ ok: false, error: e && e.message ? e.message : 'translate error' })),
      translateMany(liveItemsSrc, lang).catch((e) => ({ ok: false, error: e && e.message ? e.message : 'translate error' })),
    ]);

    const payload = JSON.parse(JSON.stringify(base));

    const fallback = (!breakingTr.ok) || (!liveTr.ok);
    if (fallback) {
      payload.data.translationFallback = true;
      try {
        console.warn('[public-api][broadcast] translation fallback', { lang, breakingOk: breakingTr.ok, liveOk: liveTr.ok });
      } catch (_) {}
    }

    if (breakingTr.ok) payload.data.breaking.items = breakingTr.items;
    if (liveTr.ok) payload.data.live.items = liveTr.items;

    if (!bypassCache) setCached(cacheKey, payload);

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
        breaking: { enabled: false, mode: 'auto', tickerSpeedSeconds: 18, items: [] },
        live: { enabled: false, mode: 'auto', tickerSpeedSeconds: 18, items: [] },
      },
    });
  }
});

module.exports = router;
