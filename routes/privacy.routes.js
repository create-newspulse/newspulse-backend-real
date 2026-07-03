const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  submitPrivacyRequest,
  verifyPrivacyRequest,
  listAdminPrivacyRequests,
  getAdminPrivacyRequest,
  patchAdminPrivacyRequest,
} = require('../controllers/privacyRequestController');

const publicRouter = express.Router();
publicRouter.post('/request', submitPrivacyRequest);
publicRouter.get('/verify/:token', verifyPrivacyRequest);

const adminRouter = express.Router();
adminRouter.use(requireAdminAuth);
adminRouter.get('/privacy-requests', listAdminPrivacyRequests);
adminRouter.get('/privacy-requests/:id', getAdminPrivacyRequest);
adminRouter.patch('/privacy-requests/:id', patchAdminPrivacyRequest);

module.exports = { publicRouter, adminRouter };
