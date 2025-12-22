const express = require('express');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const { requireFounderAuth } = require('../middleware/adminAuth');

const router = express.Router();

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

// Founder-only: GET /api/audit/recent?limit=30
router.get('/recent', requireFounderAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 200);

  if (!isDbReady()) {
    return res.status(200).json({ ok: true, success: true, data: { items: [] } });
  }

  const docs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  const items = (docs || []).map(d => ({
    id: String(d._id),
    action: d.action,
    key: d.key ?? null,
    actor: d.actor ?? null,
    createdAt: d.createdAt ?? null,
    meta: d.meta ?? null,
  }));

  return res.status(200).json({ ok: true, success: true, data: { items } });
});

module.exports = router;
