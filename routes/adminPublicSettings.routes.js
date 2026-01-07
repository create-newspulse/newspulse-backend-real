const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
} = require('../controllers/publicSiteSettingsController');

const router = express.Router();

// GET /api/admin/settings/public - get both draft and published
router.get('/settings/public', requireAdminAuth, getPublicSettings);

// GET /api/admin/settings/public/draft - get draft only
router.get('/settings/public/draft', requireAdminAuth, getDraftSettings);

// PUT /api/admin/settings/public/draft - update draft
router.put('/settings/public/draft', requireAdminAuth, updateDraftSettings);

// POST /api/admin/settings/public/publish - publish draft to published
router.post('/settings/public/publish', requireAdminAuth, publishSettings);

module.exports = router;
