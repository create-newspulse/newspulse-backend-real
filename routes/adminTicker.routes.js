const express = require('express');
const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const { requireAdminAuth } = require('../middleware/adminAuth');

const guardedTranslate = require('../services/translate/guardedTranslate');
const broadcastItemI18n = require('../services/broadcastItemI18n.service');
const { shouldAcceptTranslation } = require('../services/translate/i18nQuality');

const { getIstDateKey, isValidIstDateKey } = require('../src/utils/istDate');
const { emitBroadcastUpdated } = require('../services/broadcastSse.service');
const { invalidateBroadcastCaches } = require('../lib/cache');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');

const router = express.Router();

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function fail(res, status, code, message, details) {
  return res.status(status).json({
    ok: false,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
    ...(details !== undefined ? { details } : {}),
    // Backward-compat with other admin endpoints
    success: false,
    status,
  });
}

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, data });
}

function ensureDbOr503(res) {
  if (mongoose.connection.readyState !== 1) {
    fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
    return false;
  }
  return true;
}

function normalizeType(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'breaking' || s === 'live' ? s : null;
}

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function normalizeText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (s.length > 160) return null;
  return s;
}

function normalizeBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return null;
}

function normalizePriority(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-9999, Math.min(9999, Math.round(n)));
}

function normalizeUrl(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 2048) return null;
  // Allow relative URLs as well.
  return s;
}

function normalizeTimeText(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 16) return null;
  return s;
}

function mapItem(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  return {
    id,
    _id: id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    text: typeof d.text === 'string' ? d.text : '',
    sourceLang: typeof d.sourceLang === 'string' ? d.sourceLang : undefined,
    dateKey: typeof d.dateKey === 'string' ? d.dateKey : null,
    timeText: typeof d.timeText === 'string' ? d.timeText : null,
    linkUrl: typeof d.linkUrl === 'string' ? d.linkUrl : null,
    isPinned: Boolean(d.isPinned),
    priority: typeof d.priority === 'number' && Number.isFinite(d.priority) ? d.priority : 0,
    isActive: d.isActive === undefined || d.isActive === null ? Boolean(d.isLive) : Boolean(d.isActive),
    isLive: Boolean(d.isLive),
    createdAt: d.createdAt || null,
    expiresAt: d.expiresAt || null,
    text_i18n: d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : {},
    statusByLang: d.statusByLang && typeof d.statusByLang === 'object' ? d.statusByLang : {},
    qualityByLang: d.qualityByLang && typeof d.qualityByLang === 'object' ? d.qualityByLang : {},
  };
}

// POST /api/admin/ticker
router.post('/', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const type = normalizeType(body.type);
  if (!type) return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');

  const text = normalizeText(body.text);
  if (!text) return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');

  const rawLang = Object.prototype.hasOwnProperty.call(body, 'lang') ? body.lang : null;
  let lang = rawLang === null ? null : normalizeLang(rawLang);
  if (rawLang !== null && !lang) return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');

  // Best-effort detect if omitted.
  if (!lang) {
    try {
      const detected = await require('../services/googleTranslate.service').detectLanguage(text);
      const dl = detected && detected.ok ? normalizeLang(detected.lang) : null;
      lang = dl || 'gu';
    } catch (_) {
      lang = 'gu';
    }
  }

  const rawDateKey = Object.prototype.hasOwnProperty.call(body, 'dateKey') ? String(body.dateKey || '').trim() : null;
  const dateKey = rawDateKey ? rawDateKey : getIstDateKey(new Date());
  if (rawDateKey && !isValidIstDateKey(dateKey)) {
    return fail(res, 400, 'INVALID_DATE', 'Invalid dateKey. Expected YYYY-MM-DD');
  }

  const timeText = normalizeTimeText(body.timeText);
  const linkUrl = normalizeUrl(body.linkUrl);

  const priority = Object.prototype.hasOwnProperty.call(body, 'priority') ? normalizePriority(body.priority) : null;
  if (Object.prototype.hasOwnProperty.call(body, 'priority') && priority === null) {
    return fail(res, 400, 'INVALID_PRIORITY', 'Invalid priority. Expected a number');
  }

  const isPinned = Object.prototype.hasOwnProperty.call(body, 'isPinned') ? normalizeBool(body.isPinned) : null;
  if (Object.prototype.hasOwnProperty.call(body, 'isPinned') && isPinned === null) {
    return fail(res, 400, 'INVALID_PIN', 'Invalid isPinned. Expected boolean');
  }

  const isActive = Object.prototype.hasOwnProperty.call(body, 'isActive') ? normalizeBool(body.isActive) : null;
  if (Object.prototype.hasOwnProperty.call(body, 'isActive') && isActive === null) {
    return fail(res, 400, 'INVALID_ACTIVE', 'Invalid isActive. Expected boolean');
  }

  const autoTranslate = Object.prototype.hasOwnProperty.call(body, 'autoTranslate') ? Boolean(body.autoTranslate) : true;

  const createPayload = {
    type,
    text,
    createdAt: new Date(),
    dateKey,
    ...(timeText ? { timeText } : {}),
    ...(linkUrl ? { linkUrl } : {}),
    ...(priority !== null ? { priority } : {}),
    ...(isPinned !== null ? { isPinned } : {}),
    isLive: isActive === null ? true : Boolean(isActive),
    isActive: isActive === null ? true : Boolean(isActive),

    // Store both legacy + new i18n fields.
    language: lang,
    sourceLang: lang,
    text_i18n: { [lang]: text },
    translations: { [lang]: text },
    textByLang: { [lang]: text },
    statusByLang: { [lang]: 'APPROVED' },
    qualityByLang: { [lang]: 100 },
  };

  const created = await BroadcastItem.create(createPayload);

  // Auto-translate (best effort).
  try {
    if (!autoTranslate) throw new Error('AUTO_TRANSLATE_DISABLED');

    const translator = async (raw, sourceLang, targetLang) => {
      return guardedTranslate.translateWithGuardrails(raw, sourceLang, targetLang, { maxLen: 160 });
    };

    const built = await broadcastItemI18n.buildTextI18n({ text, sourceLang: lang, translator });
    const i18n = built && built.text_i18n ? built.text_i18n : { [lang]: text };

    created.text_i18n = created.text_i18n && typeof created.text_i18n === 'object' ? created.text_i18n : {};
    created.translations = created.translations && typeof created.translations === 'object' ? created.translations : {};
    created.textByLang = created.textByLang && typeof created.textByLang === 'object' ? created.textByLang : {};

    for (const targetLang of ['en', 'hi', 'gu']) {
      const clipped = typeof i18n[targetLang] === 'string' && i18n[targetLang].trim() ? i18n[targetLang].trim().slice(0, 160) : null;
      if (!clipped) continue;

      created.text_i18n[targetLang] = clipped;
      created.translations[targetLang] = clipped;
      created.textByLang[targetLang] = clipped;

      if (targetLang !== lang) {
        const accept = shouldAcceptTranslation(text, clipped, lang, targetLang);
        created.statusByLang = created.statusByLang && typeof created.statusByLang === 'object' ? created.statusByLang : {};
        created.qualityByLang = created.qualityByLang && typeof created.qualityByLang === 'object' ? created.qualityByLang : {};
        created.statusByLang[targetLang] = accept ? 'APPROVED' : 'NEEDS_REVIEW';
        created.qualityByLang[targetLang] = 100;
      }
    }

    await created.save();
  } catch (_) {
    // best effort
  }

  emitBroadcastUpdated({ reason: 'admin_ticker_create' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

  return res.status(201).json({ ok: true, success: true, item: mapItem(created) });
});

// PATCH /api/admin/ticker/:id
router.patch('/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const next = {};

  if (Object.prototype.hasOwnProperty.call(body, 'text')) {
    const t = normalizeText(body.text);
    if (!t) return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');
    next.text = t;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'lang')) {
    const l = normalizeLang(body.lang);
    if (!l) return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
    next.language = l;
    next.sourceLang = l;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'dateKey')) {
    const dk = String(body.dateKey || '').trim();
    if (!isValidIstDateKey(dk)) return fail(res, 400, 'INVALID_DATE', 'Invalid dateKey. Expected YYYY-MM-DD');
    next.dateKey = dk;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'timeText')) {
    const tt = normalizeTimeText(body.timeText);
    if (body.timeText !== null && body.timeText !== undefined && tt === null) {
      return fail(res, 400, 'INVALID_TIME_TEXT', 'Invalid timeText');
    }
    next.timeText = tt;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'linkUrl')) {
    const u = normalizeUrl(body.linkUrl);
    if (body.linkUrl !== null && body.linkUrl !== undefined && u === null) {
      return fail(res, 400, 'INVALID_URL', 'Invalid linkUrl');
    }
    next.linkUrl = u;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
    const p = normalizePriority(body.priority);
    if (p === null) return fail(res, 400, 'INVALID_PRIORITY', 'Invalid priority. Expected a number');
    next.priority = p;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'isPinned')) {
    const pin = normalizeBool(body.isPinned);
    if (pin === null) return fail(res, 400, 'INVALID_PIN', 'Invalid isPinned. Expected boolean');
    next.isPinned = pin;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'isActive')) {
    const active = normalizeBool(body.isActive);
    if (active === null) return fail(res, 400, 'INVALID_ACTIVE', 'Invalid isActive. Expected boolean');
    next.isActive = active;
    next.isLive = active; // keep legacy aligned
  }

  if (Object.keys(next).length === 0) {
    return fail(res, 400, 'BAD_REQUEST', 'No supported fields to update');
  }

  const doc = await BroadcastItem.findById(id);
  if (!doc) return fail(res, 404, 'NOT_FOUND', 'Not found');

  for (const [k, v] of Object.entries(next)) doc.set(k, v);

  const textChanged = Object.prototype.hasOwnProperty.call(next, 'text');
  const langChanged = Object.prototype.hasOwnProperty.call(next, 'sourceLang') || Object.prototype.hasOwnProperty.call(next, 'language');

  const autoTranslate = Object.prototype.hasOwnProperty.call(body, 'autoTranslate') ? Boolean(body.autoTranslate) : false;

  if ((textChanged || langChanged) && autoTranslate) {
    let srcLang = normalizeLang(doc.sourceLang) || normalizeLang(doc.language);
    if (!srcLang) srcLang = 'gu';

    const translator = async (raw, sourceLang, targetLang) => {
      return guardedTranslate.translateWithGuardrails(raw, sourceLang, targetLang, { maxLen: 160 });
    };

    const built = await broadcastItemI18n.buildTextI18n({ text: doc.text, sourceLang: srcLang, translator });
    const i18n = built && built.text_i18n ? built.text_i18n : { [srcLang]: String(doc.text || '').trim().slice(0, 160) };

    doc.text_i18n = doc.text_i18n && typeof doc.text_i18n === 'object' ? doc.text_i18n : {};
    doc.translations = doc.translations && typeof doc.translations === 'object' ? doc.translations : {};
    doc.textByLang = doc.textByLang && typeof doc.textByLang === 'object' ? doc.textByLang : {};

    for (const l of ['en', 'hi', 'gu']) {
      const clipped = typeof i18n[l] === 'string' && i18n[l].trim() ? i18n[l].trim().slice(0, 160) : null;
      if (!clipped) continue;
      doc.text_i18n[l] = clipped;
      doc.translations[l] = clipped;
      doc.textByLang[l] = clipped;
    }
  }

  const saved = await doc.save();

  emitBroadcastUpdated({ reason: 'admin_ticker_patch' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

  return ok(res, mapItem(saved));
});

// DELETE /api/admin/ticker/:id (soft delete)
router.delete('/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  }

  const updated = await BroadcastItem.findByIdAndUpdate(
    id,
    { $set: { isActive: false, isLive: false } },
    { new: true },
  );

  if (!updated) return fail(res, 404, 'NOT_FOUND', 'Not found');

  emitBroadcastUpdated({ reason: 'admin_ticker_delete' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

  return res.status(200).json({ ok: true, success: true });
});

module.exports = router;
