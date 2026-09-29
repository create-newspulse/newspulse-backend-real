const mongoose = require('mongoose');
const News = require('../models/News');
const Contributor = require('../models/Contributor');
const Series = require('../models/PulseDialogueSeries');
const Event = require('../models/ArticleAnalyticsEvent');
const { safeHash, shouldSkipAnalytics, checkCooldownAndTouch } = require('./articleAnalytics.service');
const { invalid, slug, publicFilter, QUERY_MS } = require('./pulseDialogueDiscovery.service');

const buckets = new Map();

function parseEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Event.DISCOVERY_EVENT_TYPES.includes(payload.event)) {
    throw invalid('Invalid discovery event');
  }
  const targetField = payload.event === 'featured_dialogue_click' ? 'articleId'
    : payload.event === 'series_click' ? 'seriesSlug' : 'contributorSlug';
  if (Object.keys(payload).some(key => !['event', 'lang', 'visitorId', 'sessionId', targetField].includes(key))) {
    throw invalid('Unexpected discovery event field');
  }
  for (const field of ['visitorId', 'sessionId']) {
    if (typeof payload[field] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload[field])) throw invalid(`Invalid ${field}`);
  }
  const lang = payload.lang === undefined ? 'gu' : payload.lang;
  if (!['en', 'hi', 'gu'].includes(lang)) throw invalid('Invalid lang');
  const target = targetField === 'articleId' ? payload.articleId : slug(payload[targetField], targetField);
  if (targetField === 'articleId' && (typeof target !== 'string' || !/^[a-f\d]{24}$/i.test(target))) throw invalid('Invalid articleId');
  return { ...payload, lang, targetField, target };
}

function allowRequest(req, now) {
  const key = safeHash(req.ip || 'unknown');
  const previous = buckets.get(key);
  const bucket = previous && now - previous.started < 60000 ? previous : { started: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
  return bucket.count <= 60;
}

async function ingestDiscovery(req, payload) {
  const input = parseEvent(payload);
  const skip = shouldSkipAnalytics(req, { articleStatus: 'published' });
  if (skip.skip) return { skipped: true, reason: skip.reason };
  if (!allowRequest(req, Date.now())) return { skipped: true, reason: 'rate-limited' };
  if (mongoose.connection.readyState !== 1) return { skipped: true, reason: 'db-not-ready' };
  let target;
  let targetType;
  if (input.targetField === 'articleId') {
    targetType = 'article';
    target = await News.findOne(publicFilter({ _id: new mongoose.Types.ObjectId(input.target) })).select('_id slug').maxTimeMS(QUERY_MS).lean();
  } else if (input.targetField === 'seriesSlug') {
    targetType = 'series';
    target = await Series.findOne({ slug: input.target, profileVisible: true }).select('_id slug').maxTimeMS(QUERY_MS).lean();
  } else {
    targetType = 'contributor';
    target = await Contributor.findOne({ slug: input.target, profileVisible: true,
      status: input.event === 'featured_voice_click' ? 'active' : { $in: ['active', 'inactive'] } })
      .select('_id slug').maxTimeMS(QUERY_MS).lean();
  }
  if (!target) throw invalid('Discovery target is not publicly available');
  const visitorId = safeHash(input.visitorId);
  const sessionId = safeHash(input.sessionId);
  const allowed = await checkCooldownAndTouch({ kind: input.event, articleId: target._id, visitorId, sessionId,
    cooldownMs: 60000, ttlMs: 2 * 86400000, now: new Date(), maxTimeMS: QUERY_MS });
  if (!allowed) return { skipped: true, reason: 'cooldown' };
  await Event.create({ eventType: input.event, targetType, targetId: target._id,
    ...(targetType === 'article' ? { articleId: target._id } : {}),
    slug: target.slug || null, category: 'pulse-dialogue', language: input.lang, visitorId, sessionId,
    source: 'category', ipHash: safeHash(req.ip || ''), userAgentHash: safeHash(req.headers['user-agent'] || '') });
  return { skipped: false };
}

module.exports = { parseEvent, ingestDiscovery };