const express = require('express');
const jwt = require('jsonwebtoken');
const CommunitySubmission = require('../models/CommunitySubmission');
const router = express.Router();

// Lightweight admin auth middleware (Founder/Admin only)
function requireAdmin(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!token) return res.status(401).json({ ok: false, message: 'Missing auth token' });
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const payload = jwt.verify(token, secret);
    if (!payload || (payload.role !== 'founder' && payload.role !== 'admin')) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    req.admin = { id: payload.sub, email: payload.email, role: payload.role, name: payload.name };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
}

// GET /api/admin/community/submissions
router.get('/submissions', requireAdmin, async (req, res) => {
  try {
    const statusFilter = req.query.status ? req.query.status.split(',').map(s => s.trim()).filter(Boolean) : null;
    const defaultStatuses = ['NEW', 'PENDING_FOUNDER'];
    const statuses = statusFilter && statusFilter.length ? statusFilter : defaultStatuses;
    const query = { status: { $in: statuses } };
    const submissions = await CommunitySubmission.find(query, '_id name email location category headline status aiHeadline aiBody riskScore flags createdAt').sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, items: submissions });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][list-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});

// GET /api/admin/community/submissions/:id
router.get('/submissions/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const submission = await CommunitySubmission.findById(id).lean();
    if (!submission) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, submission });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][get-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load submission' });
  }
});

// PATCH /api/admin/community/submissions/:id/status
router.patch('/submissions/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectReason } = req.body || {};
    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'Status must be APPROVED or REJECTED' });
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Not found' });
    if (status === 'APPROVED') {
      submission.status = 'APPROVED';
      submission.rejectReason = undefined;
    } else if (status === 'REJECTED') {
      submission.status = 'REJECTED';
      submission.rejectReason = rejectReason || 'Not specified';
    }
    await submission.save();
    return res.json({ ok: true, submission: {
      _id: submission._id,
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      status: submission.status,
      rejectReason: submission.rejectReason,
      updatedAt: submission.updatedAt,
    }});
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][status-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to update status' });
  }
});

module.exports = router;
