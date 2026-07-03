const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  submitPrivacyRequest,
  verifyPrivacyRequest,
  listAdminPrivacyRequests,
  getAdminPrivacyRequest,
  resendAdminPrivacyRequestVerification,
  patchAdminPrivacyRequest,
  getAdminPrivacyRequestMatchingData,
  postAdminPrivacyRequestDataAction,
  completeAdminPrivacyRequest,
} = require('../controllers/privacyRequestController');

const publicRouter = express.Router();
publicRouter.post('/request', submitPrivacyRequest);
publicRouter.get('/verify/:token', verifyPrivacyRequest);

const adminRouter = express.Router();
adminRouter.use(requireAdminAuth);
adminRouter.get('/privacy-requests', listAdminPrivacyRequests);
adminRouter.get('/privacy-requests/:id', getAdminPrivacyRequest);
adminRouter.post('/privacy-requests/:id/resend-verification', resendAdminPrivacyRequestVerification);
adminRouter.patch('/privacy-requests/:id', patchAdminPrivacyRequest);
adminRouter.get('/privacy-requests/:id/matching-data', getAdminPrivacyRequestMatchingData);
adminRouter.post('/privacy-requests/:id/data-action', postAdminPrivacyRequestDataAction);
adminRouter.post('/privacy-requests/:id/complete', completeAdminPrivacyRequest);

module.exports = { publicRouter, adminRouter };
