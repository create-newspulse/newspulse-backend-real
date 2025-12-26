const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getAdminAdSettings,
  updateAdminAdSettings,
} = require('../controllers/adSettingsController');

const router = express.Router();

// GET /api/admin/ad-settings
router.get('/ad-settings', requireAdminAuth, getAdminAdSettings);

// PUT /api/admin/ad-settings
router.put('/ad-settings', requireAdminAuth, updateAdminAdSettings);

module.exports = router;
