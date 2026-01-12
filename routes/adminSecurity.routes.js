const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, status: 200, data });
}

function bad(res, status, message, code = null) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

async function loadUser(req) {
  if (!isDbReady()) return null;
  const admin = req.admin || {};
  const sub = admin.id && mongoose.isValidObjectId(admin.id) ? String(admin.id) : null;
  if (sub) {
    const byId = await User.findById(sub).lean();
    if (byId) return byId;
  }
  const email = admin.email ? String(admin.email).toLowerCase() : '';
  if (!email) return null;
  return User.findOne({ email }).lean();
}

// GET /api/admin/security/session
router.get('/security/session', requireAdminAuth, async (req, res) => {
  const token = getBearerToken(req);
  let issuedAt = null;
  let expiresAt = null;

  if (token && process.env.JWT_SECRET) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload && payload.iat) issuedAt = new Date(payload.iat * 1000).toISOString();
      if (payload && payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    } catch (_) {
      // ignore
    }
  }

  const user = await loadUser(req);

  return ok(res, {
    email: req.admin?.email || null,
    role: req.admin?.role || null,
    status: user?.status || null,
    issuedAt,
    expiresAt,
    lastLoginAt: user?.lastLoginAt || null,
  });
});

// POST /api/admin/security/logout
// Clears cookies and invalidates current JWT session (tokenVersion++) when possible.
router.post('/security/logout', requireAdminAuth, async (req, res) => {
  try {
    try { res.clearCookie('token'); } catch {}
    try { res.clearCookie('np_token'); } catch {}
    try { res.clearCookie('np_admin_token'); } catch {}

    if (isDbReady()) {
      const user = await loadUser(req);
      if (user && user._id) {
        await User.findByIdAndUpdate(user._id, { $inc: { tokenVersion: 1 } });
      }
    }

    await logAudit(req, 'LOGOUT', req.admin?.id || null, null);
    return ok(res, { ok: true });
  } catch (_e) {
    return ok(res, { ok: true });
  }
});

// POST /api/admin/security/logout-all
// Founder-only (can target self or another user via body.userId)
router.post('/security/logout-all', requireFounderAuth, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetUserId = body.userId ? String(body.userId) : (mongoose.isValidObjectId(req.admin?.id) ? String(req.admin.id) : null);

  if (!targetUserId || !mongoose.isValidObjectId(targetUserId)) {
    return bad(res, 400, 'Invalid userId');
  }

  const updated = await User.findByIdAndUpdate(
    targetUserId,
    { $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');

  await logAudit(req, 'LOGOUT_ALL', targetUserId, null);
  return ok(res, { ok: true });
});

module.exports = router;
