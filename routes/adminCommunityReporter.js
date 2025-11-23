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

// Optional internal key enforcement (strict only in production)
function requireInternalAdminKey(req, res, next) {
  const expected = (process.env.ADMIN_INTERNAL_KEY || '').trim();
  const provided = (req.headers['x-admin-internal-key'] || '').trim();
  const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
  if (!expected) {
    // No key configured: allow but log once in production for visibility
    if (isProd) console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] expected key not set (production)');
    return next();
  }
  if (isProd) {
    if (!provided || provided !== expected) {
      console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] invalid or missing key (production)');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return next();
  }
  // Non-production: allow if missing, log relaxation
  if (!provided || provided !== expected) {
    console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] relaxed check (non-production)');
  }
  return next();
}

// GET /admin/community-reporter/submissions (mounted at /admin/community-reporter)
// Also available at /api/admin/community-reporter/submissions
function externalStatus(internal) {
  switch (internal) {
    case 'NEW': return 'pending';
    case 'APPROVED': return 'approved';
    case 'REJECTED': return 'rejected';
    default: return 'pending';
  }
}

router.get('/submissions', requireAdmin, requireInternalAdminKey, async (req, res) => {
  try {
    const raw = await CommunitySubmission
      .find({}, '_id name email location category headline status createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const items = raw.map(r => ({
      id: r._id.toString(),
      name: r.name,
      email: r.email,
      location: r.location,
      category: r.category,
      headline: r.headline,
      status: externalStatus(r.status),
      createdAt: r.createdAt,
    }));
    return res.status(200).json({ success: true, items });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
});

// PATCH approve
router.patch('/submissions/:id/approve', requireAdmin, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ success: false, message: 'Not found' });
    submission.status = 'APPROVED';
    await submission.save();
    return res.json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      status: externalStatus(submission.status),
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    }});
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][approve-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to approve submission' });
  }
});

// PATCH reject
router.patch('/submissions/:id/reject', requireAdmin, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ success: false, message: 'Not found' });
    submission.status = 'REJECTED';
    await submission.save();
    return res.json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      status: externalStatus(submission.status),
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    }});
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][reject-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to reject submission' });
  }
});

module.exports = router;