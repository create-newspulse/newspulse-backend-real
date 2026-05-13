const express = require('express');

const { getPublicComplianceSettings } = require('../controllers/complianceSettingsController');

const router = express.Router();

router.get('/compliance-settings', getPublicComplianceSettings);

module.exports = router;