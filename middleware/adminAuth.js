// middleware/adminAuth.js
// Shared admin/founder JWT + legacy cookie auth.
// Attaches req.admin on success.
// Responses:
// 401 -> missing/invalid token & no legacy cookie
// 403 -> present token but disallowed role
// Designed to align with other working admin endpoints expecting Authorization Bearer access tokens.

const jwt = require('jsonwebtoken');
const { shouldLog } = require('../lib/logThrottle');

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
  // Accept multiple legacy cookie keys for backward compatibility with older admin panel builds
  const legacyEmail = cookies['np_admin'] || cookies['np_admin_email'] || '';
  // Optional explicit access cookie (contains email value). Not considered privileged beyond email identification.
  const accessEmail = cookies['np_admin_access'] || '';

  if (!token && !legacyEmail && !accessEmail) {
    console.warn('[ADMIN_AUTH][401][missing] no bearer token or recognized admin cookie');
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  if (token) {
    try {
      // Accept opaque admin tokens issued by /admin-auth/login (prefix np.)
      if (token.startsWith('np.')) {
        req.admin = { id: 'opaque', email: 'admin@newspulse.ai', role: 'admin', name: 'Admin' };
        return next();
      }
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
        // Throttle noisy expired token logs (once per 60s per route key)
        const key = `adminAuth.expired:${req.method}:${req.originalUrl.split('?')[0]}`;
        if (shouldLog(key, 60_000)) {
          console.info('[ADMIN_AUTH][token] expired', { reason: 'access token expired' });
        }
      } else {
        console.warn('[ADMIN_AUTH][token-verify-failed]', { message: e?.message });
      }
      if (!legacyEmail) {
        // Provide a machine-readable code to help clients trigger refresh.
        return res.status(401).json({ ok: false, code: 'TOKEN_EXPIRED_OR_INVALID', message: 'Unauthorized' });
      }
    }
  }

  if (legacyEmail || accessEmail) {
    const emailVal = (legacyEmail || accessEmail);
    req.admin = { id: 'legacy-admin', email: emailVal, role: 'admin', name: 'Admin' };
    return next();
  }

  return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

module.exports = { requireAdminAuth };
