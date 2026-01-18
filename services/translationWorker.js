const mongoose = require('mongoose');

let TranslationJob;
let BroadcastItem;
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

const { translateBestOf, normalizeLang } = require('./translationGuard');
const { classifyTopics, isStrictTopic } = require('./translation/topics');

const JOB_KIND = {
  BROADCAST_ITEM: 'BROADCAST_ITEM',
};

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

  const docs = await TranslationJob.insertMany(unique.map((langTo) => ({
    kind: JOB_KIND.BROADCAST_ITEM,
    refId: itemId,
    langTo,
    // keep targetLangs for backward compatibility/debugging
    targetLangs: [langTo],
    status: 'QUEUED',
    attempts: 0,
    nextRunAt: new Date(),
    strictMode: Boolean(strictMode),
    reviewStatus: 'NONE',
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
  if (!BroadcastItem) {
    await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'BROADCAST_MODEL_MISSING', finishedAt: new Date() } });
    return;
  }

  if (job.kind !== JOB_KIND.BROADCAST_ITEM) {
    await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'UNKNOWN_JOB_KIND', finishedAt: new Date() } });
    return;
  }

  const itemId = job.refId;
  const item = await BroadcastItem.findById(itemId);
  if (!item) {
    await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'ITEM_NOT_FOUND', finishedAt: new Date() } });
    return;
  }

  const langTo = job.langTo || (Array.isArray(job.targetLangs) && job.targetLangs[0]) || null;
  const targetLang = langTo ? normalizeLang(langTo) : null;
  if (!targetLang) {
    await TranslationJob.updateOne({ _id: job._id }, { $set: { status: 'FAILED', lastError: 'MISSING_LANG_TO', finishedAt: new Date() } });
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

  // REVIEW mode: always produce a translation candidate for humans to approve.
  // Use GOOGLE-only by default via TRANSLATE_PROVIDERS default.
  const translated = await translateBestOf(sourceText, sourceLang, targetLang, {
    topicTags,
    // In review mode, don't enforce strict thresholds; humans will decide.
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

  // AUTO apply (non-strict OR strict-policy=AUTO)
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
};
