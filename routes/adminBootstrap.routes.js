const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const { FOUNDER_STAFF_ID } = require('../lib/staffId');
const {
  getLocalFounderSafeDiagnostics,
  isLocalDevLike,
  isProductionLike,
  resolveLocalFounderSeedConfig,
} = require('../lib/localFounderAuth');

const router = express.Router();

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

async function ensureFounder({ email, password, fullName }) {
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  const existing = await User.findOne({ email });
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, rounds);
    const created = await User.create({
      email,
      name: fullName,
      passwordHash,
      staffId: FOUNDER_STAFF_ID,
      staffIdGeneratedAt: new Date(),
      staffIdLocked: true,
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
    return { created: true, reset: false, updated: false, userId: String(created._id), action: 'created' };
  }

  const passwordMatches = existing.passwordHash
    ? await bcrypt.compare(password, existing.passwordHash).catch(() => false)
    : false;

  const nextName = fullName || existing.name || 'Founder';
  const nextPermissions = new Set(Array.isArray(existing.permissions) ? existing.permissions : []);
  nextPermissions.add('team.manage');
  nextPermissions.add('audit.read');
  nextPermissions.add('settings.read');

  const needsMetadataUpdate = existing.name !== nextName
    || existing.role !== 'founder'
    || existing.status !== 'active'
    || existing.mustChangePassword !== false
    || existing.mustResetPassword !== false
    || existing.forceReset !== false;

  const hasAllPermissions = Array.isArray(existing.permissions)
    && existing.permissions.includes('team.manage')
    && existing.permissions.includes('audit.read')
    && existing.permissions.includes('settings.read');

  const needsUpdate = !passwordMatches || needsMetadataUpdate || !hasAllPermissions;
  if (!needsUpdate) {
    return { created: false, reset: false, updated: false, userId: String(existing._id), action: 'existing' };
  }

  existing.name = nextName;
  existing.role = 'founder';
  if (!existing.staffId) existing.staffId = FOUNDER_STAFF_ID;
  existing.staffIdLocked = true;
  if (!existing.staffIdGeneratedAt) existing.staffIdGeneratedAt = existing.createdAt || new Date();
  existing.status = 'active';
  existing.mustChangePassword = false;
  existing.mustResetPassword = false;
  existing.forceReset = false;
  existing.permissions = Array.from(nextPermissions);

  if (!passwordMatches) {
    existing.passwordHash = await bcrypt.hash(password, rounds);
    existing.tokenVersion = (typeof existing.tokenVersion === 'number' ? existing.tokenVersion : 0) + 1;
  }


  await existing.save();
  return {
    created: false,
    reset: !passwordMatches,
    updated: true,
    userId: String(existing._id),
    action: passwordMatches ? 'updated' : 'reset',
  };
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

    const result = await ensureFounder({ email, password, fullName });
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
    if (isProductionLike()) {
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
    if (isProductionLike()) {
      const exists = await anyUsersExist();
      if (exists) {
        // Allowed (owner key already validated), but we keep semantics explicit: this is a reset.
      }
    }

    const config = resolveLocalFounderSeedConfig(req.body);
    const email = config.email;
    const password = config.password;
    const fullName = config.fullName;

    if (!email || !password) {
      return res.status(400).json({ ok: false, status: 400, code: 'MISSING_FIELDS', message: 'email and password required (or set ADMIN_SEED_FOUNDER_EMAIL/ADMIN_SEED_FOUNDER_PASSWORD)' });
    }

    if (!passwordPolicyOk(password)) {
      return res.status(400).json({ ok: false, status: 400, code: 'WEAK_PASSWORD', message: 'Password must be 8+ chars and include letters and numbers' });
    }

    const result = await ensureFounder({ email, password, fullName });
    const localDev = isLocalDevLike();
    const diagnostics = getLocalFounderSafeDiagnostics(req.body);
    const dbName = mongoose.connection && mongoose.connection.name ? String(mongoose.connection.name) : null;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      code: result.created
        ? 'FOUNDER_SEEDED'
        : result.action === 'existing'
          ? 'FOUNDER_ALREADY_EXISTS'
          : 'FOUNDER_UPDATED',
      message: result.created
        ? 'Founder account seeded.'
        : result.action === 'existing'
          ? 'Founder account already exists and is ready for local login.'
          : result.reset
            ? 'Founder account exists; local credentials were refreshed.'
            : 'Founder account exists; founder metadata was refreshed.',
      created: result.created,
      reset: result.reset,
      updated: result.updated,
      userId: result.userId,
      founder: {
        email,
        fullName,
        role: 'founder',
      },
      ...(dbName ? { dbName } : {}),
      ...(localDev ? { localDev: diagnostics } : {}),
    });
  } catch (e) {
    console.error('[seed-founder] failed', e?.message || e);
    return res.status(500).json({ ok: false, status: 500, message: 'Internal error' });
  }
});

module.exports = router;
