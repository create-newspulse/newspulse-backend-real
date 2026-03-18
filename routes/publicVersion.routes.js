const express = require('express');

const noCache = require('../middleware/noCache');
const { getPublicConfigVersionDetails } = require('../services/publicConfigVersion.service');

const router = express.Router();

router.get('/version', noCache, async (_req, res) => {
  try {
    const { version, updatedAt } = await getPublicConfigVersionDetails();
    return res.status(200).json({
      ok: true,
      success: true,
      version,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    });
  } catch (_) {
    return res.status(200).json({
      ok: true,
      success: true,
      version: 0,
      updatedAt: null,
    });
  }
});

module.exports = router;