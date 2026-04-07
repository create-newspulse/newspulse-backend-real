const express = require('express');

const reporterPortalRouter = require('./reporterPortal');

const router = express.Router();

function forwardToReporterPortal(targetPath) {
  return (req, res, next) => {
    try {
      req.reporterAuthCompat = true;
      req.reporterAuthCompatPath = req.originalUrl || req.url || targetPath;
      const queryIndex = String(req.url || '').indexOf('?');
      const query = queryIndex >= 0 ? String(req.url || '').slice(queryIndex) : '';
      req.url = `${targetPath}${query}`;
      return reporterPortalRouter.handle(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

router.post('/request-code', forwardToReporterPortal('/auth/request-login-otp'));
router.post('/verify-code', forwardToReporterPortal('/auth/verify-login-otp'));
router.get('/session', forwardToReporterPortal('/auth/session'));
router.post('/logout', forwardToReporterPortal('/auth/logout'));
router.get('/dashboard/summary', forwardToReporterPortal('/dashboard/summary'));
router.get('/submissions/stats', forwardToReporterPortal('/submissions/stats'));
router.get('/submissions', forwardToReporterPortal('/submissions'));
router.get('/submissions/:id', forwardToReporterPortal('/submissions/:id'));
router.get('/profile', forwardToReporterPortal('/profile'));
router.patch('/profile', forwardToReporterPortal('/profile'));
router.post('/profile/email/request-change', forwardToReporterPortal('/profile/email/request-change'));
router.post('/profile/email/confirm-change', forwardToReporterPortal('/profile/email/confirm-change'));

module.exports = router;