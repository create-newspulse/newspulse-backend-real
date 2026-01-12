const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function loadUserFromPayload(payload) {
  const sub = payload && payload.sub ? String(payload.sub) : '';
  const email = payload && payload.email ? String(payload.email).toLowerCase() : '';

  if (sub && mongoose.isValidObjectId(sub)) {
    const byId = await User.findById(sub);
    if (byId) return byId;
  }

  if (email) {
    return User.findOne({ email });
  }

  return null;
}

function normalizeRole(roleRaw) {
  const role = String(roleRaw || '').toLowerCase();
  if (role === 'founder' || role === 'admin' || role === 'editor' || role === 'staff') return role;
  return 'staff';
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, success: false, status: 500, code: 'SERVER_ERROR', message: 'JWT_SECRET missing' });
    }

    const payload = jwt.verify(token, secret);

    // If DB is down, fall back to payload-only auth (keeps dev/test from hard failing).
    if (!isDbReady()) {
      req.user = {
        id: payload.sub || payload.userId || null,
        email: payload.email || null,
        name: payload.name || null,
        role: normalizeRole(payload.role),
        tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0,
      };
      return next();
    }

    const user = await loadUserFromPayload(payload);
    if (!user) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Account suspended' });
    }

    const jwtTokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
    const userTokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;

    if (jwtTokenVersion !== userTokenVersion) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: normalizeRole(user.role),
      designation: user.designation || null,
      permissions: Array.isArray(user.permissions) ? user.permissions : [],
      status: user.status || 'active',
      mustChangePassword: Boolean(user.mustChangePassword || user.forceReset),
      tokenVersion: userTokenVersion,
    };

    req._authUserDoc = user;
    return next();
  } catch (_e) {
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

function requireFounder(req, res, next) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : '';
  if (role === 'founder') return next();
  return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
}

module.exports = { requireAuth, requireFounder };
