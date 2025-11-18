// routes/admin.js
// Admin panel routes used by https://admin.newspulse.co.in
// Exposes POST /admin/login and GET /admin/health at ROOT paths for the Vercel admin UI.

const express = require('express');
const router = express.Router();

// In-memory rate limiter state (per-IP)
const loginAttempts = new Map(); // key: ip, value: array of timestamps (ms)
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 20; // max attempts per window

function isRateLimited(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  // prune old
  const fresh = arr.filter(ts => now - ts < WINDOW_MS);
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
    return res.status(429).json({ ok: false, message: 'Too many login attempts. Please try again later.' });
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
    return res.json({
      ok: true,
      user: {
        id: founderId,
        email, // echo provided email
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
    env: (process.env.NODE_ENV || 'development'),
  });
});

module.exports = router;
