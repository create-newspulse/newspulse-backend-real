// routes/admin.js
// Admin panel routes used by https://admin.newspulse.co.in
// Mounted from the main app as: app.use('/api/admin', adminRoutes)
// (also works under /admin for legacy mounting if you add that).

const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Auth middleware
const {
  requireAdminAuth,
  requireFounderOnly,
} = require('../../middleware/adminAuth');

// Community / reporters
const {
  listReporters,
  getCommunityStats,
} = require('../controllers/communityReporterController');

// Community Reporter feature toggles (Founder-only)
const {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
} = require('../controllers/admin/communitySettingsController');

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter for admin login
// ---------------------------------------------------------------------------

const loginAttempts = new Map();          // key: ip, value: array of timestamps (ms)
const WINDOW_MS = 15 * 60 * 1000;         // 15 minutes
const MAX_ATTEMPTS = 20;                  // max attempts per window

function isRateLimited(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  const fresh = arr.filter(ts => now - ts < WINDOW_MS); // prune old
  loginAttempts.set(ip, fresh);
  return fresh.length >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  arr.push(now);
  loginAttempts.set(ip, arr);
}

// ---------------------------------------------------------------------------
// POST /api/admin/login  (also /admin/login for legacy mount)
// ---------------------------------------------------------------------------
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

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  const founderName = process.env.FOUNDER_NAME || 'Founder';
  const founderId = process.env.FOUNDER_ID || 'founder-001';
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();

  if (!adminEmail || !adminPassword || !jwtSecret) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=not-configured`);
    return res.status(500).json({ ok: false, message: 'Admin credentials not configured' });
  }

  if (email.toLowerCase() === adminEmail.toLowerCase() && password === adminPassword) {
    console.info(`ADMIN LOGIN SUCCESS email=${email} ip=${ip}`);
    const token = jwt.sign(
      { sub: founderId, email: adminEmail, name: founderName, role: 'founder' },
      jwtSecret,
      { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' },
    );

    // Optional legacy cookie
    res.setHeader('Set-Cookie', `np_admin=${encodeURIComponent(adminEmail)}; Path=/; SameSite=Lax`);

    return res.json({
      ok: true,
      token,
      user: {
        id: founderId,
        email: adminEmail,
        name: founderName,
        role: 'founder',
      },
    });
  }

  console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=invalid-credentials`);
  return res.status(401).json({ ok: false, message: 'Invalid admin credentials' });
});

// POST /api/admin/logout
router.post('/logout', (_req, res) => {
  try {
    res.clearCookie('np_admin', { path: '/' });
    res.clearCookie('np_admin_token', { path: '/' });
    res.clearCookie('np_admin_email', { path: '/' });
    res.clearCookie('np_admin_session', { path: '/' });
  } catch (_) {}
  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/admin/health
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-backend',
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Protect everything below
router.use(requireAdminAuth);

// GET /api/admin/me
router.get('/me', (req, res) => {
  const a = req.admin || null;
  if (!a) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  return res.status(200).json({
    ok: true,
    authenticated: true,
    admin: {
      id: a.id || 'unknown',
      email: a.email || '',
      role: String(a.role || '').toLowerCase(),
    },
  });
});

// ---------------------------------------------------------------------------
// Admin Dashboard Stats – placeholder
// GET /api/admin/dashboard-stats
// ---------------------------------------------------------------------------
router.get('/dashboard-stats', (req, res) => {
  const data = {
    totalNews: 0,
    totalCategories: 0,
    totalLanguages: 1,
    activeUsers: 0,
    aiLogs: 0,
  };

  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Dashboard stats fetched',
    data,
  });
});

// ---------------------------------------------------------------------------
// Admin System Stats – placeholder
// GET /api/admin/stats
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Reporter Directory & Community Stats
// ---------------------------------------------------------------------------

// GET /api/admin/reporters
router.get('/reporters', requireAdminAuth, listReporters);

// GET /api/admin/community/stats
router.get('/community/stats', requireAdminAuth, getCommunityStats);

// ---------------------------------------------------------------------------
// Community Reporter Feature Toggles
// These are what the "Feature Toggles – Founder only" page is calling.
// ---------------------------------------------------------------------------

// GET   /api/admin/community/settings
router.get(
  '/community/settings',
  requireAdminAuth, // or requireFounderOnly if you want even stricter access
  getAdminCommunitySettings,
);

// PATCH /api/admin/community/settings
router.patch(
  '/community/settings',
  requireFounderOnly,
  patchAdminCommunitySettings,
);

module.exports = router;
