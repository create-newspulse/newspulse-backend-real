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
  const email = process.env.FOUNDER_EMAIL || '';
  const name = process.env.FOUNDER_NAME || 'Founder';
  const id = process.env.FOUNDER_ID || 'founder-001';

  if (email) {
    return res.json({ ok: true, user: { id, email, name, role: 'founder' } });
  }
  return res.json({ ok: false, message: 'Admin not configured' });
});

module.exports = router;
