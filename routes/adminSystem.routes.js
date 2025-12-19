const express = require('express');

const router = express.Router();

const { requireFounderAuth } = require('../middleware/adminAuth');
const { requireOwnerKey } = require('../middleware/requireOwnerKey');
const { settingsService } = require('../services/settingsService');

// GET /api/admin/system/ai-training-info
// TODO: Replace placeholder with real training metadata from storage/DB.
router.get('/system/ai-training-info', (_req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      lastUpdatedAt: null,
      sources: [],
      notes: '',
    },
  });
});

// DANGEROUS: system mode change (read-only)
// POST /api/admin/system/mode
router.post('/system/mode', requireFounderAuth, requireOwnerKey, async (req, res) => {
  try {
    const readOnlyMode = !!(req.body && req.body.readOnlyMode);
    const actor = req.admin || null;
    await settingsService.set('site.readOnlyMode', readOnlyMode, {
      admin: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.json({ ok: true, success: true, status: 200, data: { readOnlyMode } });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to update system mode' });
  }
});

// DANGEROUS: emergency lockdown switch
// POST /api/admin/system/emergency-lockdown
router.post('/system/emergency-lockdown', requireFounderAuth, requireOwnerKey, async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const actor = req.admin || null;
    await settingsService.set('lockdown.emergency', enabled, {
      admin: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.json({ ok: true, success: true, status: 200, data: { enabled } });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to update emergency lockdown' });
  }
});

// DANGEROUS: rollback settings
// POST /api/admin/system/rollback
router.post('/system/rollback', requireFounderAuth, requireOwnerKey, async (req, res) => {
  try {
    const version = req.body && req.body.version;
    if (version === undefined || version === null || version === '') {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'MISSING_VERSION', message: 'version is required' });
    }
    const actor = req.admin || null;
    const result = await settingsService.rollbackToVersion(version, {
      admin: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.json({ ok: true, success: true, status: 200, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to rollback settings' });
  }
});

module.exports = router;
