const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { syncCloudinaryMediaLibrary } = require('../services/mediaLibraryService');

const router = express.Router();

router.post('/sync-cloudinary', requireAdminAuth, async (req, res) => {
  try {
    const summary = await syncCloudinaryMediaLibrary({
      actor: req.admin || null,
    });
    return res.status(200).json(summary);
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    return res.status(status).json({
      ok: false,
      success: false,
      code: e?.code || undefined,
      message: e?.message || 'Cloudinary Media Library sync failed',
    });
  }
});

module.exports = router;
