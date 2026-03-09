const express = require('express');

const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const {
  listAdminAdInquiries,
  getAdminUnreadCount,
  markAdminInquiryRead,
  patchAdminInquiryStatusById,
  deleteAdminInquiry,
  restoreAdminInquiry,
  hardDeleteAdminInquiry,
} = require('../controllers/adsInquiriesController');

const router = express.Router();
router.use(requireAdminAuth);

// GET /api/admin/ads/inquiries?status=new|read|deleted|all&page=1&limit=20&search=
router.get('/inquiries', listAdminAdInquiries);

// GET /api/admin/ads/inquiries/unread-count
router.get('/inquiries/unread-count', getAdminUnreadCount);

// PATCH /api/admin/ads/inquiries/:id/mark-read
router.patch('/inquiries/:id/mark-read', markAdminInquiryRead);

// PATCH /api/admin/ads/inquiries/:id/status  body { status }
router.patch('/inquiries/:id/status', patchAdminInquiryStatusById);

// Soft delete / restore
router.patch('/inquiries/:id/delete', deleteAdminInquiry);
router.patch('/inquiries/:id/restore', restoreAdminInquiry);

// Founder-only hard delete
router.delete('/inquiries/:id/hard', requireFounderAuth, hardDeleteAdminInquiry);

module.exports = router;
