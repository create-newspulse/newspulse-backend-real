const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getAdminComplianceSettings,
  updateAdminComplianceSettings,
} = require('../controllers/complianceSettingsController');

const router = express.Router();

router.get('/compliance-settings', requireAdminAuth, getAdminComplianceSettings);
router.put('/compliance-settings', requireAdminAuth, updateAdminComplianceSettings);

module.exports = router;