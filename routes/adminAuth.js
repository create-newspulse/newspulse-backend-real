const express = require('express');
const router = express.Router();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((c) => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

// Lightweight session probe
// When mounted at /api/admin-auth, respond at /session
router.get('/session', (req, res) => {
  const auth = String(req.headers['authorization'] || '');
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : '';
  const cookies = parseCookies(req);
  const cookieEmail = cookies['np_admin'] || cookies['adminEmail'] || '';

  if (bearer || cookieEmail) {
    // Minimal shape expected by the admin UI
    const email = cookieEmail || 'admin@newspulse.ai';
    // Include top-level email for legacy consumers in the admin UI
    return res.json({ ok: true, authenticated: true, email, user: { id: 'self', email, role: 'admin' } });
  }
  return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
});

// Simple login endpoint (env-based founder creds + optional alternate creds)
// Supports FOUNDER_EMAIL/FOUNDER_PASSWORD (primary) and optional FOUNDER_ALT_EMAIL/FOUNDER_ALT_PASSWORD (secondary)
// When mounted at /api/admin, path is /api/admin/login
router.post('/login', (req, res) => {
  try {
    const body = req.body || {};
    const origin = String(req.headers.origin || req.headers.referer || '').trim();

    const primaryEmail = (process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL || 'admin@newspulse.ai').toLowerCase();
    // Support both ADMIN_PASSWORD (common) and legacy ADMIN_PASS (older deployments)
    const primaryPass = process.env.FOUNDER_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'Safe!2025@News';
    const altEmailRaw = (process.env.FOUNDER_ALT_EMAIL || process.env.ADMIN_ALT_EMAIL || '').trim();
    const altPass = process.env.FOUNDER_ALT_PASSWORD || process.env.ADMIN_ALT_PASS || '';
    const altEmail = altEmailRaw.toLowerCase();

    const allowedCombos = [
      { email: primaryEmail, pass: primaryPass },
      ...(altEmail && altPass ? [{ email: altEmail, pass: altPass }] : []),
    ];

    // Security note: do not hard-code credentials.
    // Configure FOUNDER_EMAIL/FOUNDER_PASSWORD (and optionally FOUNDER_ALT_*) via environment variables.

    console.log('[admin/login] attempt', {
      origin,
      providedEmail: body.email,
      emailList: allowedCombos.map(c => c.email),
      nodeEnv: process.env.NODE_ENV || 'development',
      altConfigured: !!(altEmail && altPass),
    });

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', message: 'Email and password required' });
    }

    const matched = allowedCombos.find(c => c.email === email && c.pass === password);
    if (!matched) {
      console.warn('[admin/login] invalid credentials', { email, passwordLen: password.length });
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
    }

    // Issue a lightweight opaque token and set cookie for session probe
    const token = `np.${Buffer.from(`${email}:${Date.now()}`).toString('base64')}`;
    const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
    const cookieOpts = {
      httpOnly: true,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
    };
    try { res.cookie('np_admin', email, cookieOpts); } catch {}

    return res.json({
      ok: true,
      token,
      user: { id: 'founder', name: 'Founder', email, role: 'founder' },
      alternate: matched.email === altEmail, // flag if alt creds used
    });
  } catch (err) {
    console.error('admin login error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'LOGIN_FAILED', message: 'Login failed' });
  }
});

// Public founder identity stub (no auth) for admin panel bootstrap.
// Reachable as /api/admin/me when this router is mounted under /api/admin.
router.get('/me', (req, res) => {
  return res.json({
    ok: true,
    id: 'founder',
    name: 'Kiran Parmar',
    role: 'founder',
    permissions: ['founder', 'full_access']
  });
});

module.exports = router;
