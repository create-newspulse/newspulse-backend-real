const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');

const router = express.Router();

function isProd() {
  const envRaw = String(process.env.NODE_ENV || 'development').toLowerCase();
  const isRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  return envRaw === 'production' || isRender;
}

function requireOwnerBootstrapKey(req, res, next) {
  const expected = String(process.env.OWNER_BOOTSTRAP_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ ok: false, status: 503, code: 'BOOTSTRAP_NOT_CONFIGURED', message: 'OWNER_BOOTSTRAP_KEY not configured' });
  }

  const provided = String(req.headers['x-owner-key'] || '').trim();
  if (!provided) {
    return res.status(401).json({ ok: false, status: 401, code: 'OWNER_KEY_REQUIRED', message: 'Owner key required' });
  }

  if (provided !== expected) {
    return res.status(401).json({ ok: false, status: 401, code: 'OWNER_KEY_INVALID', message: 'Owner key invalid' });
  }

  return next();
}

function passwordPolicyOk(password) {
  // Minimum policy: 8+ chars, at least one letter + one number.
  const pw = String(password || '');
  if (pw.length < 8) return false;
  if (!/[A-Za-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}

async function anyUsersExist() {
  if (!(mongoose.connection && mongoose.connection.readyState === 1)) return false;
  const count = await User.estimatedDocumentCount();
  return count > 0;
}

async function upsertFounder({ email, password, fullName }) {
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  const passwordHash = await bcrypt.hash(password, rounds);

  const existing = await User.findOne({ email });
  if (!existing) {
    const created = await User.create({
      email,
      name: fullName,
      passwordHash,
      role: 'founder',
      status: 'active',
      permissions: ['team.manage', 'audit.read', 'settings.read'],
      mustChangePassword: false,
      mustResetPassword: false,
      forceReset: false,
      tokenVersion: 0,
      createdAt: new Date(),
      lastLoginAt: null,
    });
    return { created: true, reset: false, userId: String(created._id) };
  }

  existing.name = fullName || existing.name;
  existing.passwordHash = passwordHash;
  existing.role = 'founder';
  existing.status = 'active';
  existing.mustChangePassword = false;
  existing.mustResetPassword = false;
  existing.forceReset = false;
  existing.tokenVersion = (typeof existing.tokenVersion === 'number' ? existing.tokenVersion : 0) + 1;

  const perms = new Set(Array.isArray(existing.permissions) ? existing.permissions : []);
  perms.add('team.manage');
  perms.add('audit.read');
  perms.add('settings.read');
  existing.permissions = Array.from(perms);

  await existing.save();
  return { created: false, reset: true, userId: String(existing._id) };
}

// POST /api/admin/bootstrap-founder
// Requires header: x-owner-key === OWNER_BOOTSTRAP_KEY
// Body: { email, password, fullName }
router.post('/bootstrap-founder', requireOwnerBootstrapKey, async (req, res) => {
  try {
    if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
      return res.status(503).json({ ok: false, status: 503, code: 'DB_UNAVAILABLE', message: 'Database unavailable' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    const fullName = String(body.fullName || body.name || '').trim();

    if (!email || !password || !fullName) {
      return res.status(400).json({ ok: false, status: 400, code: 'MISSING_FIELDS', message: 'email, password, fullName required' });
    }

    if (!passwordPolicyOk(password)) {
      return res.status(400).json({ ok: false, status: 400, code: 'WEAK_PASSWORD', message: 'Password must be 8+ chars and include letters and numbers' });
    }

    const result = await upsertFounder({ email, password, fullName });
    return res.status(200).json({ ok: true, created: result.created, reset: result.reset, userId: result.userId });
  } catch (e) {
    console.error('[bootstrap-founder] failed', e?.message || e);
    return res.status(500).json({ ok: false, status: 500, message: 'Internal error' });
  }
});

// POST /api/admin/seed-founder
// Legacy convenience endpoint.
// - Production: requires x-owner-key === OWNER_BOOTSTRAP_KEY
// - Dev/local: allowed without key
router.post('/seed-founder', async (req, res, next) => {
  try {
    if (isProd()) {
      return requireOwnerBootstrapKey(req, res, next);
    }
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, status: 401, message: 'Unauthorized' });
  }
}, async (req, res) => {
  try {
    if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
      return res.status(503).json({ ok: false, status: 503, code: 'DB_UNAVAILABLE', message: 'Database unavailable' });
    }

    // In prod, extra safety: require owner key AND allow if no users exist (or explicit intent).
    if (isProd()) {
      const exists = await anyUsersExist();
      if (exists) {
        // Allowed (owner key already validated), but we keep semantics explicit: this is a reset.
      }
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = String(body.email || process.env.ADMIN_EMAIL || process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
    const password = String(body.password || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || process.env.FOUNDER_PASSWORD || '').trim();
    const fullName = String(body.fullName || body.name || process.env.FOUNDER_NAME || 'Founder').trim();

    if (!email || !password) {
      return res.status(400).json({ ok: false, status: 400, code: 'MISSING_FIELDS', message: 'email and password required (or set ADMIN_EMAIL/ADMIN_PASSWORD)' });
    }

    if (!passwordPolicyOk(password)) {
      return res.status(400).json({ ok: false, status: 400, code: 'WEAK_PASSWORD', message: 'Password must be 8+ chars and include letters and numbers' });
    }

    const result = await upsertFounder({ email, password, fullName });
    return res.status(200).json({ ok: true, created: result.created, reset: result.reset, userId: result.userId });
  } catch (e) {
    console.error('[seed-founder] failed', e?.message || e);
    return res.status(500).json({ ok: false, status: 500, message: 'Internal error' });
  }
});

module.exports = router;
