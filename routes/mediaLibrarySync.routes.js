const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  listUnusedMediaRecords,
  syncCloudinaryMediaLibrary,
} = require('../services/mediaLibraryService');

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

router.get('/unused', requireAdminAuth, async (req, res) => {
  try {
    const result = await listUnusedMediaRecords({
      req,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.status(200).json({
      ok: true,
      success: true,
      items: result.items,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    return res.status(status).json({
      ok: false,
      success: false,
      code: e?.code || undefined,
      message: e?.message || 'Failed to list unused media',
    });
  }
});

module.exports = router;
