const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
} = require('../controllers/publicSiteSettingsController');

// Alias router to support admin UIs that call "public-site" paths.
// Keeps the same response shapes as the canonical endpoints.
const router = express.Router();

// Canonical: /api/admin/settings/public
// Alias:     /api/admin/settings/public-site
router.get('/settings/public-site', requireAdminAuth, getPublicSettings);

// Canonical: /api/admin/settings/public/draft
// Alias:     /api/admin/settings/public-site/draft
router.get('/settings/public-site/draft', requireAdminAuth, getDraftSettings);
router.put('/settings/public-site/draft', requireAdminAuth, updateDraftSettings);

// Canonical: /api/admin/settings/public/publish
// Alias:     /api/admin/settings/public-site/publish
router.post('/settings/public-site/publish', requireAdminAuth, publishSettings);

module.exports = router;
