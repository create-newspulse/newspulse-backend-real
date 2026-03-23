const express = require('express');

const { getCloudinaryConfigStatus } = require('../lib/cloudinary');

const router = express.Router();

// GET /api/media/status
// GET /admin-api/media/status
// Always returns a stable JSON contract for admin clients.
router.get('/status', (_req, res) => {
  try {
    const st = getCloudinaryConfigStatus();
    const configured = !!st.configured;

    return res.status(200).json({
      ok: true,
      configured,
      provider: 'cloudinary',
      message: configured ? 'Media uploads are ready' : 'Cloudinary not configured',
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      configured: false,
      provider: 'cloudinary',
      message: 'Cloudinary status unavailable',
    });
  }
});

module.exports = router;
