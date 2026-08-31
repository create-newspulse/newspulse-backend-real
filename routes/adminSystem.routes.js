const express = require('express');

const router = express.Router();

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const { requireOwnerKey } = require('../middleware/requireOwnerKey');
const { settingsService } = require('../services/settingsService');
const { getNewsPulseEngineHealth } = require('../services/newsPulseEngineHealthService');
const { getMonitoringStatus, listAlerts, listIncidents } = require('../services/newsPulseEngineMonitoringService');
const mongoose = require('mongoose');
let SystemSnapshot = null;
try { SystemSnapshot = require('../models/SystemSnapshot'); } catch (_) {}

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

// GET /api/admin/news-pulse-engine/health
// Founder-only, on-demand, read-only diagnostics snapshot. No writes, no automatic fixes.
router.get('/news-pulse-engine/health', requireFounderAuth, async (_req, res) => {
  try {
    const snapshot = await getNewsPulseEngineHealth();
    return res.status(200).json(snapshot);
  } catch (e) {
    console.error('[NEWS_PULSE_ENGINE][health] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal error' });
  }
});

// GET /api/admin/news-pulse-engine/incidents
// Founder-only incident history for automatic monitoring. Read-only.
router.get('/news-pulse-engine/incidents', requireFounderAuth, async (req, res) => {
  try {
    const result = await listIncidents({ status: req.query.status, limit: req.query.limit });
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, success: false, status: result.status || 500, message: result.message || 'Failed to load incidents' });
    }
    return res.status(200).json({ ok: true, success: true, status: 200, incidents: result.incidents });
  } catch (e) {
    console.error('[NEWS_PULSE_ENGINE][incidents] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal error' });
  }
});

// GET /api/admin/news-pulse-engine/alerts
// Founder-only critical/recovery alert history for automatic monitoring. Read-only.
router.get('/news-pulse-engine/alerts', requireFounderAuth, async (req, res) => {
  try {
    const result = await listAlerts({ type: req.query.type, limit: req.query.limit });
    if (!result.ok) {
      return res.status(result.status || 500).json({ ok: false, success: false, status: result.status || 500, message: result.message || 'Failed to load alerts' });
    }
    return res.status(200).json({ ok: true, success: true, status: 200, alerts: result.alerts });
  } catch (e) {
    console.error('[NEWS_PULSE_ENGINE][alerts] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal error' });
  }
});

// GET /api/admin/news-pulse-engine/monitoring/status
// Founder-only status for the automatic monitoring loop. Read-only.
router.get('/news-pulse-engine/monitoring/status', requireFounderAuth, (_req, res) => {
  return res.status(200).json({ ok: true, success: true, status: 200, data: getMonitoringStatus() });
});

// GET /admin-api/admin/system/translation-status
// Debug endpoint for admin panel: translation providers/config health.
router.get('/system/translation-status', requireAdminAuth, (_req, res) => {
  const googleConfigured = !!(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();

  return res.status(200).json({
    googleConfigured,
    queueEnabled: false,
    providers: {
      google: { configured: googleConfigured },
    },
  });
});

// GET /api/admin/system/ai-training-info
// TODO: Replace placeholder with real training metadata from storage/DB.
router.get('/system/ai-training-info', requireAdminAuth, (_req, res) => {
  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    data: {
      lastUpdatedAt: null,
      sources: [],
      notes: '',
    }
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

// GET /api/admin/system/snapshots?limit=20
router.get('/system/snapshots', requireFounderAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 200);
  if (!isDbReady() || !SystemSnapshot) {
    return res.status(200).json({ ok: true, success: true, data: { items: [] } });
  }

  const docs = await SystemSnapshot.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  const items = (docs || []).map(d => ({
    id: String(d._id),
    label: d.label || null,
    createdAt: d.createdAt || null,
    meta: d.meta || null,
  }));
  return res.status(200).json({ ok: true, success: true, data: { items } });
});

// POST /api/admin/system/snapshots
router.post('/system/snapshots', requireFounderAuth, requireOwnerKey, async (req, res) => {
  if (!isDbReady() || !SystemSnapshot) {
    return res.status(200).json({ ok: true, success: true, data: null, message: 'Database unavailable' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const label = body.label != null ? String(body.label || '').trim() : '';
  const meta = body.meta != null ? body.meta : null;
  const created = await SystemSnapshot.create({
    label: label || null,
    meta,
    createdAt: new Date(),
    createdBy: req.admin?.email || req.admin?.id || null,
  });
  return res.status(201).json({ ok: true, success: true, data: { id: String(created._id) }, message: 'Snapshot created' });
});

module.exports = router;
