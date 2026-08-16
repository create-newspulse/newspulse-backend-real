const express = require('express');

const { requireFounderAuth, requireFounderOrAdmin } = require('../middleware/adminAuth');
const {
  getPushFirebaseStatus,
  getPushDiagnostics,
  getPushHistory,
  sendTestPush,
  sendLatestTestPush,
  sendBreakingPush,
  sendArticlePush,
} = require('../controllers/pushRegistrationController');

const router = express.Router();

router.get('/status', requireFounderAuth, getPushFirebaseStatus);
router.get('/diagnostics', requireFounderOrAdmin, getPushDiagnostics);
router.get('/history', requireFounderOrAdmin, getPushHistory);
router.post('/test', requireFounderAuth, sendTestPush);
router.post('/test-latest', requireFounderOrAdmin, sendLatestTestPush);
router.post('/breaking', requireFounderOrAdmin, sendBreakingPush);
router.post('/article', requireFounderOrAdmin, sendArticlePush);

module.exports = router;