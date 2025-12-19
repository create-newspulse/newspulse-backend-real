const express = require('express');

const router = express.Router();

// GET /api/admin/settings
// TODO: Replace placeholder with DB-backed settings fetch once models are ready.
router.get('/settings', (_req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      sections: {},
      updatedAt: null,
    },
  });
});

module.exports = router;
