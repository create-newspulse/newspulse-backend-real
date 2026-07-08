const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getAdminLiveTvSettings,
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
  updateAdminLiveTvSettings,
  publishAdminLiveTvSettings,
  deactivateAdminLiveTvSettings,
  savePublicSettings,
} = require('../controllers/publicSiteSettingsController');

const router = express.Router();

// GET /api/admin/live-tv - current Live TV settings from PublicSiteSettings
router.get('/live-tv', requireAdminAuth, getAdminLiveTvSettings);
router.get('/settings/public-site/live-tv', requireAdminAuth, getAdminLiveTvSettings);

// PUT/PATCH /api/admin/live-tv - update draft Live TV settings in PublicSiteSettings
router.patch('/live-tv', requireAdminAuth, updateAdminLiveTvSettings);
router.put('/live-tv', requireAdminAuth, updateAdminLiveTvSettings);
router.patch('/settings/public-site/live-tv', requireAdminAuth, updateAdminLiveTvSettings);
router.put('/settings/public-site/live-tv', requireAdminAuth, updateAdminLiveTvSettings);

// Optional operation aliases used by admin Live TV screens; still the same settings object.
router.post('/live-tv/draft', requireAdminAuth, updateAdminLiveTvSettings);
router.post('/live-tv/publish', requireAdminAuth, publishAdminLiveTvSettings);
router.post('/live-tv/deactivate', requireAdminAuth, deactivateAdminLiveTvSettings);
router.post('/settings/public-site/live-tv/draft', requireAdminAuth, updateAdminLiveTvSettings);
router.post('/settings/public-site/live-tv/publish', requireAdminAuth, publishAdminLiveTvSettings);
router.post('/settings/public-site/live-tv/deactivate', requireAdminAuth, deactivateAdminLiveTvSettings);

// GET /api/admin/settings/public - get both draft and published
router.get('/settings/public', requireAdminAuth, getPublicSettings);

// PATCH /api/admin/settings/public - partial update to draft (merge)
router.patch('/settings/public', requireAdminAuth, savePublicSettings);
// PUT /api/admin/settings/public - replace draft (compat)
router.put('/settings/public', requireAdminAuth, savePublicSettings);

// GET /api/admin/settings/public/draft - get draft only
router.get('/settings/public/draft', requireAdminAuth, getDraftSettings);

// PUT /api/admin/settings/public/draft - update draft
router.put('/settings/public/draft', requireAdminAuth, updateDraftSettings);

// POST /api/admin/settings/public/publish - publish draft to published
router.post('/settings/public/publish', requireAdminAuth, publishSettings);

module.exports = router;
