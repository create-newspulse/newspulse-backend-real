const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');

let TranslationJob;
let BroadcastItem;
let News;
let TranslationMemory;
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
try {
  TranslationMemory = require('../models/TranslationMemory');
} catch (_) {
  TranslationMemory = null;
}

const { normalizeLang } = require('../services/translationGuard');
const { enqueueBroadcastItemJob, enqueueNewsArticleJob } = require('../services/translationWorker');

function _slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

const router = express.Router();

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, data });
}

function fail(res, status, code, message, details) {
  return res.status(status).json({
    ok: false,
    success: false,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
    ...(details !== undefined ? { details } : {}),
    status,
  });
}

function ensureDb(res) {
  if (mongoose.connection.readyState !== 1) {
    fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
    return false;
  }
  return true;
}

// GET /api/admin/translations/jobs?status=&limit=
router.get('/jobs', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!TranslationJob) return fail(res, 501, 'NOT_AVAILABLE', 'Translation jobs not available');

  const status = req.query && req.query.status ? String(req.query.status).toUpperCase() : null;
  const limit = Math.min(200, Math.max(1, Number(req.query && req.query.limit) || 50));
  const q = {};

  if (status) {
    if (status === 'NEEDS_REVIEW') {
      q.$or = [{ status: 'NEEDS_REVIEW' }, { reviewStatus: 'NEEDS_REVIEW' }];
    } else if (status === 'DONE') {
      q.status = { $in: ['DONE', 'COMPLETED'] };
    } else if (status === 'QUEUED') {
      q.status = 'QUEUED';
    } else if (status === 'BLOCKED') {
      q.status = { $in: ['BLOCKED', 'FAILED'] };
    } else {
      q.status = status;
    }
  }

  const jobs = await TranslationJob.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  return ok(res, jobs);
});

// GET /api/admin/translations/jobs/:id
router.get('/jobs/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!TranslationJob) return fail(res, 501, 'NOT_AVAILABLE', 'Translation jobs not available');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const job = await TranslationJob.findById(id).lean();
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Not found');
  return ok(res, job);
});

// POST /api/admin/translations/jobs/:id/retry
router.post('/jobs/:id/retry', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!TranslationJob) return fail(res, 501, 'NOT_AVAILABLE', 'Translation jobs not available');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const updated = await TranslationJob.findByIdAndUpdate(
    id,
    { $set: { status: 'QUEUED', nextRunAt: new Date(), lastError: null } },
    { new: true },
  ).lean();
  if (!updated) return fail(res, 404, 'NOT_FOUND', 'Not found');
  return ok(res, updated);
});

// POST /api/admin/translations/jobs/:id/approve
// Applies stored translation into BroadcastItem and marks review as APPROVED.
router.post('/jobs/:id/approve', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!TranslationJob) return fail(res, 501, 'NOT_AVAILABLE', 'Translation jobs not available');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const job = await TranslationJob.findById(id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Not found');

  if (job.kind === 'BROADCAST_ITEM') {
    if (!BroadcastItem) return fail(res, 501, 'NOT_AVAILABLE', 'Broadcast model not available');

    const langTo = job.langTo || (Array.isArray(job.targetLangs) && job.targetLangs[0]) || null;
    const text = typeof job.translatedText === 'string' ? job.translatedText.trim() : '';
    if (!langTo || !text) return fail(res, 400, 'INVALID_JOB', 'Job missing langTo/translatedText');

    const item = await BroadcastItem.findById(job.refId);
    if (!item) return fail(res, 404, 'NOT_FOUND', 'Referenced item not found');

    const lang = normalizeLang(langTo, 'gu');
    item.textByLang = item.textByLang || {};
    item.statusByLang = item.statusByLang || {};
    item.qualityByLang = item.qualityByLang || {};
    item.textByLang[lang] = text.slice(0, 160);
    item.statusByLang[lang] = 'APPROVED';
    if (typeof job.qualityScore === 'number') item.qualityByLang[lang] = job.qualityScore;
    await item.save();

    job.reviewStatus = 'APPROVED';
    job.status = 'DONE';
    job.reviewedAt = new Date();
    job.reviewedBy = (req.admin && req.admin.email) ? String(req.admin.email) : 'admin';
    job.reason = null;
    await job.save();

    return ok(res, { jobId: String(job._id), itemId: String(item._id), lang, status: 'APPROVED' });
  }

  if (job.kind === 'NEWS_ARTICLE') {
    if (!News) return fail(res, 501, 'NOT_AVAILABLE', 'News model not available');

    const langTo = job.langTo || (Array.isArray(job.targetLangs) && job.targetLangs[0]) || null;
    const lang = normalizeLang(langTo, 'gu');

    const fields = (job.translatedFields && typeof job.translatedFields === 'object') ? job.translatedFields : null;
    const title = typeof fields?.title === 'string' ? fields.title.trim() : '';
    const description = typeof fields?.description === 'string' ? fields.description.trim() : '';
    const content = typeof fields?.content === 'string' ? fields.content.trim() : '';
    if (!lang || (!title && !description && !content)) {
      return fail(res, 400, 'INVALID_JOB', 'Job missing langTo/translatedFields');
    }

    const source = await News.findById(job.refId);
    if (!source) return fail(res, 404, 'NOT_FOUND', 'Referenced News not found');

    const groupId = String(source.translationGroupId || '').trim();
    if (!groupId) return fail(res, 400, 'INVALID_SOURCE', 'Source News missing translationGroupId');

    const baseSlug = source.slug ? String(source.slug) : (_slugify(source.title) || String(source._id));
    const slug = `${baseSlug}-${lang}`.slice(0, 180);
    const now = new Date();
    const isPublished = String(source.status || '').toLowerCase() === 'published';

    const q = { translationGroupId: groupId, $or: [{ lang }, { language: lang }] };
    const update = {
      title: title || source.title,
      description: description || source.description,
      content: content || source.content,
      slug,
      tags: Array.isArray(source.tags) ? source.tags : [],
      category: source.category,
      translationGroupId: groupId,
      lang,
      language: lang,
      imageURL: source.imageURL || source.coverImageUrl || null,
      coverImageUrl: source.coverImageUrl || source.imageURL || null,
      status: isPublished ? 'published' : 'draft',
      publishedAt: isPublished ? (source.publishedAt || now) : null,
      workflowStage: isPublished ? 'PUBLISHED' : 'DRAFT',
      workflowUpdatedAt: now,
    };

    const applied = await News.findOneAndUpdate(q, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });

    job.reviewStatus = 'APPROVED';
    job.status = 'DONE';
    job.reviewedAt = new Date();
    job.reviewedBy = (req.admin && req.admin.email) ? String(req.admin.email) : 'admin';
    job.reason = null;
    await job.save();

    return ok(res, { jobId: String(job._id), newsId: String(source._id), appliedId: String(applied._id), lang, status: 'APPROVED' });
  }

  return fail(res, 400, 'INVALID_JOB', 'Unsupported job kind');
});

// POST /api/admin/translations/jobs/:id/reject
// Marks review as REJECTED with reason.
router.post('/jobs/:id/reject', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!TranslationJob) return fail(res, 501, 'NOT_AVAILABLE', 'Translation jobs not available');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const job = await TranslationJob.findById(id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Not found');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  job.reviewStatus = 'REJECTED';
  job.status = 'BLOCKED';
  job.reviewedAt = new Date();
  job.reviewedBy = (req.admin && req.admin.email) ? String(req.admin.email) : 'admin';
  job.reason = reason || 'Rejected';
  await job.save();

  return ok(res, { jobId: String(job._id), status: 'REJECTED' });
});

// POST /api/admin/translations/broadcast/:itemId/enqueue
router.post('/broadcast/:itemId/enqueue', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  const { itemId } = req.params;
  if (!mongoose.isValidObjectId(itemId)) return fail(res, 404, 'NOT_FOUND', 'Not found');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetLangs = Array.isArray(body.targetLangs) ? body.targetLangs : ['en', 'hi'];
  const strictMode = Boolean(body.strictMode);
  const result = await enqueueBroadcastItemJob({ itemId, targetLangs, strictMode });
  if (!result.ok) return fail(res, 400, 'ENQUEUE_FAILED', 'Failed to enqueue', result);
  return ok(res, result);
});

// POST /api/admin/translations/news/:newsId/enqueue
router.post('/news/:newsId/enqueue', requireAdminAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  const { newsId } = req.params;
  if (!mongoose.isValidObjectId(newsId)) return fail(res, 404, 'NOT_FOUND', 'Not found');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetLangs = Array.isArray(body.targetLangs) ? body.targetLangs : ['en', 'hi', 'gu'];
  const strictMode = Boolean(body.strictMode);
  const result = await enqueueNewsArticleJob({ newsId, targetLangs, strictMode });
  if (!result.ok) return fail(res, 400, 'ENQUEUE_FAILED', 'Failed to enqueue', result);
  return ok(res, result);
});

// Founder-only: force-approve a translation into BroadcastItem + (optionally) TM
// POST /api/admin/translations/broadcast/:itemId/override
// body: { lang, text, alsoSaveToMemory? }
router.post('/broadcast/:itemId/override', requireFounderAuth, async (req, res) => {
  if (!ensureDb(res)) return;
  if (!BroadcastItem) return fail(res, 501, 'NOT_AVAILABLE', 'Broadcast model not available');

  const { itemId } = req.params;
  if (!mongoose.isValidObjectId(itemId)) return fail(res, 404, 'NOT_FOUND', 'Not found');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const lang = normalizeLang(body.lang, 'gu');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 160) return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');

  const item = await BroadcastItem.findById(itemId);
  if (!item) return fail(res, 404, 'NOT_FOUND', 'Not found');

  item.textByLang = item.textByLang || {};
  item.statusByLang = item.statusByLang || {};
  item.qualityByLang = item.qualityByLang || {};

  item.textByLang[lang] = text;
  item.statusByLang[lang] = 'APPROVED';
  item.qualityByLang[lang] = 100;
  await item.save();

  // Best effort: persist to TM if available.
  const alsoSaveToMemory = body && Object.prototype.hasOwnProperty.call(body, 'alsoSaveToMemory') ? Boolean(body.alsoSaveToMemory) : true;
  if (alsoSaveToMemory && TranslationMemory) {
    try {
      const sourceLang = typeof item.sourceLang === 'string' ? item.sourceLang : 'gu';
      const sourceText = (item.textByLang && item.textByLang[sourceLang]) || item.text || '';
      // Mirror hashing used in translationGuard: sha256(normalized)
      const crypto = require('node:crypto');
      const normalized = String(sourceText || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      const sourceHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
      await TranslationMemory.updateOne(
        { sourceHash, sourceLang, targetLang: lang },
        {
          $set: {
            sourceHash,
            sourceLang,
            targetLang: lang,
            translatedText: text,
            qualityScore: 100,
            approved: true,
            engineUsed: 'FOUNDER_OVERRIDE',
          },
        },
        { upsert: true },
      );
    } catch (_) {
      // ignore
    }
  }

  return ok(res, { itemId: String(item._id), lang, status: 'APPROVED' });
});

module.exports = router;
