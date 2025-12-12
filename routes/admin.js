// routes/admin.js
// Admin panel routes used by https://admin.newspulse.co.in
// Mounted from server.js as /api/admin (and optionally /admin).

const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

// ✅ Shared admin/founder auth middleware
const {
  requireAdminAuth,
  requireFounderAuth,
} = require('../middleware/adminAuth');

// ✅ Admin controllers
// communitySettings & communityReporter live under controllers/ (not controllers/admin)
const communitySettingsController = require('../controllers/communitySettingsController');
const communityReporterController = require('../controllers/communityReporterController');
const {
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
} = require('../controllers/admin/communityFeatureToggles');

// Destructure controller functions for clarity
const {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
} = communitySettingsController;

const {
  listReporters,
  getCommunityStats,
  getCommunityReporterAnalytics,
} = communityReporterController;

// ─────────────────────────────────────────────
// In-memory rate limiter for /login
// ─────────────────────────────────────────────

const loginAttempts = new Map(); // key: ip, value: number[]
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  const fresh = arr.filter((ts) => now - ts < WINDOW_MS);
  loginAttempts.set(ip, fresh);
  return fresh.length >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  arr.push(now);
  loginAttempts.set(ip, arr);
}

// ─────────────────────────────────────────────
// POST /api/admin/login
// ─────────────────────────────────────────────
router.post('/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const { email = '', password = '' } = req.body || {};

  if (isRateLimited(ip)) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=rate-limit`);
    return res
      .status(429)
      .json({ ok: false, message: 'Too many login attempts. Please try again later.' });
  }

  recordAttempt(ip);

  const founderEmail = process.env.FOUNDER_EMAIL || '';
  const founderPassword = process.env.FOUNDER_PASSWORD || '';
  const founderName = process.env.FOUNDER_NAME || 'Founder';
  const founderId = process.env.FOUNDER_ID || 'founder-001';

  if (!founderEmail || !founderPassword) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=not-configured`);
    return res.status(500).json({ ok: false, message: 'Admin credentials not configured' });
  }

  if (email.toLowerCase() === founderEmail.toLowerCase() && password === founderPassword) {
    console.info(`ADMIN LOGIN SUCCESS email=${email} ip=${ip}`);

    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const token = jwt.sign(
      { sub: founderId, email: founderEmail, name: founderName, role: 'founder' },
      secret,
      { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' },
    );

    // Legacy cookie so old admin builds keep working
    const dev = (process.env.NODE_ENV || 'development') === 'development';
    const secureAttr = (process.env.ADMIN_COOKIE_SECURE === '0' || dev) ? '' : '; Secure';
    const sameSite = process.env.ADMIN_COOKIE_SAMESITE || (secureAttr ? 'None' : 'Lax');

    res.setHeader(
      'Set-Cookie',
      `np_admin=${encodeURIComponent(founderEmail)}; Path=/; SameSite=${sameSite}${secureAttr}`
    );

    return res.json({
      ok: true,
      token,
      user: {
        id: founderId,
        email: founderEmail,
        name: founderName,
        role: 'founder',
      },
    });
  }

  console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=invalid-credentials`);
  return res.status(401).json({ ok: false, message: 'Invalid credentials' });
});

// ─────────────────────────────────────────────
// Health + system stats
// ─────────────────────────────────────────────

// GET /api/admin/health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-backend',
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// GET /api/admin/system/health
router.get('/system/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const systemHealth = {
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  };
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'System stats fetched',
    data: { systemHealth },
  });
});

// ─────────────────────────────────────────────
// Reporter directory & community stats
// ─────────────────────────────────────────────

// GET /api/admin/reporters
router.get('/reporters', requireAdminAuth, listReporters);

// GET /api/admin/community/reporters (analytics)
router.get('/community/reporters', requireAdminAuth, getCommunityReporterAnalytics);

// GET /api/admin/community/stats
router.get('/community/stats', requireAdminAuth, getCommunityStats);

// ─────────────────────────────────────────────
// Community Settings (Admin / Founder)
// ─────────────────────────────────────────────

// GET   /api/admin/community/settings
router.get('/community/settings', requireAdminAuth, getAdminCommunitySettings);

// PATCH /api/admin/community/settings  (founder only)
router.patch('/community/settings', requireFounderAuth, patchAdminCommunitySettings);

// ─────────────────────────────────────────────
// Feature Toggles (Admin or Founder)
// ─────────────────────────────────────────────

// GET   /api/admin/feature-toggles   (admin or founder)
router.get('/feature-toggles', requireAdminAuth, getCommunityFeatureToggles);

// PATCH /api/admin/feature-toggles   (admin or founder)
router.patch('/feature-toggles', requireAdminAuth, updateCommunityFeatureToggles);

module.exports = router;
