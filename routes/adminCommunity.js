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

// GET /api/admin/community/submissions (admin queue listing)
router.get('/submissions', requireAdmin, async (req, res) => {
  try {
    const { status, category } = req.query || {};
    const waitingStatuses = ['NEW', 'AI_REVIEWED', 'PENDING_FOUNDER'];
    const filter = {};

    if (status === 'approved') filter.status = 'APPROVED';
    else if (status === 'rejected') filter.status = 'REJECTED';
    else if (status === 'all') {
      // no status filter
    } else if (typeof status === 'string' && status.includes(',')) {
      const parts = status.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) filter.status = { $in: parts };
      else filter.status = { $in: waitingStatuses };
    } else if (status) {
      filter.status = status;
    } else if (status !== 'all') {
      filter.status = { $in: waitingStatuses };
    }

    if (category && category !== 'all') {
      filter.category = String(category).trim();
    }

    const submissions = await CommunitySubmission
      .find(filter, '_id name email location category headline status aiHeadline aiBody riskScore flags createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, submissions });
  } catch (e) {
    console.error('[Admin] Failed to load community submissions', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load community submissions' });
  }
});
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

// GET /api/admin/community/submissions/:id (detail view)
router.get('/submissions/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing submission id' });
    }
    // Optional ObjectId shape validation (24 hex chars)
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) {
      return res.status(400).json({ success: false, message: 'Invalid submission id format' });
    }
    const submission = await CommunitySubmission.findById(id).lean();
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }
    return res.json({ success: true, submission });
  } catch (err) {
    console.error('[Admin] Error loading community submission by id', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

module.exports = router;

// GET /api/admin/community/reporter-contacts
router.get('/reporter-contacts', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const docs = await CommunitySubmission.find({}).lean();

    const map = new Map();
    for (const d of docs) {
      const name = d.contact?.name || d.userName || d.reporterName || d.name || 'Unknown reporter';
      const email = d.contact?.email || d.reporterEmail || d.email || null;
      const phone = d.contact?.phone || null;
      const city = d.locationDetail?.city || d.city || null;
      const state = d.locationDetail?.state || d.state || null;
      const country = d.locationDetail?.country || d.country || null;
      const key = (email || phone || (d._id && d._id.toString()) || 'unknown').toString();
      const createdAt = d.createdAt ? new Date(d.createdAt) : null;
      const entry = map.get(key) || { id: key, name, email, phone, city, state, country, totalStories: 0, lastStoryAt: null };
      entry.totalStories += 1;
      if (!entry.lastStoryAt || (createdAt && createdAt > entry.lastStoryAt)) {
        entry.lastStoryAt = createdAt;
      }
      // Prefer most recent non-null values for name and location
      entry.name = name || entry.name;
      entry.email = email || entry.email;
      entry.phone = phone || entry.phone;
      entry.city = city || entry.city;
      entry.state = state || entry.state;
      entry.country = country || entry.country;
      map.set(key, entry);
    }

    const allItems = Array.from(map.values()).sort((a, b) => {
      const ta = a.lastStoryAt ? a.lastStoryAt.getTime() : 0;
      const tb = b.lastStoryAt ? b.lastStoryAt.getTime() : 0;
      return tb - ta;
    });

    const start = (page - 1) * limit;
    const pagedItems = allItems.slice(start, start + limit);
    const total = allItems.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({ ok: true, items: pagedItems, page, totalPages, total });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][contacts-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load reporter contacts' });
  }
});
