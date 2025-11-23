const express = require('express');
const jwt = require('jsonwebtoken');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// Auth middleware (mirrors logic in adminCommunity.js)
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

// GET /admin/community-reporter/submissions (mounted alias) & /api/admin/community-reporter/submissions
router.get('/submissions', requireAdmin, async (req, res) => {
  try {
    const submissions = await CommunitySubmission.find({}, '_id name email location category headline status createdAt').sort({ createdAt: -1 }).lean();
    return res.json({ submissions });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});

module.exports = router;