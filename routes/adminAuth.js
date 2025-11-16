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
    return res.json({ ok: true, authenticated: true, user: { id: 'self', email, role: 'admin' } });
  }
  return res.status(401).json({ ok: false, authenticated: false });
});

module.exports = router;
