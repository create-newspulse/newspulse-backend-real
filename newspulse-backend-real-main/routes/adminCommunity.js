const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../../middleware/adminAuth');

const router = express.Router();

// GET /api/admin/community/submissions
router.get('/submissions', requireAdminAuth, async (req, res) => {
  try {
    const docs = await CommunitySubmission
      .find({}, '_id userName email location category headline status createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const items = docs.map(d => ({
      _id: d._id, // keep raw _id for admin panel
      userName: d.userName,
      email: d.email,
      location: d.location,
      category: d.category,
      headline: d.headline,
      status: d.status,
      createdAt: d.createdAt,
    }));
    return res.json({ success: true, submissions: items });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
});

// GET /api/admin/community/submissions/:id
router.get('/submissions/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await CommunitySubmission.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, submission: doc });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][get-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

// POST /api/admin/community/submissions/:id/approve
router.post('/submissions/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await CommunitySubmission.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    doc.status = 'APPROVED';
    await doc.save();
    return res.json({ success: true });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][approve-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to approve submission' });
  }
});

// POST /api/admin/community/submissions/:id/reject
router.post('/submissions/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectReason } = req.body || {};
    const doc = await CommunitySubmission.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    doc.status = 'REJECTED';
    if (rejectReason) doc.rejectReason = String(rejectReason).trim();
    await doc.save();
    return res.json({ success: true });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][reject-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to reject submission' });
  }
});

module.exports = router;
