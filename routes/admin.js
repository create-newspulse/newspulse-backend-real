// routes/admin.js
// Admin panel routes used by https://admin.newspulse.co.in
// Exposes POST /admin/login and GET /admin/health at ROOT paths for the Vercel admin UI.

const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

// ✅ correct relative paths from routes/admin.js
const {
  requireAdminAuth,
  requireFounderOnly,
} = require('../middleware/adminAuth');

const communitySettingsController = require('../controllers/communitySettingsController');
const communityReporterController = require('../controllers/communityReporterController');

const {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
} = communitySettingsController;

const {
  listReporters,
  getCommunityStats,
} = communityReporterController;

// In-memory rate limiter state (per-IP)
const loginAttempts = new Map(); // key: ip, value: array of timestamps (ms)
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 20; // max attempts per window

function isRateLimited(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  // prune old
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

// Rate-limit + logging wrapper
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
    // Issue JWT for bearer auth compatibility
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const token = jwt.sign(
      { sub: founderId, email: founderEmail, name: founderName, role: 'founder' },
      secret,
      { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' },
    );

    // Optional legacy cookie for backward compatibility
    res.setHeader('Set-Cookie', `np_admin=${encodeURIComponent(founderEmail)}; Path=/; SameSite=Lax`);

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

// GET /admin/health - lightweight health check
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-backend',
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// --- Admin Dashboard Stats ---
// GET /api/admin/dashboard-stats (mounted via app.use('/api/admin', adminRoutes))
// Also works under /admin/dashboard-stats for legacy mounting.
router.get('/dashboard-stats', (req, res) => {
  // Basic placeholder stats. Replace with real DB queries as needed.
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

// --- Admin System Stats ---
// GET /api/admin/stats (mounted via app.use('/api/admin', adminRoutes))
// Also works under /admin/stats for legacy mounting.
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

// --- Admin Reporter Directory & Community Stats ---
// GET /api/admin/reporters
router.get('/reporters', requireAdminAuth, listReporters);
// GET /api/admin/community/stats
router.get('/community/stats', requireAdminAuth, getCommunityStats);

// --- Community Settings ---
// GET   /api/admin/community/settings
router.get('/community/settings', requireAdminAuth, getAdminCommunitySettings);
// PATCH /api/admin/community/settings (founder-only)
router.patch('/community/settings', requireFounderOnly, patchAdminCommunitySettings);

module.exports = router;
