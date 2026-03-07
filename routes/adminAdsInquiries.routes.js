const express = require('express');
const mongoose = require('mongoose');

const { requireAdminJwt } = require('../middleware/adminAuth');
const AdInquiry = require('../models/AdInquiry');

const router = express.Router();

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function _parseInt(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function _toDto(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    message: doc.message,
    status: doc.status,
    createdAt: doc.createdAt || null,
    ip: doc.ip || null,
    userAgent: doc.userAgent || null,
  };
}

// All endpoints in this router require a valid admin JWT.
router.use(requireAdminJwt);

// GET /admin-api/ads/inquiries?status=new&page=1&limit=20
router.get('/inquiries', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    const status = statusRaw === 'new' || statusRaw === 'read' ? statusRaw : null;

    const page = Math.max(_parseInt(req.query.page, 1), 1);
    const limit = _clampInt(_parseInt(req.query.limit, 20), 1, 100);
    const skip = (page - 1) * limit;

    const filter = {};
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      AdInquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdInquiry.countDocuments(filter),
    ]);

    return res.status(200).json({
      items: (items || []).map(_toDto),
      page,
      limit,
      total: typeof total === 'number' ? total : 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || String(e) });
  }
});

// GET /admin-api/ads/inquiries/unread-count
router.get('/inquiries/unread-count', async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const count = await AdInquiry.countDocuments({ status: 'new' });
    return res.status(200).json({ count: typeof count === 'number' ? count : 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || String(e) });
  }
});

// PATCH /admin-api/ads/inquiries/:id/read
router.patch('/inquiries/:id/read', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid id' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: 'read' } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || String(e) });
  }
});

module.exports = router;
