// middleware/adminAuth.js
// Shared admin/founder JWT + legacy cookie auth.
// Attaches req.admin on success.
// Responses:
// 401 -> missing/invalid token & no legacy cookie
// 403 -> present token but disallowed role
// Designed to align with other working admin endpoints expecting Authorization Bearer access tokens.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { shouldLog } = require('../lib/logThrottle');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

async function requireAdminAuth(req, res, next) {
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookies = parseCookies(req.headers.cookie || '');
  // Accept multiple legacy cookie keys for backward compatibility with older admin panel builds
  // Common variants observed in production/admin panel: np_admin, np_admin_email, np_admin_session
  const legacyEmail = cookies['np_admin'] || cookies['np_admin_email'] || cookies['np_admin_session'] || '';
  // Optional explicit access cookie (contains email value). Not considered privileged beyond email identification.
  const accessEmail = cookies['np_admin_access'] || '';
  // Some builds store an opaque admin token in a cookie; treat it like Bearer if present
  const cookieToken = cookies['np_admin_token'] || '';

  if (!token && !legacyEmail && !accessEmail && !cookieToken) {
    console.warn('[ADMIN_AUTH][401][missing]', {
      path: req.originalUrl,
      method: req.method,
      reason: 'no bearer token or recognized admin cookie',
      origin: req.headers.origin || null,
    });
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }

  const effectiveToken = token || cookieToken;
  if (effectiveToken) {
    try {
      // Accept opaque admin tokens issued by /admin-auth/login (prefix np.)
      if (effectiveToken.startsWith('np.')) {
        const decoded = decodeNpOpaqueToken(effectiveToken);
        const email = decoded && decoded.email ? decoded.email : 'admin@newspulse.ai';
        const founderEmail = String(process.env.FOUNDER_EMAIL || 'founder@example.com').toLowerCase();
        const role = founderEmail && String(email).toLowerCase() === founderEmail ? 'founder' : 'admin';
        req.admin = { id: 'opaque', email, role, name: role === 'founder' ? 'Founder' : 'Admin' };
        return next();
      }
      const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
      const payload = jwt.verify(effectiveToken, secret);
      const role = payload.role;
      if (role !== 'admin' && role !== 'founder' && role !== 'staff' && role !== 'editor' && role !== 'legal') {
        console.warn('[ADMIN_AUTH][403][role] disallowed role', {
          path: req.originalUrl,
          method: req.method,
          role,
        });
        return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
      }
      // If DB is ready and token is tied to a user, enforce account status + tokenVersion
      // and enrich req.admin with persisted permissions/status fields.
      if (isDbReady()) {
        const sub = payload && payload.sub ? String(payload.sub) : '';
        const email = payload && payload.email ? String(payload.email).toLowerCase() : '';
        let user = null;
        if (sub && mongoose.isValidObjectId(sub)) {
          user = await User.findById(sub).lean();
        }
        if (!user && email) {
          user = await User.findOne({ email }).lean();
        }

        if (user) {
          if (user.status === 'suspended') {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Account suspended' });
          }
          const jwtTv = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
          const userTv = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
          if (jwtTv !== userTv) {
            return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
          }

          req.admin = {
            id: payload.sub,
            email: payload.email,
            role,
            name: payload.name,
            permissions: Array.isArray(user.permissions) ? user.permissions : [],
            status: user.status || 'active',
            tokenVersion: userTv,
            lastLoginAt: user.lastLoginAt || null,
            mustChangePassword: Boolean(user.mustChangePassword || user.forceReset),
          };
          return next();
        }
      }

      req.admin = { id: payload.sub, email: payload.email, role, name: payload.name };
      return next();
    } catch (e) {
      if (e && e.message === 'jwt expired') {
        // Throttle noisy expired token logs (once per 60s per route key)
        const key = `adminAuth.expired:${req.method}:${req.originalUrl.split('?')[0]}`;
        if (shouldLog(key, 60_000)) {
          console.info('[ADMIN_AUTH][token] expired', {
            path: req.originalUrl,
            method: req.method,
            reason: 'access token expired',
          });
        }
      } else {
        console.warn('[ADMIN_AUTH][token-verify-failed]', {
          path: req.originalUrl,
          method: req.method,
          message: e?.message,
        });
      }
      if (!legacyEmail) {
        // Provide a machine-readable code to help clients trigger refresh.
        return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
    }
  }

  if (legacyEmail || accessEmail) {
    const emailValRaw = (legacyEmail || accessEmail);
    const emailVal = String(emailValRaw || '').toLowerCase();
    const founderEmail = String(process.env.FOUNDER_EMAIL || 'founder@example.com').toLowerCase();
    const isFounder = founderEmail && emailVal === founderEmail;
    req.admin = {
      id: isFounder ? 'founder' : 'legacy-admin',
      email: emailValRaw,
      role: isFounder ? 'founder' : 'admin',
      name: isFounder ? 'Founder' : 'Admin',
    };
    return next();
  }

  console.warn('[ADMIN_AUTH][401][fallback]', {
    path: req.originalUrl,
    method: req.method,
    reason: 'no valid token or cookie after checks',
    origin: req.headers.origin || null,
  });
  return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
}

// Strict admin auth for session probes (e.g. GET /admin-api/admin/me).
// - Bearer token required (no legacy email cookies)
// - Missing/invalid/expired token => 401 JSON
// - If DB is connected, user must exist; otherwise treat as not logged in
async function requireAdminJwt(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '');
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
      // Should be prevented by startup checks, but keep response stable.
      return res.status(500).json({ ok: false, message: 'Server misconfigured' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (_e) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const role = payload && payload.role ? String(payload.role) : '';
    if (!role) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const userId = payload.sub || payload.userId || null;
    const email = payload.email || null;

    // If DB is ready, require a real user record.
    if (isDbReady()) {
      let user = null;
      if (userId && mongoose.isValidObjectId(String(userId))) {
        user = await User.findById(String(userId)).lean();
      }
      if (!user && email) {
        user = await User.findOne({ email: String(email).toLowerCase() }).lean();
      }

      if (!user) {
        return res.status(401).json({ ok: false, message: 'Unauthorized' });
      }
      if (user.status === 'suspended') {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }

      const jwtTv = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
      const userTv = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
      if (jwtTv !== userTv) {
        return res.status(401).json({ ok: false, message: 'Unauthorized' });
      }

      req.admin = {
        id: String(user._id),
        email: user.email,
        role: user.role,
        name: user.name,
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
        status: user.status || 'active',
        tokenVersion: userTv,
      };
      return next();
    }

    // DB not ready: fall back to token-only identity.
    req.admin = {
      id: userId ? String(userId) : 'unknown',
      email: email ? String(email) : '',
      role: String(role).toLowerCase(),
      name: payload.name ? String(payload.name) : undefined,
    };
    return next();
  } catch (_e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
}

function decodeNpOpaqueToken(tok) {
  // Token format: np.<base64(email:timestamp)>
  try {
    const raw = String(tok || '');
    if (!raw.startsWith('np.')) return null;
    const b64 = raw.slice('np.'.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const [email] = decoded.split(':');
    const cleaned = String(email || '').trim();
    return cleaned ? { email: cleaned } : null;
  } catch (_) {
    return null;
  }
}

function requireFounderOnly(req, res, next) {
  // First ensure admin auth passes
  requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return; // express error path
    const role = (req.admin && req.admin.role) || 'admin';
    if (role !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }
    return next();
  });
}
// Alias for clarity with routing instructions
const requireFounderAuth = requireFounderOnly;

module.exports = { requireAdminAuth, requireAdminJwt, requireFounderOnly, requireFounderAuth };
