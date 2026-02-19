const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { getAiModelsStatus, refreshAiModels } = require('../services/aiModelResolver');

const router = express.Router();

// GET /admin-api/ai/models/status
router.get('/status', requireAdminAuth, async (req, res) => {
  try {
    const ctx = {
      changedBy: req.admin ? { userId: req.admin.id || null, email: req.admin.email || null, role: req.admin.role || null } : null,
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null,
    };
    const status = await getAiModelsStatus({ forceRefresh: false, reason: 'auto-refresh', context: ctx });
    return res.status(200).json({ ok: true, success: true, status: 200, ...status });
  } catch (e) {
    console.error('[ai/models/status] failed', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to resolve AI models' });
  }
});

// POST /admin-api/ai/models/refresh
router.post('/refresh', requireAdminAuth, async (req, res) => {
  try {
    const ctx = {
      changedBy: req.admin ? { userId: req.admin.id || null, email: req.admin.email || null, role: req.admin.role || null } : null,
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null,
    };
    const status = await refreshAiModels({ reason: 'manual-refresh', context: ctx });
    return res.status(200).json({ ok: true, success: true, status: 200, ...status });
  } catch (e) {
    console.error('[ai/models/refresh] failed', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to refresh AI models' });
  }
});

module.exports = router;
