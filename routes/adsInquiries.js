const express = require('express');

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const {
  submitPublicAdInquiry,
  listAdminAdInquiries,
  getAdminUnreadCount,
  markAdminInquiryRead,
  patchAdminInquiryStatusById,
  deleteAdminInquiry,
  restoreAdminInquiry,
  hardDeleteAdminInquiry,
} = require('../controllers/adsInquiriesController');

const publicAdsInquiriesRouter = express.Router();
publicAdsInquiriesRouter.post('/inquiry', submitPublicAdInquiry);

const adminAdsInquiriesRouter = express.Router();
adminAdsInquiriesRouter.use(requireAdminAuth);
adminAdsInquiriesRouter.get('/inquiries', listAdminAdInquiries);
adminAdsInquiriesRouter.get('/inquiries/unread-count', getAdminUnreadCount);
adminAdsInquiriesRouter.patch('/inquiries/:id/mark-read', markAdminInquiryRead);
adminAdsInquiriesRouter.patch('/inquiries/:id/status', patchAdminInquiryStatusById);
adminAdsInquiriesRouter.patch('/inquiries/:id/delete', deleteAdminInquiry);
adminAdsInquiriesRouter.patch('/inquiries/:id/restore', restoreAdminInquiry);

// Founder-only hard delete
adminAdsInquiriesRouter.delete('/inquiries/:id/hard', requireFounderAuth, hardDeleteAdminInquiry);

module.exports = {
  publicAdsInquiriesRouter,
  adminAdsInquiriesRouter,
};
