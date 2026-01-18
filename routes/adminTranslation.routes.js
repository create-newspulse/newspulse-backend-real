const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');

let TranslationJob;
let BroadcastItem;
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
  TranslationMemory = require('../models/TranslationMemory');
} catch (_) {
  TranslationMemory = null;
}

const { normalizeLang } = require('../services/translationGuard');
const { enqueueBroadcastItemJob } = require('../services/translationWorker');

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
  if (!BroadcastItem) return fail(res, 501, 'NOT_AVAILABLE', 'Broadcast model not available');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const job = await TranslationJob.findById(id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Not found');

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
