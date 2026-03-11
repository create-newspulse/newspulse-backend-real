const express = require('express');

const { requireAdminAuth, requireFounderAuth } = require('../../middleware/adminAuth');
const {
  listAdminAdInquiries,
  getAdminUnreadCount,
  getAdminAdInquiryDiagnostics,
  markAdminInquiryRead,
  replyToAdInquiryV2,
  bulkPermanentDeleteV2,
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

// GET /admin-api/ads/inquiries/diagnostics
router.get('/inquiries/diagnostics', getAdminAdInquiryDiagnostics);

// PATCH /admin-api/ads/inquiries/:id/mark-read
router.patch('/inquiries/:id/mark-read', markAdminInquiryRead);

// POST /admin-api/ads/inquiries/:id/reply
router.post('/inquiries/:id/reply', replyToAdInquiryV2);

// PATCH /admin-api/ads/inquiries/:id/restore
router.patch('/inquiries/:id/restore', restoreAdminInquiry);

// DELETE /admin-api/ads/inquiries/bulk/permanent
// Payload: { ids: ["id1","id2"] }
router.delete('/inquiries/bulk/permanent', bulkPermanentDeleteV2);

// DELETE /admin-api/ads/inquiries/:id (soft delete)
router.delete('/inquiries/:id', deleteAdminInquiry);

// Compatibility aliases
router.patch('/inquiries/:id/delete', deleteAdminInquiry);
router.patch('/inquiries/:id/status', patchAdminInquiryStatusById);

// Founder-only hard delete
router.delete('/inquiries/:id/hard', requireFounderAuth, hardDeleteAdminInquiry);

module.exports = router;
