const express = require('express');

const BroadcastItem = require('../models/BroadcastItem');
const { getIstDateKey, isValidIstDateKey } = require('../src/utils/istDate');

const router = express.Router();

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function resolvePublicText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = normalizeLang(lang) || 'gu';

  const src = SUPPORTED_LANGS.has(String(d.sourceLang || ''))
    ? String(d.sourceLang)
    : (SUPPORTED_LANGS.has(String(d.language || '')) ? String(d.language) : null);

  const translations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (translations && typeof translations[target] === 'string' && translations[target].trim() ? translations[target] : null) ||
    (i18n && typeof i18n[target] === 'string' && i18n[target].trim() ? i18n[target] : null) ||
    (legacy && typeof legacy[target] === 'string' && legacy[target].trim() ? legacy[target] : null) ||
    (src && translations && typeof translations[src] === 'string' && translations[src].trim() ? translations[src] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (i18n && typeof i18n.hi === 'string' && i18n.hi.trim() ? i18n.hi : null) ||
    (i18n && typeof i18n.en === 'string' && i18n.en.trim() ? i18n.en : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');

  return String(pick || '').trim();
}

function clampLimit(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  return Math.min(100, Math.max(1, rounded));
}

function normalizeType(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'breaking' || s === 'live' ? s : null;
}

function mapItem(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return {
    id: d._id ? String(d._id) : undefined,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    dateKey: typeof d.dateKey === 'string' ? d.dateKey : null,
    timeText: typeof d.timeText === 'string' ? d.timeText : null,
    linkUrl: typeof d.linkUrl === 'string' ? d.linkUrl : null,
    isPinned: Boolean(d.isPinned),
    priority: typeof d.priority === 'number' && Number.isFinite(d.priority) ? d.priority : 0,
    text: resolvePublicText(d, lang),
    createdAt: d.createdAt || null,
  };
}

function buildNotExpiredFilter() {
  const now = new Date();
  return {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gte: now } },
    ],
  };
}

async function listTickerItems({ type, dateKey, lang, limit }) {
  const notExpired = buildNotExpiredFilter();
  const filter = {
    $and: [
      { type, dateKey, isLive: true },
      notExpired,
      { $or: [{ isActive: true }, { isActive: { $exists: false } }] },
    ],
  };

  const docs = await BroadcastItem.find(filter)
    .sort({ isPinned: -1, priority: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  return docs.map((d) => mapItem(d, lang));
}

// GET /api/ticker/breaking?lang=en
router.get('/breaking', async (req, res) => {
  try {
    const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') ? normalizeLang(req.query.lang) : null;
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') && !lang) {
      return res.status(400).json({ ok: false, code: 'INVALID_LANG', message: 'Invalid lang. Expected en|hi|gu' });
    }

    const dateKey = getIstDateKey(new Date());
    const items = await listTickerItems({ type: 'breaking', dateKey, lang, limit: clampLimit(req.query && req.query.limit, 20) });

    return res.status(200).json({ ok: true, type: 'breaking', dateKey, items });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Failed to load breaking ticker' });
  }
});

// GET /api/ticker/live?lang=en
router.get('/live', async (req, res) => {
  try {
    const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') ? normalizeLang(req.query.lang) : null;
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') && !lang) {
      return res.status(400).json({ ok: false, code: 'INVALID_LANG', message: 'Invalid lang. Expected en|hi|gu' });
    }

    const dateKey = getIstDateKey(new Date());
    const items = await listTickerItems({ type: 'live', dateKey, lang, limit: clampLimit(req.query && req.query.limit, 50) });

    return res.status(200).json({ ok: true, type: 'live', dateKey, items });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Failed to load live updates ticker' });
  }
});

// GET /api/ticker/live/all?date=YYYY-MM-DD&lang=en
router.get('/live/all', async (req, res) => {
  try {
    const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') ? normalizeLang(req.query.lang) : null;
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') && !lang) {
      return res.status(400).json({ ok: false, code: 'INVALID_LANG', message: 'Invalid lang. Expected en|hi|gu' });
    }

    const rawDate = Object.prototype.hasOwnProperty.call(req.query || {}, 'date') ? String(req.query.date).trim() : null;
    const dateKey = rawDate ? rawDate : getIstDateKey(new Date());
    if (rawDate && !isValidIstDateKey(dateKey)) {
      return res.status(400).json({ ok: false, code: 'INVALID_DATE', message: 'Invalid date. Expected YYYY-MM-DD' });
    }

    const items = await listTickerItems({ type: 'live', dateKey, lang, limit: clampLimit(req.query && req.query.limit, 100) });

    return res.status(200).json({ ok: true, type: 'live', dateKey, items });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Failed to load live updates' });
  }
});

// GET /api/ticker/items?type=breaking|live&date=YYYY-MM-DD&lang=en
router.get('/items', async (req, res) => {
  try {
    const type = Object.prototype.hasOwnProperty.call(req.query || {}, 'type') ? normalizeType(req.query.type) : null;
    if (!type) {
      return res.status(400).json({ ok: false, code: 'INVALID_TYPE', message: 'Invalid type. Expected breaking|live' });
    }

    const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') ? normalizeLang(req.query.lang) : null;
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') && !lang) {
      return res.status(400).json({ ok: false, code: 'INVALID_LANG', message: 'Invalid lang. Expected en|hi|gu' });
    }

    const rawDate = Object.prototype.hasOwnProperty.call(req.query || {}, 'date') ? String(req.query.date).trim() : null;
    const dateKey = rawDate ? rawDate : getIstDateKey(new Date());
    if (rawDate && !isValidIstDateKey(dateKey)) {
      return res.status(400).json({ ok: false, code: 'INVALID_DATE', message: 'Invalid date. Expected YYYY-MM-DD' });
    }

    const items = await listTickerItems({ type, dateKey, lang, limit: clampLimit(req.query && req.query.limit, 100) });
    return res.status(200).json({ ok: true, type, dateKey, items });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Failed to load ticker items' });
  }
});

module.exports = router;
