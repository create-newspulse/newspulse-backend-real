const express = require('express');

const { requireFounderAuth } = require('../../middleware/adminAuth');
const {
  extractFeatureTogglePatch,
  loadFounderSettingsBundle,
  getFounderAiTrainingInfo,
  writeFounderSettingsBundle,
} = require('../../services/founderCommandService');
const { updateFounderToggles, getEffectiveCommunityAccessState } = require('../../services/communityAccessToggleService');

const router = express.Router();

router.get('/settings', requireFounderAuth, async (req, res) => {
  try {
    const bundle = await loadFounderSettingsBundle();
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: bundle.db.connected ? 'OK' : 'OK (DB unavailable)',
      data: bundle.data,
      updatedAt: bundle.updatedAt,
      db: bundle.db,
    });
  } catch (e) {
    console.error('[FOUNDER_SETTINGS][get] failed', e?.stack || e?.message || e);
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

async function saveFounderSettings(req, res) {
  try {
    const togglePatch = extractFeatureTogglePatch(req.body || {});
    if (Object.keys(togglePatch).length) {
      await updateFounderToggles(togglePatch);
    }

    const result = await writeFounderSettingsBundle(req.body || {}, req.admin || null);
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        success: false,
        status: result.status,
        message: result.message,
        path: req.originalUrl,
      });
    }

    const bundle = await loadFounderSettingsBundle();
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'Saved',
      data: bundle.data,
      updatedAt: bundle.updatedAt,
      db: bundle.db,
    });
  } catch (e) {
    console.error('[FOUNDER_SETTINGS][save] failed', e?.stack || e?.message || e);
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
}

router.put('/settings', requireFounderAuth, saveFounderSettings);
router.patch('/settings', requireFounderAuth, saveFounderSettings);

router.get('/ai-training-info', requireFounderAuth, async (req, res) => {
  try {
    const bundle = await getFounderAiTrainingInfo();
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: bundle.aiTrainingInfo,
      updatedAt: bundle.updatedAt,
      db: bundle.db,
    });
  } catch (e) {
    console.error('[FOUNDER_AI_TRAINING_INFO][get] failed', e?.stack || e?.message || e);
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

module.exports = router;