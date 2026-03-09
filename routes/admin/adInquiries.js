const express = require('express');

const { requireAdminAuth, requireFounderAuth } = require('../../middleware/adminAuth');
const {
  listAdminAdInquiries,
  getAdminUnreadCount,
  markAdminInquiryRead,
  restoreAdminInquiry,
  deleteAdminInquiry,
  patchAdminInquiryStatusById,
  hardDeleteAdminInquiry,
} = require('../../controllers/adsInquiriesController');

const router = express.Router();
router.use(requireAdminAuth);

// GET /admin-api/ads/inquiries?status=new&page=1&limit=20&search=
router.get('/inquiries', listAdminAdInquiries);

// GET /admin-api/ads/inquiries/unread-count
router.get('/inquiries/unread-count', getAdminUnreadCount);

// PATCH /admin-api/ads/inquiries/:id/mark-read
router.patch('/inquiries/:id/mark-read', markAdminInquiryRead);

// PATCH /admin-api/ads/inquiries/:id/restore
router.patch('/inquiries/:id/restore', restoreAdminInquiry);

// DELETE /admin-api/ads/inquiries/:id (soft delete)
router.delete('/inquiries/:id', deleteAdminInquiry);

// Compatibility aliases
router.patch('/inquiries/:id/delete', deleteAdminInquiry);
router.patch('/inquiries/:id/status', patchAdminInquiryStatusById);

// Founder-only hard delete
router.delete('/inquiries/:id/hard', requireFounderAuth, hardDeleteAdminInquiry);

module.exports = router;
