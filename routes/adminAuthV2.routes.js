const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ensureDbOr503(res) {
  if (!isDbReady()) {
    res.status(503).json({ ok: false, success: false, status: 503, message: 'Database unavailable' });
    return false;
  }
  return true;
}

function validateNewPassword(pw) {
  const v = String(pw || '');
  if (v.length < 8) return { ok: false, message: 'Password must be at least 8 characters' };
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return { ok: false, message: 'Password must contain letters and numbers' };
  return { ok: true };
}

function randomTempPassword() {
  // 12+ chars, base64url removes +/=
  return crypto.randomBytes(18).toString('base64url');
}

// POST /api/admin/auth/logout-all
// Founder-only: increments tokenVersion for current user or target userId
router.post('/auth/logout-all', requireAuth, requireFounder, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetUserId = body.userId ? String(body.userId) : String(req.user.id);

  if (!mongoose.isValidObjectId(targetUserId)) {
    return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid userId' });
  }

  const updated = await User.findByIdAndUpdate(
    targetUserId,
    { $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return res.status(404).json({ ok: false, success: false, status: 404, message: 'User not found' });

  await logAudit(req, 'SECURITY_LOGOUT_ALL', targetUserId, { by: String(req.user.id) });

  return res.status(200).json({ ok: true, success: true, status: 200, userId: String(updated._id), tokenVersion: updated.tokenVersion });
});

// POST /api/admin/auth/change-password
// Any authenticated user can change their password.
router.post('/auth/change-password', requireAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, success: false, status: 400, message: 'currentPassword and newPassword are required' });
  }

  const policy = validateNewPassword(newPassword);
  if (!policy.ok) {
    return res.status(400).json({ ok: false, success: false, status: 400, message: policy.message });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ ok: false, success: false, status: 401, message: 'Unauthorized' });

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ ok: false, success: false, status: 401, message: 'Invalid credentials' });
  }

  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  user.passwordHash = await bcrypt.hash(newPassword, rounds);
  user.mustChangePassword = false;
  user.forceReset = false;
  user.updatedBy = mongoose.isValidObjectId(req.user.id) ? req.user.id : null;
  await user.save();

  await logAudit(req, 'AUTH_CHANGE_PASSWORD', String(user._id), null);

  return res.status(200).json({ ok: true, success: true, status: 200 });
});

// Helper endpoint (founder-only) for generating a temp password for manual onboarding.
// Not advertised, but used by force-reset + create-user.
router.post('/auth/_temp-password', requireAuth, requireFounder, (_req, res) => {
  return res.status(200).json({ ok: true, tempPassword: randomTempPassword() });
});

module.exports = router;
