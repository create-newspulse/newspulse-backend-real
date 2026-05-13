const express = require('express');

const { listPublicComplianceReports } = require('../controllers/complianceReportsController');

const router = express.Router();

router.get('/compliance-reports', listPublicComplianceReports);

module.exports = router;