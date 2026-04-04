const express = require('express');

const reporterPortalRouter = require('./reporterPortal');

const router = express.Router();

function forwardToReporterPortal(targetPath) {
  return (req, res, next) => {
    try {
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

module.exports = router;