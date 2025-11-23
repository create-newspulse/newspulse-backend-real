const express = require('express');
const jwt = require('jsonwebtoken');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// Auth middleware with safe debug logging (no full token output)
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookieHeader = req.headers.cookie || '';
  let cookieEmail = '';
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k === 'np_admin') cookieEmail = decodeURIComponent(v.join('=') || '');
    });
  }
  // Prefer JWT; fall back to admin cookie for legacy session compatibility.
  if (!token && !cookieEmail) {
    console.warn('[ADMIN_COMMUNITY_REPORTER][auth] missing bearer token and admin cookie');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  if (token) {
    try {
      const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
      const payload = jwt.verify(token, secret);
      if (!payload || (payload.role !== 'founder' && payload.role !== 'admin')) {
        console.warn('[ADMIN_COMMUNITY_REPORTER][auth] invalid role', { role: payload?.role });
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      req.admin = { id: payload.sub, email: payload.email, role: payload.role, name: payload.name };
      return next();
    } catch (e) {
      console.warn('[ADMIN_COMMUNITY_REPORTER][auth] token verify failed', { message: e?.message });
      // Fall through to cookie if present, else 401
      if (!cookieEmail) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
    }
  }
  if (cookieEmail) {
    req.admin = { id: 'cookie-admin', email: cookieEmail, role: 'admin', name: 'Admin' };
    return next();
  }
}

// GET /admin/community-reporter/submissions (mounted at /admin/community-reporter)
// Also available at /api/admin/community-reporter/submissions
router.get('/submissions', requireAdmin, async (req, res) => {
  try {
    const items = await CommunitySubmission
      .find({}, '_id name email location category headline status createdAt')
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, items });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
});

module.exports = router;