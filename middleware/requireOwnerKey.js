const jwt = require('jsonwebtoken');

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach((c) => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

function requireOwnerKey(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = String(cookies.owner_key || '').trim();
    if (!token) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'OWNER_KEY_REQUIRED', message: 'Owner key required' });
    }

    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (e) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'OWNER_KEY_INVALID', message: 'Owner key invalid or expired' });
    }

    if (!payload || payload.type !== 'owner_key' || payload.sub !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'OWNER_KEY_FORBIDDEN', message: 'Owner key forbidden' });
    }

    req.ownerKey = { ownerId: 'founder', issuedAt: payload.iat || null, exp: payload.exp || null };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'OWNER_KEY_INVALID', message: 'Owner key invalid or expired' });
  }
}

module.exports = { requireOwnerKey };
