const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// Shared auth now handled by requireAdminAuth middleware.

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

router.get('/submissions', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    console.log('[ADMIN_COMMUNITY_REPORTER][hit]', { adminId: req.admin?.id, role: req.admin?.role });
    const raw = await CommunitySubmission
      .find({}, '_id name email location category headline status aiHeadline aiBody riskScore flags createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const items = raw.map(r => ({
      id: r._id.toString(),
      name: r.name,
      email: r.email,
      location: r.location,
      category: r.category,
      headline: r.headline,
      aiHeadline: r.aiHeadline,
      aiBody: r.aiBody,
      riskScore: r.riskScore,
      flags: Array.isArray(r.flags) ? r.flags : [],
      status: externalStatus(r.status),
      createdAt: r.createdAt,
    }));
    return res.status(200).json({ submissions: items });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
});

// PATCH approve
router.patch('/submissions/:id/approve', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
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
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
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
router.patch('/submissions/:id/reject', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
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
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
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