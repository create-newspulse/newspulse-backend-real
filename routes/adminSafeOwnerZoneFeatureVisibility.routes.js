const express = require('express');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const { requireFounderAuth } = require('../middleware/adminAuth');
const { logAudit } = require('../lib/audit');
const {
  extractAdminFeatureVisibilityPatch,
  getAdminFeatureVisibility,
  saveAdminFeatureVisibility,
} = require('../services/adminFeatureVisibilityService');
const {
  CANONICAL_ADMIN_MODULE_KEYS,
  FIXED_ADMIN_CONTROL_KEYS,
  MODULE_POLICY_STATES,
  getFounderModulePolicy,
  modulePolicyEnvelope,
  previewFounderModulePolicy,
  updateFounderModulePolicy,
} = require('../services/founderAccessPolicyService');

const router = express.Router();

router.get('/safe-owner-zone/feature-visibility', requireFounderAuth, async (_req, res) => {
  try {
    const visibility = await getAdminFeatureVisibility();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, visibility });
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][feature-visibility][get] failed', error?.stack || error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load admin feature visibility' });
  }
});

router.put('/safe-owner-zone/feature-visibility', requireFounderAuth, async (req, res) => {
  try {
    const { patch, invalidKeys, invalidValueKeys } = extractAdminFeatureVisibilityPatch(req.body || {});

    if (invalidKeys.length || invalidValueKeys.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid admin feature visibility payload',
        invalidKeys,
        invalidValueKeys,
      });
    }

    const visibility = await saveAdminFeatureVisibility(patch || {}, req.admin, req.body?.auditReason || req.body?.reason || 'Legacy Safe Zone visibility update');
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, visibility });
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][feature-visibility][put] failed', error?.stack || error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to save admin feature visibility' });
  }
});

router.get('/safe-owner-zone/module-policy', requireFounderAuth, async (_req, res) => {
  try {
    const policy = await getFounderModulePolicy();
    res.set('Cache-Control', 'no-store');
    return res.json(modulePolicyEnvelope(policy, {
      registry: CANONICAL_ADMIN_MODULE_KEYS,
      fixedControls: FIXED_ADMIN_CONTROL_KEYS,
      allowedStates: MODULE_POLICY_STATES,
    }));
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][module-policy][get] failed', error?.stack || error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Founder module policy' });
  }
});

router.post('/safe-owner-zone/module-policy/preview', requireFounderAuth, async (req, res) => {
  try {
    const result = await previewFounderModulePolicy(req.body || {});
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][module-policy][preview] failed', error?.stack || error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to preview Founder module policy' });
  }
});

router.put('/safe-owner-zone/module-policy', requireFounderAuth, async (req, res) => {
  try {
    const result = await updateFounderModulePolicy(req.body || {}, req.admin);
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }

    const auditTimestamp = new Date().toISOString();
    await logAudit(req, 'FOUNDER_MODULE_POLICY_UPDATED', null, {
      targetType: 'module_policy',
      module: 'safe_zone',
      founderId: req.admin?.id || null,
      oldValue: result.previous.modulePolicies,
      newValue: result.policy.modulePolicies,
      previousVersion: result.previous.version,
      policyVersion: result.policy.version,
      version: result.policy.version,
      changed: result.changed,
      affectedModuleKeys: result.affectedModuleKeys,
      bulkAction: result.bulkAction,
      timestamp: auditTimestamp,
      reason: result.policy.auditReason,
    });

    res.set('Cache-Control', 'no-store');
    return res.json(modulePolicyEnvelope(result.policy, { previous: result.previous, changed: result.changed, affectedModuleKeys: result.affectedModuleKeys, bulkAction: result.bulkAction || undefined }));
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][module-policy][put] failed', error?.stack || error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to save Founder module policy' });
  }
});

router.get('/safe-owner-zone/module-policy/audit', requireFounderAuth, async (_req, res) => {
  try {
    if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
      return res.json({ ok: true, success: true, audit: [] });
    }
    const docs = await AuditLog.find({ action: 'FOUNDER_MODULE_POLICY_UPDATED' }).sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ ok: true, success: true, audit: docs || [] });
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][module-policy][audit] failed', error?.stack || error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Founder module policy audit history' });
  }
});

module.exports = router;