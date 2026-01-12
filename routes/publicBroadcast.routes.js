const express = require('express');

const { computePublicPayload } = require('../services/broadcastCenter.service');

const router = express.Router();

// GET /api/public/broadcast
router.get('/', async (_req, res) => {
  try {
    const payload = await computePublicPayload();
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast' });
  }
});

module.exports = router;
