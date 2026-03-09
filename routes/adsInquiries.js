const express = require('express');

const { requireAdminJwt } = require('../middleware/adminAuth');
const {
  submitPublicAdInquiry,
  listAdminAdInquiries,
  getAdminUnreadCount,
  markAdminInquiryRead,
  patchAdminInquiryStatusById,
  deleteAdminInquiry,
} = require('../controllers/adsInquiriesController');

const publicAdsInquiriesRouter = express.Router();
publicAdsInquiriesRouter.post('/inquiry', submitPublicAdInquiry);

const adminAdsInquiriesRouter = express.Router();
adminAdsInquiriesRouter.use(requireAdminJwt);
adminAdsInquiriesRouter.get('/inquiries', listAdminAdInquiries);
adminAdsInquiriesRouter.get('/inquiries/unread-count', getAdminUnreadCount);
adminAdsInquiriesRouter.patch('/inquiries/:id/mark-read', markAdminInquiryRead);
adminAdsInquiriesRouter.patch('/inquiries/:id/status', patchAdminInquiryStatusById);
adminAdsInquiriesRouter.delete('/inquiries/:id', deleteAdminInquiry);

module.exports = {
  publicAdsInquiriesRouter,
  adminAdsInquiriesRouter,
};
