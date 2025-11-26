// middleware/adminAuth.js
// Shared admin/founder JWT + legacy cookie auth.
// Attaches req.admin on success.
// Responses:
// 401 -> missing/invalid token & no legacy cookie
// 403 -> present token but disallowed role
// Designed to align with other working admin endpoints expecting Authorization Bearer access tokens.

const jwt = require('jsonwebtoken');

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

function requireAdminAuth(req, res, next) {
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookies = parseCookies(req.headers.cookie || '');
  const legacyEmail = cookies['np_admin'] || '';

  if (!token && !legacyEmail) {
    console.warn('[ADMIN_AUTH][401][missing] no bearer token or np_admin cookie');
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  if (token) {
    try {
      const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
      const payload = jwt.verify(token, secret);
      const role = payload.role;
      if (role !== 'admin' && role !== 'founder') {
        console.warn('[ADMIN_AUTH][403][role] disallowed role', { role });
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
      req.admin = { id: payload.sub, email: payload.email, role, name: payload.name };
      return next();
    } catch (e) {
      if (e && e.message === 'jwt expired') {
        console.info('[ADMIN_AUTH][token] expired', { reason: 'access token expired' });
      } else {
        console.warn('[ADMIN_AUTH][token-verify-failed]', { message: e?.message });
      }
      if (!legacyEmail) {
        return res.status(401).json({ ok: false, message: 'Unauthorized' });
      }
    }
  }

  if (legacyEmail) {
    req.admin = { id: 'legacy-admin', email: legacyEmail, role: 'admin', name: 'Admin' };
    return next();
  }

  return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

module.exports = { requireAdminAuth };
