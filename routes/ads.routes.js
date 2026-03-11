const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  submitPublicAdInquiry,
  listAdminAdInquiriesV2,
  getAdminAdInquiryByIdV2,
  getAdminUnreadCountV2,
  getAdminAdInquiryDiagnostics,
  replyToAdInquiryV2,
  bulkMarkReadV2,
  bulkTrashV2,
  bulkRestoreV2,
  bulkPermanentDeleteV2,
  markAdminInquiryReadV2,
  trashAdminInquiry,
  restoreAdminInquiryV2,
  permanentDeleteAdminInquiryV2,
} = require('../controllers/adsInquiriesController');

const router = express.Router();

function _logAdsInquiryAccess(tag) {
  return (req, _res, next) => {
    try {
      const env = String(process.env.NODE_ENV || 'development').toLowerCase();
      if (env !== 'test') {
        const pathOnly = String(req.originalUrl || '').split('?')[0];
        // Avoid logging auth headers/cookies; only log safe request metadata.
        // eslint-disable-next-line no-console
        console.log('[ads-inquiries]', tag, {
          method: req.method,
          path: pathOnly,
          query: req.query || {},
          params: req.params || {},
          idsCount: Array.isArray(req.body?.ids) ? req.body.ids.length : undefined,
          readyState: typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1,
          dbName: mongoose?.connection?.name ? String(mongoose.connection.name) : null,
        });
      }
    } catch (_) {}
    return next();
  };
}

// Public submission endpoint (no auth)
// POST /api/ads/inquiries
router.post('/inquiries', submitPublicAdInquiry);

// Admin-only endpoints (JWT/cookie auth)
router.get('/inquiries', _logAdsInquiryAccess('list'), requireAdminAuth, listAdminAdInquiriesV2);
router.get('/inquiries/unread-count', _logAdsInquiryAccess('unread-count'), requireAdminAuth, getAdminUnreadCountV2);
router.get('/inquiries/diagnostics', _logAdsInquiryAccess('diagnostics'), requireAdminAuth, getAdminAdInquiryDiagnostics);
router.get('/inquiries/:id', requireAdminAuth, getAdminAdInquiryByIdV2);

// Bulk actions (admin-only)
// Payload: { ids: ["id1", "id2"] }
router.patch('/inquiries/bulk/read', _logAdsInquiryAccess('bulk-read'), requireAdminAuth, bulkMarkReadV2);
router.patch('/inquiries/bulk/trash', _logAdsInquiryAccess('bulk-trash'), requireAdminAuth, bulkTrashV2);
router.patch('/inquiries/bulk/restore', _logAdsInquiryAccess('bulk-restore'), requireAdminAuth, bulkRestoreV2);
router.delete('/inquiries/bulk/permanent', _logAdsInquiryAccess('bulk-permanent-delete'), requireAdminAuth, bulkPermanentDeleteV2);

// Mutations (admin-only)
router.patch('/inquiries/:id/read', _logAdsInquiryAccess('mark-read'), requireAdminAuth, markAdminInquiryReadV2);
router.post('/inquiries/:id/reply', requireAdminAuth, replyToAdInquiryV2);
router.patch('/inquiries/:id/trash', _logAdsInquiryAccess('trash'), requireAdminAuth, trashAdminInquiry);
router.patch('/inquiries/:id/restore', _logAdsInquiryAccess('restore'), requireAdminAuth, restoreAdminInquiryV2);
router.delete('/inquiries/:id/permanent', _logAdsInquiryAccess('permanent-delete'), requireAdminAuth, permanentDeleteAdminInquiryV2);

// Non-ambiguous safety: do NOT reuse generic DELETE for soft delete.
// Clients should call PATCH /trash (soft) or DELETE /permanent (hard).
router.delete('/inquiries/:id', requireAdminAuth, (_req, res) => {
  return res.status(405).json({
    success: false,
    message: 'Deprecated. Use PATCH /api/ads/inquiries/:id/trash (soft delete) or DELETE /api/ads/inquiries/:id/permanent (hard delete).',
  });
});

module.exports = router;
