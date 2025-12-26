const express = require('express');
const { requireAdminAuth } = require('../../../middleware/adminAuth');
const {
  listPushHistory,
  deleteAllPushHistory,
} = require('../../controllers/admin/pushHistory.controller');

const router = express.Router();

// GET /api/admin/push-history?page=1&limit=50
router.get('/push-history', requireAdminAuth, listPushHistory);

// DELETE /api/admin/push-history?all=true (Founder-only)
router.delete('/push-history', requireAdminAuth, deleteAllPushHistory);

module.exports = router;
