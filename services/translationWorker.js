const mongoose = require('mongoose');

let TranslationJob;
let BroadcastItem;
let News;
try {
  TranslationJob = require('../models/TranslationJob');
} catch (_) {
  TranslationJob = null;
}
try {
  BroadcastItem = require('../models/BroadcastItem');
} catch (_) {
  BroadcastItem = null;
}
try {
  News = require('../models/News');
} catch (_) {
  News = null;
}

const { translateBestOf, normalizeLang } = require('./translationGuard');
const { classifyTopics, isStrictTopic } = require('./translation/topics');

const JOB_KIND = {
  BROADCAST_ITEM: 'BROADCAST_ITEM',
  NEWS_ARTICLE: 'NEWS_ARTICLE',
};

function _slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function _hasGoogleProviderButNoKey() {
  const hasGoogleKey = !!String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const providersRaw = String(process.env.TRANSLATE_PROVIDERS || '').trim() || 'GOOGLE';
  const providers = providersRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const usingGoogle = providers.length === 0 || providers.includes('GOOGLE');
  return usingGoogle && !hasGoogleKey;
}

function _supportedLangs() {
  return ['en', 'hi', 'gu'];
}

function isEnabled() {
  return String(process.env.TRANSLATION_QUEUE_ENABLED || '').trim() === '1';
}

function strictModePolicy() {
  const v = String(process.env.TRANSLATE_STRICT_MODE || 'AUTO').trim().toUpperCase();
  return v === 'REVIEW' ? 'REVIEW' : 'AUTO';
}

function workerIntervalMs() {
  const n = Number(process.env.TRANSLATION_WORKER_INTERVAL_MS || 2000);
  if (!Number.isFinite(n) || n < 500) return 2000;
  return n;
}

async function enqueueBroadcastItemJob({ itemId, targetLangs, strictMode }) {
  if (!TranslationJob) return { ok: false, reason: 'MODEL_MISSING' };
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return { ok: false, reason: 'DB_UNAVAILABLE' };
  const langs = (Array.isArray(targetLangs) ? targetLangs : ['en', 'hi']).map(l => normalizeLang(l));
  const unique = Array.from(new Set(langs));

  // Phase 1 requirement: if Google provider is not configured, enqueue as BLOCKED with reason.
  // Do not crash; allow the admin UI to see the jobs are blocked.
  const shouldBlockForProvider = _hasGoogleProviderButNoKey();

  const docs = await TranslationJob.insertMany(unique.map((langTo) => ({
    kind: JOB_KIND.BROADCAST_ITEM,
    refId: itemId,
    langTo,
    // keep targetLangs for backward compatibility/debugging
    targetLangs: [langTo],
    status: shouldBlockForProvider ? 'BLOCKED' : 'QUEUED',
    attempts: 0,
    nextRunAt: new Date(),
    strictMode: Boolean(strictMode),
    reviewStatus: 'NONE',
    ...(shouldBlockForProvider
      ? {
          providerUsed: 'GOOGLE',
          reason: 'PROVIDER_NOT_CONFIGURED',
          lastError: 'PROVIDER_NOT_CONFIGURED',
        }
      : {}),
  })));

  const ids = docs.map(d => String(d._id));
  return { ok: true, ids, id: ids[0] };
}

async function enqueueNewsArticleJob({ newsId, targetLangs, strictMode }) {
  if (!TranslationJob) return { ok: false, reason: 'MODEL_MISSING' };
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return { ok: false, reason: 'DB_UNAVAILABLE' };

  const langs = (Array.isArray(targetLangs) ? targetLangs : _supportedLangs())
    .map(l => normalizeLang(l))
    .filter(Boolean);
  const unique = Array.from(new Set(langs));

  const shouldBlockForProvider = _hasGoogleProviderButNoKey();

  const docs = await TranslationJob.insertMany(unique.map((langTo) => ({
    kind: JOB_KIND.NEWS_ARTICLE,
    refId: newsId,
    langTo,
    targetLangs: [langTo],
    status: shouldBlockForProvider ? 'BLOCKED' : 'QUEUED',
    attempts: 0,
    nextRunAt: new Date(),
    strictMode: Boolean(strictMode),
    reviewStatus: 'NONE',
    ...(shouldBlockForProvider
      ? {
          providerUsed: 'GOOGLE',
          reason: 'PROVIDER_NOT_CONFIGURED',
          lastError: 'PROVIDER_NOT_CONFIGURED',
        }
      : {}),
  })));

  const ids = docs.map(d => String(d._id));
  return { ok: true, ids, id: ids[0] };
}

async function claimNextJob() {
  if (!TranslationJob) return null;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return null;
  const now = new Date();
  return TranslationJob.findOneAndUpdate(
    { status: 'QUEUED', nextRunAt: { $lte: now } },
    { $set: { status: 'PROCESSING', startedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextRunAt: 1, createdAt: 1 }, new: true },
  );
}

function _retryDelayMs(attempts) {
  const base = 2000;
  const exp = Math.min(5, Math.max(0, attempts - 1));
  return base * Math.pow(2, exp);
}

async function processJob(job) {
  if (!job) return;

  const langTo = job.langTo || (Array.isArray(job.targetLangs) && job.targetLangs[0]) || null;
  const targetLang = langTo ? normalizeLang(langTo) : null;
  if (!targetLang) {
    await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'MISSING_LANG_TO', finishedAt: new Date() } });
    return;
  }

  if (job.kind === JOB_KIND.BROADCAST_ITEM) {
    if (!BroadcastItem) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'BROADCAST_MODEL_MISSING', finishedAt: new Date() } });
      return;
    }

    const itemId = job.refId;
    const item = await BroadcastItem.findById(itemId);
    if (!item) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'ITEM_NOT_FOUND', finishedAt: new Date() } });
      return;
    }

    const sourceLang = normalizeLang(item.sourceLang, 'gu');
    const sourceText = String((item.textByLang && item.textByLang[sourceLang]) || item.text || '').trim();
    if (!sourceText) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'EMPTY_SOURCE', finishedAt: new Date() } });
      return;
    }

    const topicTags = classifyTopics(sourceText);
    const strictTopic = isStrictTopic(topicTags);
    const strictPolicy = strictModePolicy();
    const isReviewMode = strictTopic && strictPolicy === 'REVIEW';

    const translated = await translateBestOf(sourceText, sourceLang, targetLang, {
      topicTags,
      ...(isReviewMode ? { strictByTopic: false, minApprovalScore: 0 } : {}),
    });

    if (!translated || translated.status !== 'APPROVED' || typeof translated.text !== 'string' || !translated.text.trim()) {
      const attempts = job.attempts || 1;
      const delay = _retryDelayMs(attempts);
      await TranslationJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: attempts >= 5 ? 'FAILED' : 'QUEUED',
            nextRunAt: new Date(Date.now() + delay),
            lastError: (translated && Array.isArray(translated.reasons) && translated.reasons[0]) ? translated.reasons[0] : 'TRANSLATION_BLOCKED',
            finishedAt: attempts >= 5 ? new Date() : undefined,
            langFrom: sourceLang,
            langTo: targetLang,
            strictTopic,
            topicTags,
          },
        },
      );
      return;
    }

    if (isReviewMode) {
      console.log('[translation-worker] strict topic -> NEEDS_REVIEW', {
        jobId: String(job._id),
        refId: String(item._id),
        langFrom: sourceLang,
        langTo: targetLang,
        providerUsed: translated.engineUsed || 'GOOGLE',
        qualityScore: translated.qualityScore || 0,
        tags: topicTags,
      });

      await TranslationJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'NEEDS_REVIEW',
            reviewStatus: 'NEEDS_REVIEW',
            langFrom: sourceLang,
            langTo: targetLang,
            providerUsed: translated.engineUsed || 'GOOGLE',
            qualityScore: typeof translated.qualityScore === 'number' ? translated.qualityScore : undefined,
            translatedText: String(translated.text || '').trim(),
            strictTopic,
            topicTags,
            finishedAt: new Date(),
            lastError: null,
          },
        },
      );
      return;
    }

    item.textByLang = item.textByLang && typeof item.textByLang === 'object' ? item.textByLang : {};
    item.statusByLang = item.statusByLang && typeof item.statusByLang === 'object' ? item.statusByLang : {};
    item.qualityByLang = item.qualityByLang && typeof item.qualityByLang === 'object' ? item.qualityByLang : {};

    item.textByLang[targetLang] = String(translated.text || '').trim().slice(0, 160);
    item.statusByLang[targetLang] = 'APPROVED';
    item.qualityByLang[targetLang] = typeof translated.qualityScore === 'number' ? translated.qualityScore : 0;
    await item.save();

    console.log('[translation-worker] applied translation -> DONE', {
      jobId: String(job._id),
      refId: String(item._id),
      langFrom: sourceLang,
      langTo: targetLang,
      providerUsed: translated.engineUsed || 'GOOGLE',
      qualityScore: translated.qualityScore || 0,
      strictTopic,
    });

    await TranslationJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'DONE',
          reviewStatus: 'NONE',
          langFrom: sourceLang,
          langTo: targetLang,
          providerUsed: translated.engineUsed || 'GOOGLE',
          qualityScore: typeof translated.qualityScore === 'number' ? translated.qualityScore : undefined,
          translatedText: String(translated.text || '').trim(),
          strictTopic,
          topicTags,
          finishedAt: new Date(),
          lastError: null,
        },
      },
    );
    return;
  }

  if (job.kind === JOB_KIND.NEWS_ARTICLE) {
    if (!News) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'NEWS_MODEL_MISSING', finishedAt: new Date() } });
      return;
    }

    const source = await News.findById(job.refId);
    if (!source) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'NEWS_NOT_FOUND', finishedAt: new Date() } });
      return;
    }

    const sourceLang = normalizeLang(source.lang || source.language, 'gu');
    const sourceTitle = String(source.title || '').trim();
    const sourceDescription = String(source.description || '').trim();
    const sourceContent = String(source.content || '').trim();
    if (!sourceTitle && !sourceDescription && !sourceContent) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'EMPTY_SOURCE', finishedAt: new Date() } });
      return;
    }

    if (!source.translationGroupId) {
      await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'MISSING_TRANSLATION_GROUP_ID', finishedAt: new Date() } });
      return;
    }

    const topicText = `${sourceTitle}\n${sourceDescription}\n${sourceContent.slice(0, 1200)}`.trim();
    const topicTags = classifyTopics(topicText);
    const strictTopic = isStrictTopic(topicTags);
    const strictPolicy = strictModePolicy();
    const isReviewMode = strictTopic && strictPolicy === 'REVIEW';

    async function translateLongText(text, opts) {
      const raw = String(text || '');
      const maxChunk = 2600;
      const paras = raw.split(/\n\n+/g);
      const chunks = [];
      let buf = '';
      for (const p of paras) {
        const part = String(p || '').trim();
        if (!part) continue;
        if (!buf) {
          buf = part;
          continue;
        }
        if ((buf.length + 2 + part.length) <= maxChunk) {
          buf = `${buf}\n\n${part}`;
        } else {
          chunks.push(buf);
          buf = part;
        }
      }
      if (buf) chunks.push(buf);
      if (chunks.length === 0) chunks.push(raw);

      const translatedChunks = [];
      const scores = [];
      let engineUsed = null;
      for (const c of chunks) {
        const r = await translateBestOf(c, sourceLang, targetLang, opts);
        if (!r || r.status !== 'APPROVED' || typeof r.text !== 'string' || !r.text.trim()) {
          return { ok: false, reason: (r && Array.isArray(r.reasons) && r.reasons[0]) ? r.reasons[0] : 'TRANSLATION_BLOCKED', qa: r && r.qa ? r.qa : null };
        }
        translatedChunks.push(String(r.text || '').trim());
        if (typeof r.qualityScore === 'number') scores.push(r.qualityScore);
        if (!engineUsed && r.engineUsed) engineUsed = r.engineUsed;
      }
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
      return { ok: true, text: translatedChunks.join('\n\n'), qualityScore: avg, engineUsed };
    }

    const translateOpts = {
      topicTags,
      ...(isReviewMode ? { strictByTopic: false, minApprovalScore: 0 } : {}),
    };

    const titleRes = sourceTitle ? await translateBestOf(sourceTitle, sourceLang, targetLang, translateOpts) : { status: 'APPROVED', text: '' };
    const descRes = sourceDescription ? await translateBestOf(sourceDescription, sourceLang, targetLang, translateOpts) : { status: 'APPROVED', text: '' };
    const contentRes = sourceContent ? await translateLongText(sourceContent, translateOpts) : { ok: true, text: '' };

    const titleOk = !sourceTitle || (titleRes && titleRes.status === 'APPROVED' && typeof titleRes.text === 'string');
    const descOk = !sourceDescription || (descRes && descRes.status === 'APPROVED' && typeof descRes.text === 'string');
    const contentOk = !sourceContent || (contentRes && contentRes.ok);

    if (!titleOk || !descOk || !contentOk) {
      const attempts = job.attempts || 1;
      const delay = _retryDelayMs(attempts);
      const reason = (!titleOk && titleRes && Array.isArray(titleRes.reasons) && titleRes.reasons[0])
        ? titleRes.reasons[0]
        : (!descOk && descRes && Array.isArray(descRes.reasons) && descRes.reasons[0])
          ? descRes.reasons[0]
          : (contentRes && contentRes.reason) ? contentRes.reason : 'TRANSLATION_BLOCKED';

      await TranslationJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: attempts >= 5 ? 'FAILED' : 'QUEUED',
            nextRunAt: new Date(Date.now() + delay),
            lastError: reason,
            finishedAt: attempts >= 5 ? new Date() : undefined,
            langFrom: sourceLang,
            langTo: targetLang,
            strictTopic,
            topicTags,
          },
        },
      );
      return;
    }

    const translatedFields = {
      title: String((titleRes && titleRes.text) || '').trim(),
      description: String((descRes && descRes.text) || '').trim(),
      content: String((contentRes && contentRes.text) || '').trim(),
    };

    const scores = [
      typeof titleRes?.qualityScore === 'number' ? titleRes.qualityScore : null,
      typeof descRes?.qualityScore === 'number' ? descRes.qualityScore : null,
      typeof contentRes?.qualityScore === 'number' ? contentRes.qualityScore : null,
    ].filter(n => typeof n === 'number');
    const qualityScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;

    const providerUsed =
      (contentRes && contentRes.engineUsed) ||
      (titleRes && titleRes.engineUsed) ||
      (descRes && descRes.engineUsed) ||
      'GOOGLE';

    if (isReviewMode) {
      console.log('[translation-worker] strict topic (news) -> NEEDS_REVIEW', {
        jobId: String(job._id),
        refId: String(source._id),
        langFrom: sourceLang,
        langTo: targetLang,
        providerUsed,
        qualityScore: qualityScore || 0,
        tags: topicTags,
      });

      await TranslationJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'NEEDS_REVIEW',
            reviewStatus: 'NEEDS_REVIEW',
            langFrom: sourceLang,
            langTo: targetLang,
            providerUsed,
            qualityScore,
            translatedText: translatedFields.title || translatedFields.description || '',
            translatedFields,
            strictTopic,
            topicTags,
            finishedAt: new Date(),
            lastError: null,
          },
        },
      );
      return;
    }

    const baseSlug = source.slug ? String(source.slug) : _slugify(sourceTitle) || String(source._id);
    const slug = `${baseSlug}-${targetLang}`.slice(0, 180);

    const now = new Date();
    const isPublished = String(source.status || '').toLowerCase() === 'published';

    const q = {
      translationGroupId: String(source.translationGroupId),
      $or: [{ lang: targetLang }, { language: targetLang }],
    };

    const update = {
      title: translatedFields.title || sourceTitle,
      description: translatedFields.description || sourceDescription,
      content: translatedFields.content || sourceContent,
      slug,
      tags: Array.isArray(source.tags) ? source.tags : [],
      category: source.category,
      translationGroupId: String(source.translationGroupId),
      lang: targetLang,
      language: targetLang,
      imageURL: source.imageURL || source.coverImageUrl || null,
      coverImageUrl: source.coverImageUrl || source.imageURL || null,
      status: isPublished ? 'published' : 'draft',
      publishedAt: isPublished ? (source.publishedAt || now) : null,
      workflowStage: isPublished ? 'PUBLISHED' : 'DRAFT',
      workflowUpdatedAt: now,
    };

    await News.findOneAndUpdate(q, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });

    console.log('[translation-worker] applied news translation -> DONE', {
      jobId: String(job._id),
      refId: String(source._id),
      langFrom: sourceLang,
      langTo: targetLang,
      providerUsed,
      qualityScore: qualityScore || 0,
      strictTopic,
    });

    await TranslationJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'DONE',
          reviewStatus: 'NONE',
          langFrom: sourceLang,
          langTo: targetLang,
          providerUsed,
          qualityScore,
          translatedText: translatedFields.title || translatedFields.description || '',
          translatedFields,
          strictTopic,
          topicTags,
          finishedAt: new Date(),
          lastError: null,
        },
      },
    );
    return;
  }

  await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'UNKNOWN_JOB_KIND', finishedAt: new Date() } });
}

let _timer = null;
let _running = false;

function startWorker() {
  if (!isEnabled()) return { ok: false, reason: 'DISABLED' };
  if (_timer) return { ok: true, already: true };

  console.log('[translation-worker] starting', {
    enabled: true,
    intervalMs: workerIntervalMs(),
    strictMode: strictModePolicy(),
    providers: String(process.env.TRANSLATE_PROVIDERS || 'GOOGLE'),
    hasGoogleKey: !!String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim(),
  });

  _timer = setInterval(async () => {
    if (_running) return;
    _running = true;
    try {
      const job = await claimNextJob();
      if (job) await processJob(job);
    } catch (_) {
      // swallow
    } finally {
      _running = false;
    }
  }, workerIntervalMs());

  _timer.unref && _timer.unref();
  return { ok: true };
}

function stopWorker() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _running = false;
}

module.exports = {
  JOB_KIND,
  isEnabled,
  startWorker,
  stopWorker,
  enqueueBroadcastItemJob,
  enqueueNewsArticleJob,
};
