const express = require('express');

const router = express.Router();

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const { requireOwnerKey } = require('../middleware/requireOwnerKey');
const { settingsService } = require('../services/settingsService');
const mongoose = require('mongoose');
const { getRedisClient, isRedisReady } = require('../lib/redis');
const { getMailerStatus } = require('../lib/mailer');
let SystemSnapshot = null;
try { SystemSnapshot = require('../models/SystemSnapshot'); } catch (_) {}
let getPublishTranslationWorkerStatus = null;
try { ({ getPublishTranslationWorkerStatus } = require('../services/publishAsyncTranslation.service')); } catch (_) {}

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function safeSection(status, message) {
  return { status, message };
}

function getMongodbHealth() {
  try {
    const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : null;
    if (readyState === 1) return safeSection('ok', 'MongoDB connection is ready.');
    if (readyState === 0) return safeSection('error', 'MongoDB is disconnected.');
    if (readyState === 2) return safeSection('unknown', 'MongoDB connection is still opening.');
    if (readyState === 3) return safeSection('error', 'MongoDB connection is disconnecting.');
    return safeSection('unknown', 'MongoDB connection state is unavailable.');
  } catch (_) {
    return safeSection('unknown', 'MongoDB health could not be checked safely.');
  }
}

function getRedisHealth() {
  try {
    const client = getRedisClient();
    if (!client) return safeSection('not_configured', 'Redis is not configured.');
    if (isRedisReady()) return safeSection('connected', 'Redis client is connected.');
    const status = String(client.status || '').toLowerCase();
    if (status === 'connect' || status === 'connecting' || status === 'reconnecting') {
      return safeSection('unknown', 'Redis client is connecting.');
    }
    return safeSection('error', 'Redis client is not ready.');
  } catch (_) {
    return safeSection('unknown', 'Redis health could not be checked safely.');
  }
}

function getTranslationWorkerHealth() {
  try {
    if (typeof getPublishTranslationWorkerStatus !== 'function') {
      return safeSection('unknown', 'Translation worker status is not exposed.');
    }
    const status = getPublishTranslationWorkerStatus();
    if (status && status.running === true) return safeSection('running', 'Translation worker is running.');
    if (status && status.status === 'stopped') return safeSection('stopped', 'Translation worker is not running.');
    return safeSection('unknown', 'Translation worker status is unavailable.');
  } catch (_) {
    return safeSection('unknown', 'Translation worker status could not be checked safely.');
  }
}

function getSmtpEmailHealth() {
  try {
    const status = getMailerStatus();
    return status && status.configured === true
      ? safeSection('configured', 'SMTP/email provider is configured.')
      : safeSection('missing', 'SMTP/email provider configuration is incomplete.');
  } catch (_) {
    return safeSection('unknown', 'SMTP/email status could not be checked safely.');
  }
}

function getEnvironmentHealth() {
  try {
    const hasJwtSecret = !!String(process.env.JWT_SECRET || '').trim();
    const hasNodeEnv = !!String(process.env.NODE_ENV || '').trim();
    if (hasJwtSecret && hasNodeEnv) return safeSection('ok', 'Required runtime labels are present.');
    return safeSection('check_needed', 'One or more safe runtime checks need attention.');
  } catch (_) {
    return safeSection('check_needed', 'Environment status could not be checked safely.');
  }
}

function buildSafeOwnerSystemHealth() {
  return {
    backendApi: safeSection('ok', 'Backend API is responding.'),
    mongodb: getMongodbHealth(),
    redis: getRedisHealth(),
    translationWorker: getTranslationWorkerHealth(),
    smtpEmail: getSmtpEmailHealth(),
    environment: getEnvironmentHealth(),
    checkedAt: new Date().toISOString(),
  };
}

// GET /api/admin/safe-owner-zone/system-health
// Read-only Safe Owner Zone health summary. Returns safe labels only; no secrets.
router.get('/safe-owner-zone/system-health', requireAdminAuth, (_req, res) => {
  try {
    return res.status(200).json({ ok: true, data: buildSafeOwnerSystemHealth() });
  } catch (_) {
    return res.status(200).json({
      ok: true,
      data: {
        backendApi: safeSection('error', 'Backend health check failed softly.'),
        mongodb: safeSection('unknown', 'MongoDB health is unavailable.'),
        redis: safeSection('unknown', 'Redis health is unavailable.'),
        translationWorker: safeSection('unknown', 'Translation worker status is unavailable.'),
        smtpEmail: safeSection('unknown', 'SMTP/email status is unavailable.'),
        environment: safeSection('check_needed', 'Environment status is unavailable.'),
        checkedAt: new Date().toISOString(),
      },
    });
  }
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
