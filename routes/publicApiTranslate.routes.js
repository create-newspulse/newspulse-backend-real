const express = require('express');

const { translateMany } = require('../services/googleTranslate.service');

const router = express.Router();

const ALLOWED_TARGETS = new Set(['en', 'hi', 'gu']);
const MAX_TEXTS = 50;
const MAX_TEXT_LEN = 500;

// Simple in-memory cache: key -> { value, exp }
const _cache = new Map();
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function cacheTtlMs() {
  const v = Number(process.env.PUBLIC_API_TRANSLATE_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function maxEntries() {
  const v = Number(process.env.PUBLIC_API_TRANSLATE_CACHE_MAX_ENTRIES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_ENTRIES;
}

function getCache(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.exp && Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  // Bound memory in a very simple way.
  if (_cache.size >= maxEntries()) {
    const firstKey = _cache.keys().next().value;
    if (firstKey) _cache.delete(firstKey);
  }
  _cache.set(key, { value: String(value ?? ''), exp: Date.now() + cacheTtlMs() });
}

function badRequest(res, message, extra = {}) {
  return res.status(400).json({ ok: false, error: message, ...extra });
}

// POST /public-api/translate
// Body: { target: "en"|"hi"|"gu", texts: string[] }
router.post('/', async (req, res) => {
  const target = String(req.body && req.body.target ? req.body.target : '').trim().toLowerCase();
  const textsRaw = req.body && req.body.texts;

  if (!ALLOWED_TARGETS.has(target)) {
    return badRequest(res, 'Invalid target. Allowed: en, hi, gu');
  }

  if (!Array.isArray(textsRaw)) {
    return badRequest(res, 'Invalid texts. Expected an array of strings');
  }

  if (textsRaw.length > MAX_TEXTS) {
    return badRequest(res, `Too many texts. Max ${MAX_TEXTS} per request`);
  }

  const texts = textsRaw.map(t => (t === null || t === undefined) ? '' : String(t));

  for (let i = 0; i < texts.length; i++) {
    if (texts[i].length > MAX_TEXT_LEN) {
      return badRequest(res, `Text too long at index ${i}. Max ${MAX_TEXT_LEN} chars`);
    }
  }

  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'GOOGLE_TRANSLATE_API_KEY is not set' });
  }

  try {
    // Preserve array shape 1:1 with inputs.
    const translations = new Array(texts.length);

    const toTranslate = [];
    const toTranslateIndex = [];

    for (let i = 0; i < texts.length; i++) {
      const original = texts[i];
      const trimmed = original.trim();

      if (!trimmed) {
        translations[i] = '';
        continue;
      }

      const cacheKey = `${target}:${original}`;
      const cached = getCache(cacheKey);
      if (typeof cached === 'string') {
        translations[i] = cached;
        continue;
      }

      toTranslate.push(original);
      toTranslateIndex.push(i);
    }

    if (toTranslate.length) {
      const tr = await translateMany(toTranslate, target);
      if (!tr || tr.ok !== true || !Array.isArray(tr.items) || tr.items.length !== toTranslate.length) {
        const errMsg = tr && tr.ok === false && tr.error ? tr.error : 'Translate failed';
        return res.status(502).json({ ok: false, error: errMsg });
      }

      for (let j = 0; j < tr.items.length; j++) {
        const idx = toTranslateIndex[j];
        const translated = String(tr.items[j] ?? '');
        translations[idx] = translated;
        const cacheKey = `${target}:${texts[idx]}`;
        setCache(cacheKey, translated);
      }
    }

    // Final pass: ensure no holes.
    for (let i = 0; i < translations.length; i++) {
      if (typeof translations[i] !== 'string') translations[i] = '';
    }

    return res.status(200).json({
      ok: true,
      data: { translations },
    });
  } catch (e) {
    const msg = e && e.message ? e.message : 'Unexpected error';
    return res.status(500).json({ ok: false, error: msg });
  }
});

module.exports = router;
