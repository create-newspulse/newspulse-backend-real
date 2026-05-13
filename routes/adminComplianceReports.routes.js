const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  createComplianceReport,
  deleteComplianceReport,
  listAdminComplianceReports,
  updateComplianceReport,
} = require('../controllers/complianceReportsController');

const router = express.Router();

router.get('/compliance-reports', requireAdminAuth, listAdminComplianceReports);
router.post('/compliance-reports', requireAdminAuth, createComplianceReport);
router.put('/compliance-reports/:id', requireAdminAuth, updateComplianceReport);
router.delete('/compliance-reports/:id', requireAdminAuth, deleteComplianceReport);

module.exports = router;