const express = require('express');
const mongoose = require('mongoose');

const noCache = require('../middleware/noCache');
const TickerAd = require('../models/TickerAd');
const {
  normalizeTickerAdLang,
  normalizeTickerAdChannel,
  getIstDayPart,
} = require('../lib/tickerAds');

const router = express.Router();

router.use(noCache);

function fail(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
  });
}

function resolveTickerAdMessage(doc, requestedLang) {
  const item = doc && typeof doc === 'object' ? doc : {};
  const messages = item.messages && typeof item.messages === 'object' ? item.messages : null;

  const requested = messages && requestedLang && typeof messages[requestedLang] === 'string'
    ? String(messages[requestedLang]).trim()
    : '';
  if (requested) return requested;

  const legacy = typeof item.message === 'string' ? String(item.message).trim() : '';
  if (legacy) return legacy;

  const fallbackEn = messages && typeof messages.en === 'string' ? String(messages.en).trim() : '';
  if (fallbackEn) return fallbackEn;

  const fallbackHi = messages && typeof messages.hi === 'string' ? String(messages.hi).trim() : '';
  if (fallbackHi) return fallbackHi;

  const fallbackGu = messages && typeof messages.gu === 'string' ? String(messages.gu).trim() : '';
  if (fallbackGu) return fallbackGu;

  return '';
}

function mapPublicTickerAd(doc, requestedLang) {
  const value = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const item = value && typeof value === 'object' ? value : {};
  return {
    id: item._id ? String(item._id) : (item.id ? String(item.id) : undefined),
    message: resolveTickerAdMessage(item, requestedLang),
    url: typeof item.url === 'string' ? item.url : null,
    priority: typeof item.priority === 'number' ? item.priority : 0,
    frequency: typeof item.frequency === 'number' ? item.frequency : 3,
    channel: typeof item.channel === 'string' ? item.channel : null,
    // Keep output stable for consumers: items returned for `lang=en|hi|gu` report that lang.
    lang: requestedLang || (typeof item.lang === 'string' ? item.lang : null),
  };
}

router.get('/active', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
  }

  const lang = normalizeTickerAdLang(req.query && req.query.lang ? req.query.lang : 'en');
  if (!lang) {
    return fail(res, 400, 'BAD_REQUEST', 'lang must be one of en|hi|gu|all');
  }

  const requestedChannel = normalizeTickerAdChannel(req.query && req.query.channel ? req.query.channel : 'both');
  if (!requestedChannel) {
    return fail(res, 400, 'BAD_REQUEST', 'channel must be one of breaking|live|both');
  }

  const now = new Date();
  const dayPart = getIstDayPart(now);

  const channelFilter = requestedChannel === 'both'
    ? ['breaking', 'live', 'both']
    : [requestedChannel, 'both'];

  const langFilter = lang === 'all' ? ['all'] : [lang, 'all'];

  try {
    const items = await TickerAd.find({
      isActive: true,
      lang: { $in: langFilter },
      channel: { $in: channelFilter },
      startAt: { $lte: now },
      endAt: { $gt: now },
      $or: [
        { dayParts: { $in: [dayPart] } },
        { dayParts: { $exists: false } },
        { dayParts: { $size: 0 } },
      ],
    })
      .sort({ priority: -1, startAt: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      items: (items || []).map((doc) => mapPublicTickerAd(doc, lang === 'all' ? 'all' : lang)),
    });
  } catch (_) {
    return fail(res, 500, 'SERVER_ERROR', 'Failed to load ticker ads');
  }
});

module.exports = router;