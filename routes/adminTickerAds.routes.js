const express = require('express');
const mongoose = require('mongoose');

const noCache = require('../middleware/noCache');
const { requireAdminAuth } = require('../middleware/adminAuth');
const TickerAd = require('../models/TickerAd');
const {
  sanitizeTickerAdMessage,
  normalizeOptionalTickerAdMessage,
  normalizeOptionalTickerAdUrl,
  isValidTickerAdHttpUrl,
  normalizeTickerAdLang,
  normalizeTickerAdChannel,
  normalizeTickerAdDayParts,
  clampTickerAdFrequency,
  parseTickerAdDate,
} = require('../lib/tickerAds');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');

const router = express.Router();

router.use(noCache);
router.use(requireAdminAuth);

/*
Manual sanity:
curl -X POST "http://localhost:5000/api/broadcast/ticker-ads" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d "{\"message\":\"<b>Sale</b> now\",\"url\":\"https://example.com\",\"lang\":\"en\",\"channel\":\"live\",\"startAt\":\"2026-03-18T00:00:00.000Z\",\"endAt\":\"2026-03-19T00:00:00.000Z\",\"dayParts\":[\"morning\",\"evening\"]}"
curl "http://localhost:5000/api/public/ticker-ads/active?lang=en&channel=live"
*/

function fail(res, status, code, message, details) {
  return res.status(status).json({
    ok: false,
    success: false,
    status,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
    ...(details !== undefined ? { details } : {}),
  });
}

function ensureDbOr503(res) {
  if (mongoose.connection.readyState !== 1) {
    fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
    return false;
  }
  return true;
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  }
  return null;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizePriority(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 0 };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { ok: false, message: 'priority must be a number' };
  return { ok: true, value: Math.round(numeric) };
}

function normalizeFrequency(value, required) {
  if (value === undefined || value === null || value === '') {
    return required ? { ok: true, value: 3 } : { ok: true, value: undefined };
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { ok: false, message: 'frequency must be a number' };
  return { ok: true, value: clampTickerAdFrequency(numeric, 3) };
}

function actorLabel(req) {
  const admin = req && req.admin ? req.admin : {};
  return String(admin.email || admin.id || '').trim() || null;
}

function mapTickerAd(doc) {
  const value = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const item = value && typeof value === 'object' ? value : {};
  return {
    id: item._id ? String(item._id) : (item.id ? String(item.id) : undefined),
    message: typeof item.message === 'string' ? item.message : '',
    messages: item.messages && typeof item.messages === 'object'
      ? {
          en: typeof item.messages.en === 'string' ? item.messages.en : null,
          hi: typeof item.messages.hi === 'string' ? item.messages.hi : null,
          gu: typeof item.messages.gu === 'string' ? item.messages.gu : null,
        }
      : { en: null, hi: null, gu: null },
    url: typeof item.url === 'string' ? item.url : null,
    lang: typeof item.lang === 'string' ? item.lang : null,
    channel: typeof item.channel === 'string' ? item.channel : null,
    isActive: item.isActive !== false,
    startAt: item.startAt || null,
    endAt: item.endAt || null,
    dayParts: Array.isArray(item.dayParts) ? item.dayParts : [],
    priority: typeof item.priority === 'number' ? item.priority : 0,
    frequency: typeof item.frequency === 'number' ? item.frequency : 3,
    createdBy: typeof item.createdBy === 'string' ? item.createdBy : null,
    updatedBy: typeof item.updatedBy === 'string' ? item.updatedBy : null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

function parseBody(body, { partial = false, current = null, actor = null } = {}) {
  const payload = {};
  const source = body && typeof body === 'object' ? body : {};
  let touched = 0;

  const effectiveLang = (() => {
    if (!partial) return normalizeTickerAdLang(source.lang);
    if (Object.prototype.hasOwnProperty.call(source, 'lang')) return normalizeTickerAdLang(source.lang);
    return normalizeTickerAdLang(current && current.lang);
  })();

  if (!effectiveLang) {
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'lang')) {
      return { ok: false, message: 'lang must be one of en|hi|gu|all' };
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'lang')) {
    if (Object.prototype.hasOwnProperty.call(source, 'lang')) touched += 1;
    payload.lang = effectiveLang;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'message')) {
    if (Object.prototype.hasOwnProperty.call(source, 'message')) touched += 1;
    const message = sanitizeTickerAdMessage(source.message);
    if (!message) {
      if (effectiveLang !== 'all') return { ok: false, message: 'message is required' };
      payload.message = '';
    } else {
      if (message.length > 140) return { ok: false, message: 'message must be 140 characters or fewer' };
      payload.message = message;
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'messages')) {
    if (Object.prototype.hasOwnProperty.call(source, 'messages')) touched += 1;
    const rawMessages = source.messages && typeof source.messages === 'object' ? source.messages : {};
    payload.messages = {
      en: normalizeOptionalTickerAdMessage(rawMessages.en),
      hi: normalizeOptionalTickerAdMessage(rawMessages.hi),
      gu: normalizeOptionalTickerAdMessage(rawMessages.gu),
    };
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'url')) {
    if (Object.prototype.hasOwnProperty.call(source, 'url')) touched += 1;
    const url = normalizeOptionalTickerAdUrl(source.url);
    if (url && url.length > 300) return { ok: false, message: 'url must be 300 characters or fewer' };
    if (url && !isValidTickerAdHttpUrl(url)) return { ok: false, message: 'url must start with http:// or https://' };
    payload.url = url;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'channel')) {
    if (Object.prototype.hasOwnProperty.call(source, 'channel')) touched += 1;
    const channel = normalizeTickerAdChannel(source.channel);
    if (!channel) return { ok: false, message: 'channel must be one of breaking|live|both' };
    payload.channel = channel;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'startAt')) {
    if (Object.prototype.hasOwnProperty.call(source, 'startAt')) touched += 1;
    const parsedStart = parseTickerAdDate(source.startAt, 'startAt');
    if (!parsedStart.ok) return parsedStart;
    payload.startAt = parsedStart.value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'endAt')) {
    if (Object.prototype.hasOwnProperty.call(source, 'endAt')) touched += 1;
    const parsedEnd = parseTickerAdDate(source.endAt, 'endAt');
    if (!parsedEnd.ok) return parsedEnd;
    payload.endAt = parsedEnd.value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'dayParts')) {
    if (Object.prototype.hasOwnProperty.call(source, 'dayParts')) touched += 1;
    const dayParts = normalizeTickerAdDayParts(source.dayParts);
    if (!dayParts) return { ok: false, message: 'dayParts must contain morning|noon|evening|night' };
    payload.dayParts = dayParts;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'priority')) {
    if (Object.prototype.hasOwnProperty.call(source, 'priority')) touched += 1;
    const priority = normalizePriority(source.priority);
    if (!priority.ok) return priority;
    payload.priority = priority.value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'frequency')) {
    if (Object.prototype.hasOwnProperty.call(source, 'frequency')) touched += 1;
    const frequency = normalizeFrequency(source.frequency, !partial);
    if (!frequency.ok) return frequency;
    if (frequency.value !== undefined) payload.frequency = frequency.value;
  }

  if (Object.prototype.hasOwnProperty.call(source, 'isActive')) {
    touched += 1;
    const isActive = normalizeBool(source.isActive);
    if (isActive === null) return { ok: false, message: 'isActive must be boolean' };
    payload.isActive = isActive;
  } else if (!partial) {
    payload.isActive = true;
  }

  if (!partial) {
    payload.createdBy = normalizeOptionalString(source.createdBy) || actor;
  }

  if (Object.prototype.hasOwnProperty.call(source, 'updatedBy')) {
    touched += 1;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'updatedBy') || actor) {
    payload.updatedBy = normalizeOptionalString(source.updatedBy) || actor;
  }

  const effectiveStartAt = payload.startAt || (current && current.startAt);
  const effectiveEndAt = payload.endAt || (current && current.endAt);
  if (effectiveStartAt instanceof Date && effectiveEndAt instanceof Date) {
    if (effectiveEndAt.getTime() <= effectiveStartAt.getTime()) {
      return { ok: false, message: 'endAt must be greater than startAt' };
    }
  }

  const finalLang = payload.lang || (current && current.lang);
  if (finalLang === 'all') {
    const currentMessages = current && current.messages && typeof current.messages === 'object' ? current.messages : {};
    const finalMessages = Object.prototype.hasOwnProperty.call(payload, 'messages')
      ? payload.messages
      : {
          en: normalizeOptionalTickerAdMessage(currentMessages.en),
          hi: normalizeOptionalTickerAdMessage(currentMessages.hi),
          gu: normalizeOptionalTickerAdMessage(currentMessages.gu),
        };

    const hasAnyLocalized = Boolean(finalMessages && (finalMessages.en || finalMessages.hi || finalMessages.gu));
    if (!hasAnyLocalized) {
      return { ok: false, message: 'messages.en|messages.hi|messages.gu required when lang is all' };
    }
  }

  if (partial && touched === 0) {
    return { ok: false, message: 'No supported fields provided for update' };
  }

  return { ok: true, value: payload };
}

function parseDateFilter(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  return parseTickerAdDate(value, fieldName);
}

router.post('/', async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const parsed = parseBody(req.body, { partial: false, actor: actorLabel(req) });
  if (!parsed.ok) return fail(res, 400, 'BAD_REQUEST', parsed.message);

  try {
    const created = await TickerAd.create(parsed.value);
    bumpPublicConfigVersion().catch(() => {});
    return res.status(201).json({ ok: true, success: true, item: mapTickerAd(created) });
  } catch (error) {
    if (error && error.name === 'ValidationError') {
      return fail(res, 400, 'VALIDATION_ERROR', error.message);
    }
    return fail(res, 500, 'SERVER_ERROR', 'Failed to create ticker ad');
  }
});

router.get('/', async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const query = {};

  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang')) {
    const lang = normalizeTickerAdLang(req.query.lang);
    if (!lang) return fail(res, 400, 'BAD_REQUEST', 'lang must be one of en|hi|gu');
    query.lang = lang;
  }

  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'channel')) {
    const channel = normalizeTickerAdChannel(req.query.channel);
    if (!channel) return fail(res, 400, 'BAD_REQUEST', 'channel must be one of breaking|live|both');
    query.channel = channel;
  }

  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'active')) {
    const active = normalizeBool(req.query.active);
    if (active === null) return fail(res, 400, 'BAD_REQUEST', 'active must be boolean');
    query.isActive = active;
  }

  const dateFrom = parseDateFilter(req.query && req.query.dateFrom, 'dateFrom');
  if (!dateFrom.ok) return fail(res, 400, 'BAD_REQUEST', dateFrom.message);

  const dateTo = parseDateFilter(req.query && req.query.dateTo, 'dateTo');
  if (!dateTo.ok) return fail(res, 400, 'BAD_REQUEST', dateTo.message);

  const startAtFrom = parseDateFilter(req.query && req.query.startAtFrom, 'startAtFrom');
  if (!startAtFrom.ok) return fail(res, 400, 'BAD_REQUEST', startAtFrom.message);

  const startAtTo = parseDateFilter(req.query && req.query.startAtTo, 'startAtTo');
  if (!startAtTo.ok) return fail(res, 400, 'BAD_REQUEST', startAtTo.message);

  const endAtFrom = parseDateFilter(req.query && req.query.endAtFrom, 'endAtFrom');
  if (!endAtFrom.ok) return fail(res, 400, 'BAD_REQUEST', endAtFrom.message);

  const endAtTo = parseDateFilter(req.query && req.query.endAtTo, 'endAtTo');
  if (!endAtTo.ok) return fail(res, 400, 'BAD_REQUEST', endAtTo.message);

  if (dateFrom.value && dateTo.value && dateTo.value.getTime() < dateFrom.value.getTime()) {
    return fail(res, 400, 'BAD_REQUEST', 'dateTo must be greater than or equal to dateFrom');
  }
  if (startAtFrom.value && startAtTo.value && startAtTo.value.getTime() < startAtFrom.value.getTime()) {
    return fail(res, 400, 'BAD_REQUEST', 'startAtTo must be greater than or equal to startAtFrom');
  }
  if (endAtFrom.value && endAtTo.value && endAtTo.value.getTime() < endAtFrom.value.getTime()) {
    return fail(res, 400, 'BAD_REQUEST', 'endAtTo must be greater than or equal to endAtFrom');
  }

  if (dateFrom.value) {
    query.endAt = { ...(query.endAt || {}), $gte: dateFrom.value };
  }
  if (dateTo.value) {
    query.startAt = { ...(query.startAt || {}), $lte: dateTo.value };
  }
  if (startAtFrom.value) {
    query.startAt = { ...(query.startAt || {}), $gte: startAtFrom.value };
  }
  if (startAtTo.value) {
    query.startAt = { ...(query.startAt || {}), $lte: startAtTo.value };
  }
  if (endAtFrom.value) {
    query.endAt = { ...(query.endAt || {}), $gte: endAtFrom.value };
  }
  if (endAtTo.value) {
    query.endAt = { ...(query.endAt || {}), $lte: endAtTo.value };
  }

  try {
    const items = await TickerAd.find(query)
      .sort({ priority: -1, startAt: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      ok: true,
      success: true,
      items: (items || []).map(mapTickerAd),
    });
  } catch (_) {
    return fail(res, 500, 'SERVER_ERROR', 'Failed to list ticker ads');
  }
});

router.patch('/:id', async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) {
    return fail(res, 404, 'NOT_FOUND', 'Ticker ad not found');
  }

  const doc = await TickerAd.findById(id);
  if (!doc) {
    return fail(res, 404, 'NOT_FOUND', 'Ticker ad not found');
  }

  const parsed = parseBody(req.body, { partial: true, current: doc, actor: actorLabel(req) });
  if (!parsed.ok) return fail(res, 400, 'BAD_REQUEST', parsed.message);

  try {
    Object.assign(doc, parsed.value);
    await doc.save();
    bumpPublicConfigVersion().catch(() => {});
    return res.status(200).json({ ok: true, success: true, item: mapTickerAd(doc) });
  } catch (error) {
    if (error && error.name === 'ValidationError') {
      return fail(res, 400, 'VALIDATION_ERROR', error.message);
    }
    return fail(res, 500, 'SERVER_ERROR', 'Failed to update ticker ad');
  }
});

router.delete('/:id', async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) {
    return fail(res, 404, 'NOT_FOUND', 'Ticker ad not found');
  }

  try {
    const deleted = await TickerAd.findByIdAndDelete(id);
    if (!deleted) {
      return fail(res, 404, 'NOT_FOUND', 'Ticker ad not found');
    }
    bumpPublicConfigVersion().catch(() => {});
    return res.status(200).json({ ok: true, success: true, id: String(id) });
  } catch (_) {
    return fail(res, 500, 'SERVER_ERROR', 'Failed to delete ticker ad');
  }
});

module.exports = router;