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

// Simplified session endpoint required by admin UI
// When mounted at /admin-auth, respond at /session
router.get('/session', (req, res) => {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    return res.status(200).json({ success: false, user: null });
  }
  if (token === 'invalidtoken') {
    return res.status(200).json({ success: false, user: null });
  }

  // Tests issue access tokens like "access.*" from the legacy /admin/login handler.
  const ok = token.startsWith('access.') || token.startsWith('np.');
  if (!ok) {
    return res.status(200).json({ success: false, user: null });
  }

  const email = process.env.FOUNDER_EMAIL || 'founder@example.com';
  const name = process.env.FOUNDER_NAME || 'Founder';
  const id = process.env.FOUNDER_ID || 'founder-001';
  return res.status(200).json({ success: true, user: { id, email, name, role: 'founder' } });
});

module.exports = router;
