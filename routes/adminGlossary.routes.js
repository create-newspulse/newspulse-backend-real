const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const GlossaryTerm = require('../models/GlossaryTerm');

const router = express.Router();

function ensureDbOr503(res) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ ok: false, success: false, status: 503, code: 'DB_UNAVAILABLE', message: 'Database unavailable' });
  }
  return true;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKey(v) {
  const s = String(v || '').trim();
  return s.length ? s : null;
}

function normalizeText(v) {
  const s = String(v || '').trim();
  return s;
}

function mapTerm(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  return {
    _id: id,
    id,
    key: d.key || '',
    en: d.en || '',
    hi: d.hi || '',
    gu: d.gu || '',
    doNotTranslate: Boolean(d.doNotTranslate),
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

// GET /api/admin/glossary?query=
router.get('/', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const query = String((req.query && req.query.query) || '').trim();
  const filter = {};
  if (query) {
    const q = query.toLowerCase();
    filter.keyNorm = { $regex: escapeRegex(q), $options: 'i' };
  }

  const items = await GlossaryTerm.find(filter).sort({ keyNorm: 1 }).limit(100).lean();
  return res.status(200).json({ ok: true, success: true, data: { items: items.map(mapTerm) } });
});

// POST /api/admin/glossary
router.post('/', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = normalizeKey(body.key);
  if (!key) {
    return res.status(400).json({ ok: false, success: false, code: 'INVALID_KEY', message: 'key is required' });
  }

  const doc = await GlossaryTerm.create({
    key,
    en: normalizeText(body.en),
    hi: normalizeText(body.hi),
    gu: normalizeText(body.gu),
    doNotTranslate: Boolean(body.doNotTranslate),
  });

  return res.status(201).json({ ok: true, success: true, data: mapTerm(doc) });
});

// PUT /api/admin/glossary/:id
router.put('/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ ok: false, success: false, code: 'NOT_FOUND', message: 'Not found' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const next = {};

  if (Object.prototype.hasOwnProperty.call(body, 'key')) {
    const key = normalizeKey(body.key);
    if (!key) {
      return res.status(400).json({ ok: false, success: false, code: 'INVALID_KEY', message: 'Invalid key' });
    }
    next.key = key;
  }

  for (const f of ['en', 'hi', 'gu']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      next[f] = normalizeText(body[f]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'doNotTranslate')) {
    next.doNotTranslate = Boolean(body.doNotTranslate);
  }

  if (Object.keys(next).length === 0) {
    return res.status(400).json({ ok: false, success: false, code: 'BAD_REQUEST', message: 'No supported fields to update' });
  }

  const updated = await GlossaryTerm.findById(id);
  if (!updated) {
    return res.status(404).json({ ok: false, success: false, code: 'NOT_FOUND', message: 'Not found' });
  }

  Object.assign(updated, next);
  await updated.save();

  return res.status(200).json({ ok: true, success: true, data: mapTerm(updated.toObject()) });
});

// DELETE /api/admin/glossary/:id
router.delete('/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ ok: false, success: false, code: 'NOT_FOUND', message: 'Not found' });
  }

  const deleted = await GlossaryTerm.findByIdAndDelete(id).lean();
  if (!deleted) {
    return res.status(404).json({ ok: false, success: false, code: 'NOT_FOUND', message: 'Not found' });
  }

  return res.status(200).json({ ok: true, success: true });
});

module.exports = router;
