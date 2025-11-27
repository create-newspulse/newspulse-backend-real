const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Prefer existing models in this codebase
let ArticleModel = null;
try {
  // If a dedicated Article model exists, use it
  ArticleModel = require('../../models/Article');
} catch (_) {
  try {
    // Fallback to existing News model used throughout this repo
    ArticleModel = require('../../models/News');
  } catch (e2) {
    // Last-resort minimal schema (not expected to be used here)
    const ArticleSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        slug: String,
        description: String, // maps from summary
        content: String,
        category: String,
        language: { type: String, default: 'en' },
        tags: { type: [String], default: [] },
        status: { type: String, enum: ['draft','scheduled','published','archived','deleted'], default: 'draft' },
        ptiCompliance: { type: String, enum: ['pending','compliant','needs_review'], default: 'pending' },
        publishAt: Date,
        scheduledAt: Date,
      },
      { timestamps: true, collection: 'articles' }
    );
    ArticleModel = mongoose.models.Article || mongoose.model('Article', ArticleSchema);
  }
}

function toJSON(doc) {
  if (!doc) return null;
  if (typeof doc.toJSON === 'function') return doc.toJSON();
  if (typeof doc.toObject === 'function') return doc.toObject({ versionKey: false });
  return doc;
}

function parseDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function normalizeTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(t => String(t).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// Accept common fields sent by frontend
const ALLOWED_FIELDS = [
  'title','slug','summary','description','content','category','tags','status',
  'language','ptiCompliance','publishAt','scheduledAt'
];

// Optional: protect with admin auth if available
let requireAdminAuth = (_req, _res, next) => next();
try { ({ requireAdminAuth } = require('../../middleware/adminAuth')); } catch (_) {}

// GET /api/admin/articles/:id
router.get('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'invalid id' });
    }
    const doc = await ArticleModel.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: 'not found' });
    return res.json({ ok: true, article: toJSON(doc) });
  } catch (err) {
    console.error('GET /api/admin/articles/:id error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'server error' });
  }
});

async function applyUpdate(doc, body) {
  const payload = {};
  for (const k of ALLOWED_FIELDS) {
    if (body[k] !== undefined) payload[k] = body[k];
  }
  // Map summary -> description for News model compatibility
  if (payload.summary && payload.description === undefined) {
    payload.description = payload.summary;
    delete payload.summary;
  }
  if (payload.tags !== undefined) payload.tags = normalizeTags(payload.tags);
  if (payload.scheduledAt) payload.scheduledAt = parseDate(payload.scheduledAt);
  if (payload.publishAt) payload.publishAt = parseDate(payload.publishAt);
  if (payload.scheduledAt && !payload.status) payload.status = 'scheduled';

  Object.assign(doc, payload);
  await doc.save();
  return doc;
}

// PUT /api/admin/articles/:id
router.put('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'invalid id' });
    }
    const doc = await ArticleModel.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: 'not found' });

    const updated = await applyUpdate(doc, req.body || {});
    return res.json({ ok: true, article: toJSON(updated) });
  } catch (err) {
    console.error('PUT /api/admin/articles/:id error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'server error' });
  }
});

// PATCH /api/admin/articles/:id
router.patch('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'invalid id' });
    }
    const doc = await ArticleModel.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: 'not found' });

    const updated = await applyUpdate(doc, req.body || {});
    return res.json({ ok: true, article: toJSON(updated) });
  } catch (err) {
    console.error('PATCH /api/admin/articles/:id error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'server error' });
  }
});

module.exports = router;
