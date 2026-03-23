const crypto = require('crypto');
const mongoose = require('mongoose');

const Article = require('../models/Article');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsDaily = require('../models/ArticleAnalyticsDaily');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const ArticleAnalyticsDedup = require('../models/ArticleAnalyticsDedup');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function utcDateKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

function normalizeSource(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'unknown';
  const allowed = new Set([
    'homepage',
    'latest',
    'category',
    'related',
    'search',
    'google',
    'social',
    'direct',
    'push',
    'unknown',
  ]);
  return allowed.has(s) ? s : 'unknown';
}

function clampNumber(n, { min, max }) {
  const x = typeof n === 'number' ? n : parseFloat(String(n));
  if (!Number.isFinite(x)) return null;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function safeHash(input) {
  const salt = String(process.env.ANALYTICS_HASH_SALT || process.env.JWT_SECRET || 'dev-analytics-salt');
  const s = String(input || '');
  if (!s) return null;
  return crypto.createHash('sha256').update(salt).update('|').update(s).digest('hex');
}

function extractIp(req) {
  // express trust proxy is enabled in server.js
  const xff = String(req.headers['x-forwarded-for'] || '');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return String(req.ip || '').trim();
}

function isLoopbackIp(ip) {
  const s = String(ip || '').trim();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function isBotUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return false;
  return /(bot|crawler|spider|crawling|facebookexternalhit|slackbot|embedly|quora\slink\spreview|pinterest|discordbot|whatsapp|telegrambot|headless|lighthouse)/i.test(s);
}

function isAdminOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || req.headers.referrer || '');
  const combined = `${origin} ${referer}`.toLowerCase();
  return combined.includes('admin.newspulse.co.in');
}

function isLocalhostOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || req.headers.referrer || '');
  const host = String(req.headers.host || '');
  const combined = `${origin} ${referer} ${host}`.toLowerCase();
  return combined.includes('localhost') || combined.includes('127.0.0.1');
}

async function getArticleBasicsCached(articleId) {
  const id = String(articleId || '').trim();
  if (!mongoose.isValidObjectId(id)) return null;

  // Tiny in-process cache to reduce DB lookups
  if (!getArticleBasicsCached._cache) getArticleBasicsCached._cache = new Map();
  const cache = getArticleBasicsCached._cache;
  const now = Date.now();

  const cached = cache.get(id);
  if (cached && cached.expiresAt > now) return cached.value;

  if (!isDbReady()) return null;

  const doc = await Article.findById(id)
    .select('slug category language status publishedAt')
    .lean();

  const value = doc
    ? {
        articleId: doc._id,
        slug: doc.slug || null,
        category: doc.category || null,
        language: doc.language || null,
        status: doc.status || null,
        publishedAt: doc.publishedAt || null,
      }
    : null;

  cache.set(id, { value, expiresAt: now + 5 * 60_000 });
  // naive cap
  if (cache.size > 5000) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }

  return value;
}

function shouldSkipAnalytics(req, { articleStatus = null, previewMode = false } = {}) {
  const enabled = String(process.env.ANALYTICS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return { skip: true, reason: 'disabled' };

  const allowLocalhost = String(process.env.ANALYTICS_ALLOW_LOCALHOST || '').toLowerCase() === 'true';

  const ip = extractIp(req);
  if (!allowLocalhost) {
    if (isLoopbackIp(ip)) return { skip: true, reason: 'loopback-ip' };
    if (isLocalhostOrigin(req)) return { skip: true, reason: 'localhost-origin' };
  }
  if (isAdminOrigin(req)) return { skip: true, reason: 'admin-origin' };

  const ua = String(req.headers['user-agent'] || '');
  if (isBotUserAgent(ua)) return { skip: true, reason: 'bot-ua' };

  const purpose = String(req.headers.purpose || req.headers['sec-purpose'] || '').toLowerCase();
  if (purpose.includes('prefetch')) return { skip: true, reason: 'prefetch' };

  if (previewMode) return { skip: true, reason: 'preview-mode' };

  const allowUnpublished = String(process.env.ANALYTICS_ALLOW_UNPUBLISHED || '').toLowerCase() === 'true';
  if (!allowUnpublished && articleStatus && String(articleStatus) !== 'published') {
    return { skip: true, reason: 'unpublished' };
  }

  return { skip: false, reason: null };
}

async function _incBreakdownBySource(model, filter, source, inc = 1) {
  const key = normalizeSource(source);
  const updateExisting = await model.updateOne(
    { ...filter, 'sourceBreakdown.source': key },
    { $inc: { 'sourceBreakdown.$.count': inc } }
  );
  if (updateExisting && updateExisting.modifiedCount > 0) return;
  await model.updateOne(filter, { $push: { sourceBreakdown: { source: key, count: inc } } });
}

async function _incBreakdownByLanguage(model, filter, language, inc = 1) {
  const key = String(language || '').trim().toLowerCase() || 'unknown';
  const updateExisting = await model.updateOne(
    { ...filter, 'languageBreakdown.language': key },
    { $inc: { 'languageBreakdown.$.count': inc } }
  );
  if (updateExisting && updateExisting.modifiedCount > 0) return;
  await model.updateOne(filter, { $push: { languageBreakdown: { language: key, count: inc } } });
}

async function _recomputeDailyDerived(articleId, dateKey) {
  await ArticleAnalyticsDaily.updateOne(
    { articleId, dateKey },
    [
      {
        $set: {
          avgReadTimeSec: {
            $cond: [{ $gt: ['$views', 0] }, { $divide: ['$totalReadTimeSec', '$views'] }, 0],
          },
          completionRate: {
            $cond: [{ $gt: ['$views', 0] }, { $divide: ['$scroll100Count', '$views'] }, 0],
          },
        },
      },
    ]
  );
}

async function _recomputeSummaryDerived(articleId) {
  await ArticleAnalyticsSummary.updateOne(
    { articleId },
    [
      {
        $set: {
          avgReadTimeSec: {
            $cond: [{ $gt: ['$totalViews', 0] }, { $divide: ['$totalReadTimeSec', '$totalViews'] }, 0],
          },
          completionRate: {
            $cond: [{ $gt: ['$totalViews', 0] }, { $divide: ['$scroll100Count', '$totalViews'] }, 0],
          },
        },
      },
    ]
  );
}

async function _ensureDailyRow({ articleId, slug, category, language, dateKey, now }) {
  await ArticleAnalyticsDaily.updateOne(
    { articleId, dateKey },
    {
      $setOnInsert: {
        articleId,
        dateKey,
        views: 0,
        uniqueReaders: 0,
        engagedReads: 0,
        totalReadTimeSec: 0,
        avgReadTimeSec: 0,
        scroll25Count: 0,
        scroll50Count: 0,
        scroll75Count: 0,
        scroll100Count: 0,
        completionRate: 0,
        sourceBreakdown: [],
        languageBreakdown: [],
      },
      $set: {
        slug: slug || null,
        category: category || null,
        language: language || null,
        updatedAt: now,
      },
    },
    { upsert: true }
  );
}

async function _ensureSummaryRow({ articleId, slug, category, language, now }) {
  await ArticleAnalyticsSummary.updateOne(
    { articleId },
    {
      $setOnInsert: {
        articleId,
        totalViews: 0,
        totalUniqueReaders: 0,
        totalEngagedReads: 0,
        totalReadTimeSec: 0,
        avgReadTimeSec: 0,
        scroll25Count: 0,
        scroll50Count: 0,
        scroll75Count: 0,
        scroll100Count: 0,
        completionRate: 0,
        sourceBreakdown: [],
        topSources: [],
        languageBreakdown: [],
        last24hViews: 0,
        last7dViews: 0,
      },
      $set: {
        slug: slug || null,
        category: category || null,
        language: language || null,
        updatedAt: now,
      },
    },
    { upsert: true }
  );
}

async function _createDedupKey(doc) {
  try {
    await ArticleAnalyticsDedup.create(doc);
    return true;
  } catch (e) {
    if (String(e?.code) === '11000' || String(e?.message || '').includes('E11000')) return false;
    throw e;
  }
}

async function _checkCooldownAndTouch({ kind, articleId, visitorId, sessionId, cooldownMs, ttlMs, now }) {
  const threshold = new Date(now.getTime() - cooldownMs);
  const key = { kind, articleId, visitorId, sessionId, dateKey: '0', milestone: -1 };

  const updated = await ArticleAnalyticsDedup.updateOne(
    { ...key, lastAt: { $lt: threshold } },
    { $set: { lastAt: now, expiresAt: new Date(now.getTime() + ttlMs) } },
  );

  if (updated && updated.modifiedCount > 0) return true;

  // If it didn't update, try to insert the key (first-seen) or treat as cooldown-hit.
  try {
    await ArticleAnalyticsDedup.create({
      ...key,
      lastAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      createdAt: now,
    });
    return true;
  } catch (e) {
    if (String(e?.code) === '11000' || String(e?.message || '').includes('E11000')) return false;
    throw e;
  }
}

async function ingestView(req, payload) {
  if (!isDbReady()) return { ok: true, skipped: true, reason: 'db-not-ready' };

  const now = new Date();
  const dateKey = utcDateKey(now);

  const articleId = payload && payload.articleId;
  const visitorId = String(payload?.visitorId || '').trim();
  const sessionId = String(payload?.sessionId || '').trim();

  if (!mongoose.isValidObjectId(String(articleId || '')) || !visitorId || !sessionId) {
    return { ok: true, skipped: true, reason: 'missing-ids' };
  }

  const article = await getArticleBasicsCached(articleId);
  if (!article) return { ok: true, skipped: true, reason: 'article-not-found' };

  const previewMode = Boolean(payload?.previewMode || payload?.isPreview || req.query?.preview === '1');
  const skip = shouldSkipAnalytics(req, { articleStatus: article.status, previewMode });
  if (skip.skip) return { ok: true, skipped: true, reason: skip.reason };

  const viewCooldownMs = Math.max(5_000, Math.min(5 * 60_000, parseInt(process.env.ANALYTICS_VIEW_COOLDOWN_MS || '60000', 10) || 60_000));
  const allowed = await _checkCooldownAndTouch({
    kind: 'view_cooldown',
    articleId: article.articleId,
    visitorId,
    sessionId,
    cooldownMs: viewCooldownMs,
    ttlMs: 2 * 24 * 60 * 60_000,
    now,
  });
  if (!allowed) return { ok: true, skipped: true, reason: 'view-cooldown' };

  const unique = await _createDedupKey({
    kind: 'unique_reader_day',
    articleId: article.articleId,
    visitorId,
    sessionId: '0',
    dateKey,
    milestone: -1,
    lastAt: now,
    expiresAt: new Date(now.getTime() + 10 * 24 * 60 * 60_000),
    createdAt: now,
  });

  const source = normalizeSource(payload?.source);
  const ip = extractIp(req);
  const ua = String(req.headers['user-agent'] || '');

  await ArticleAnalyticsEvent.create({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    eventType: 'view',
    visitorId,
    sessionId,
    source,
    referrer: payload?.referrer ? String(payload.referrer).slice(0, 500) : null,
    deviceType: payload?.deviceType ? String(payload.deviceType).slice(0, 40) : null,
    country: payload?.country ? String(payload.country).slice(0, 60) : null,
    state: payload?.state ? String(payload.state).slice(0, 60) : null,
    city: payload?.city ? String(payload.city).slice(0, 60) : null,
    userAgentHash: safeHash(ua),
    ipHash: safeHash(ip),
  });

  await _ensureDailyRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    dateKey,
    now,
  });

  await _ensureSummaryRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    now,
  });

  await ArticleAnalyticsDaily.updateOne(
    { articleId: article.articleId, dateKey },
    {
      $inc: {
        views: 1,
        ...(unique ? { uniqueReaders: 1 } : {}),
      },
      $set: { updatedAt: now },
    }
  );

  await ArticleAnalyticsSummary.updateOne(
    { articleId: article.articleId },
    {
      $inc: {
        totalViews: 1,
        ...(unique ? { totalUniqueReaders: 1 } : {}),
      },
      $set: { updatedAt: now },
    }
  );

  await Promise.all([
    _incBreakdownBySource(ArticleAnalyticsDaily, { articleId: article.articleId, dateKey }, source, 1),
    _incBreakdownByLanguage(ArticleAnalyticsDaily, { articleId: article.articleId, dateKey }, article.language, 1),
    _incBreakdownBySource(ArticleAnalyticsSummary, { articleId: article.articleId }, source, 1),
    _incBreakdownByLanguage(ArticleAnalyticsSummary, { articleId: article.articleId }, article.language, 1),
  ]);

  await Promise.all([
    _recomputeDailyDerived(article.articleId, dateKey),
    _recomputeSummaryDerived(article.articleId),
  ]);

  return { ok: true, skipped: false, uniqueCounted: unique };
}

async function ingestEngagement(req, payload) {
  if (!isDbReady()) return { ok: true, skipped: true, reason: 'db-not-ready' };

  const now = new Date();
  const dateKey = utcDateKey(now);

  const articleId = payload && payload.articleId;
  const visitorId = String(payload?.visitorId || '').trim();
  const sessionId = String(payload?.sessionId || '').trim();

  if (!mongoose.isValidObjectId(String(articleId || '')) || !visitorId || !sessionId) {
    return { ok: true, skipped: true, reason: 'missing-ids' };
  }

  const article = await getArticleBasicsCached(articleId);
  if (!article) return { ok: true, skipped: true, reason: 'article-not-found' };

  const previewMode = Boolean(payload?.previewMode || payload?.isPreview || req.query?.preview === '1');
  const skip = shouldSkipAnalytics(req, { articleStatus: article.status, previewMode });
  if (skip.skip) return { ok: true, skipped: true, reason: skip.reason };

  const readTimeSec = clampNumber(payload?.readTimeSec, { min: 0, max: 3600 });
  const scrollPercent = clampNumber(payload?.scrollPercent, { min: 0, max: 100 });

  const isEngaged = (readTimeSec !== null && readTimeSec >= 15) && (scrollPercent !== null && scrollPercent >= 50);
  if (!isEngaged) return { ok: true, skipped: true, reason: 'not-engaged' };

  const counted = await _createDedupKey({
    kind: 'engaged_session',
    articleId: article.articleId,
    visitorId,
    sessionId,
    dateKey: '0',
    milestone: -1,
    lastAt: now,
    expiresAt: new Date(now.getTime() + 10 * 24 * 60 * 60_000),
    createdAt: now,
  });

  if (!counted) return { ok: true, skipped: true, reason: 'engaged-already-counted' };

  await ArticleAnalyticsEvent.create({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    eventType: 'engaged_read',
    visitorId,
    sessionId,
    source: normalizeSource(payload?.source),
    readTimeSec,
    scrollPercent,
    userAgentHash: safeHash(String(req.headers['user-agent'] || '')),
    ipHash: safeHash(extractIp(req)),
  });

  await _ensureDailyRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    dateKey,
    now,
  });
  await _ensureSummaryRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    now,
  });

  await ArticleAnalyticsDaily.updateOne(
    { articleId: article.articleId, dateKey },
    { $inc: { engagedReads: 1 }, $set: { updatedAt: now } }
  );
  await ArticleAnalyticsSummary.updateOne(
    { articleId: article.articleId },
    { $inc: { totalEngagedReads: 1 }, $set: { updatedAt: now } }
  );

  return { ok: true, skipped: false };
}

async function ingestScroll(req, payload) {
  if (!isDbReady()) return { ok: true, skipped: true, reason: 'db-not-ready' };

  const now = new Date();
  const dateKey = utcDateKey(now);

  const articleId = payload && payload.articleId;
  const visitorId = String(payload?.visitorId || '').trim();
  const sessionId = String(payload?.sessionId || '').trim();

  if (!mongoose.isValidObjectId(String(articleId || '')) || !visitorId || !sessionId) {
    return { ok: true, skipped: true, reason: 'missing-ids' };
  }

  const article = await getArticleBasicsCached(articleId);
  if (!article) return { ok: true, skipped: true, reason: 'article-not-found' };

  const previewMode = Boolean(payload?.previewMode || payload?.isPreview || req.query?.preview === '1');
  const skip = shouldSkipAnalytics(req, { articleStatus: article.status, previewMode });
  if (skip.skip) return { ok: true, skipped: true, reason: skip.reason };

  const milestoneRaw = parseInt(String(payload?.milestone || ''), 10);
  const allowedMilestones = new Set([25, 50, 75, 100]);
  const milestone = allowedMilestones.has(milestoneRaw) ? milestoneRaw : null;
  if (!milestone) return { ok: true, skipped: true, reason: 'bad-milestone' };

  const counted = await _createDedupKey({
    kind: 'scroll_milestone',
    articleId: article.articleId,
    visitorId,
    sessionId,
    dateKey: '0',
    milestone,
    lastAt: now,
    expiresAt: new Date(now.getTime() + 10 * 24 * 60 * 60_000),
    createdAt: now,
  });
  if (!counted) return { ok: true, skipped: true, reason: 'milestone-already-counted' };

  await ArticleAnalyticsEvent.create({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    eventType: milestone === 25 ? 'scroll_25' : milestone === 50 ? 'scroll_50' : milestone === 75 ? 'scroll_75' : 'scroll_100',
    visitorId,
    sessionId,
    source: normalizeSource(payload?.source),
    scrollPercent: milestone,
    userAgentHash: safeHash(String(req.headers['user-agent'] || '')),
    ipHash: safeHash(extractIp(req)),
  });

  await _ensureDailyRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    dateKey,
    now,
  });
  await _ensureSummaryRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    now,
  });

  const dailyInc = {};
  const summaryInc = {};
  if (milestone === 25) { dailyInc.scroll25Count = 1; summaryInc.scroll25Count = 1; }
  if (milestone === 50) { dailyInc.scroll50Count = 1; summaryInc.scroll50Count = 1; }
  if (milestone === 75) { dailyInc.scroll75Count = 1; summaryInc.scroll75Count = 1; }
  if (milestone === 100) { dailyInc.scroll100Count = 1; summaryInc.scroll100Count = 1; }

  await ArticleAnalyticsDaily.updateOne(
    { articleId: article.articleId, dateKey },
    { $inc: dailyInc, $set: { updatedAt: now } }
  );

  await ArticleAnalyticsSummary.updateOne(
    { articleId: article.articleId },
    { $inc: summaryInc, $set: { updatedAt: now } }
  );

  await Promise.all([
    _recomputeDailyDerived(article.articleId, dateKey),
    _recomputeSummaryDerived(article.articleId),
  ]);

  return { ok: true, skipped: false };
}

async function ingestHeartbeat(req, payload) {
  if (!isDbReady()) return { ok: true, skipped: true, reason: 'db-not-ready' };

  const now = new Date();
  const dateKey = utcDateKey(now);

  const articleId = payload && payload.articleId;
  const visitorId = String(payload?.visitorId || '').trim();
  const sessionId = String(payload?.sessionId || '').trim();

  if (!mongoose.isValidObjectId(String(articleId || '')) || !visitorId || !sessionId) {
    return { ok: true, skipped: true, reason: 'missing-ids' };
  }

  const article = await getArticleBasicsCached(articleId);
  if (!article) return { ok: true, skipped: true, reason: 'article-not-found' };

  const previewMode = Boolean(payload?.previewMode || payload?.isPreview || req.query?.preview === '1');
  const skip = shouldSkipAnalytics(req, { articleStatus: article.status, previewMode });
  if (skip.skip) return { ok: true, skipped: true, reason: skip.reason };

  const heartbeatCooldownMs = Math.max(2_000, Math.min(60_000, parseInt(process.env.ANALYTICS_HEARTBEAT_COOLDOWN_MS || '10000', 10) || 10_000));
  const allowed = await _checkCooldownAndTouch({
    kind: 'heartbeat_cooldown',
    articleId: article.articleId,
    visitorId,
    sessionId,
    cooldownMs: heartbeatCooldownMs,
    ttlMs: 24 * 60 * 60_000,
    now,
  });
  if (!allowed) return { ok: true, skipped: true, reason: 'heartbeat-cooldown' };

  // Heartbeat readTimeSec is treated as incremental seconds for the interval.
  const readTimeSecRaw = clampNumber(payload?.readTimeSec, { min: 0, max: 300 });
  if (readTimeSecRaw === null || readTimeSecRaw === 0) return { ok: true, skipped: true, reason: 'no-readtime' };

  await ArticleAnalyticsEvent.create({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    eventType: 'heartbeat',
    visitorId,
    sessionId,
    source: normalizeSource(payload?.source),
    readTimeSec: readTimeSecRaw,
    userAgentHash: safeHash(String(req.headers['user-agent'] || '')),
    ipHash: safeHash(extractIp(req)),
  });

  await _ensureDailyRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    dateKey,
    now,
  });
  await _ensureSummaryRow({
    articleId: article.articleId,
    slug: article.slug,
    category: article.category,
    language: article.language,
    now,
  });

  await ArticleAnalyticsDaily.updateOne(
    { articleId: article.articleId, dateKey },
    { $inc: { totalReadTimeSec: readTimeSecRaw }, $set: { updatedAt: now } }
  );
  await ArticleAnalyticsSummary.updateOne(
    { articleId: article.articleId },
    { $inc: { totalReadTimeSec: readTimeSecRaw }, $set: { updatedAt: now } }
  );

  await Promise.all([
    _recomputeDailyDerived(article.articleId, dateKey),
    _recomputeSummaryDerived(article.articleId),
  ]);

  return { ok: true, skipped: false };
}

module.exports = {
  utcDateKey,
  normalizeSource,
  shouldSkipAnalytics,
  ingestView,
  ingestEngagement,
  ingestScroll,
  ingestHeartbeat,
  safeHash,
};
