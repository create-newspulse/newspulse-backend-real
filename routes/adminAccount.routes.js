const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const SessionLog = require('../models/SessionLog');
const OtpToken = require('../models/OtpToken');
const { logAudit } = require('../lib/audit');
const { requireTeamAuth } = require('../lib/teamManagement');
const {
  isFounderRole,
  isProtectedFounderUser,
  normalizeRole,
  requirePasswordPolicy,
} = require('../lib/teamAccess');

const router = express.Router();
const FOUNDER_STAFF_ID = 'NP-FND-0001';
const FOUNDER_RECOVERY_EMAIL = 'newspulse.team@gmail.com';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function ensureDb(res) {
  if (isDbReady()) return true;
  bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
  return false;
}

function actorId(req) {
  return mongoose.isValidObjectId(String(req.user?.id || '')) ? req.user.id : null;
}

function isFounderUser(user) {
  return Boolean(user?.isFounder || isFounderRole(user?.role));
}

function legacyRecoveryEmail(user) {
  const candidates = [
    user?.recoveryEmail,
    user?.recovery_email,
    user?.backupEmail,
    typeof user?.recovery === 'string' ? user.recovery : null,
    user?.recovery?.email,
  ];
  return String(candidates.find((value) => String(value || '').trim()) || '').trim().toLowerCase();
}

function isPrimaryFounder(user) {
  return isFounderUser(user) && String(user?.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID;
}

async function ensureFounderRecoveryEmail(user) {
  if (!isPrimaryFounder(user)) return user;
  const currentRecoveryEmail = legacyRecoveryEmail(user);
  if (currentRecoveryEmail) return user;
  user.recoveryEmail = FOUNDER_RECOVERY_EMAIL;
  await user.save();
  return user;
}

async function loadCurrentUser(req, res) {
  if (!mongoose.isValidObjectId(String(req.user?.id || ''))) {
    bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    return null;
  }
  const user = await User.findById(String(req.user.id));
  if (!user) {
    bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    return null;
  }
  return user;
}

function accountStatus(user) {
  const status = String(user?.accountStatus || user?.status || 'active').toLowerCase();
  return ['active', 'suspended', 'locked', 'expired'].includes(status) ? status : 'active';
}

function sessionStatus(user) {
  return user?.onlineStatus || (user?.currentSessionId ? 'online' : 'offline');
}

function publicRole(user) {
  const role = normalizeRole(user?.role) || user?.role || 'staff';
  return isFounderUser(user) ? 'Founder' : role;
}

function founderAccountDto(user) {
  const fullName = user?.fullName || user?.name || 'Founder';
  const recoveryEmail = legacyRecoveryEmail(user) || (isPrimaryFounder(user) ? FOUNDER_RECOVERY_EMAIL : null);
  return {
    id: String(user._id),
    fullName,
    name: fullName,
    email: user.email,
    recoveryEmail,
    staffId: user.staffId || 'NP-FND-0001',
    role: 'Founder',
    isFounder: true,
    isProtected: true,
    fullAccess: Boolean(user.fullAccess || isFounderUser(user)),
    badges: ['Founder', 'Full Access', 'Protected'],
    accountStatus: accountStatus(user),
    sessionStatus: sessionStatus(user),
    lastLoginAt: user.lastLoginAt || null,
    lastPasswordChangedAt: user.lastPasswordChangedAt || null,
    mustChangePassword: Boolean(user.mustChangePassword || user.mustResetPassword || user.forceReset),
    twoFactorStatus: user.twoFactorStatus || 'not_configured',
  };
}

function staffAccountDto(user) {
  const fullName = user?.fullName || user?.name || '';
  return {
    id: String(user._id),
    fullName,
    name: fullName,
    email: user.email,
    staffId: user.staffId || null,
    role: publicRole(user),
    department: user.department || null,
    assignedSections: Array.isArray(user.assignedSections) ? user.assignedSections : [],
    coverageAreas: Array.isArray(user.coverageAreas) ? user.coverageAreas : [],
    designation: user.designation || null,
    accountStatus: accountStatus(user),
    sessionStatus: sessionStatus(user),
    lastLoginAt: user.lastLoginAt || null,
    lastPasswordChangedAt: user.lastPasswordChangedAt || null,
    accessExpiryDate: user.accessExpiresAt || null,
    accessExpiresAt: user.accessExpiresAt || null,
    mustChangePassword: Boolean(user.mustChangePassword || user.mustResetPassword || user.forceReset),
    isFounder: false,
    isProtected: Boolean(user.isProtected),
  };
}

function currentAccountDto(user) {
  return isFounderUser(user) ? founderAccountDto(user) : staffAccountDto(user);
}

function safeSessionDto(session) {
  return {
    id: String(session._id || session.id),
    loginAt: session.loginAt || null,
    logoutAt: session.logoutAt || null,
    lastSeenAt: session.lastSeenAt || null,
    ipAddress: session.ipAddress || null,
    userAgent: session.userAgent || null,
    device: session.device || null,
    status: session.status || 'active',
    logoutReason: session.logoutReason || null,
    current: false,
  };
}

async function endOwnSessions(user, reason, options = {}) {
  const now = options.now || new Date();
  const filter = { userId: user._id, status: 'active' };
  if (options.excludeCurrent && user.currentSessionId) filter._id = { $ne: user.currentSessionId };
  await SessionLog.updateMany(filter, {
    $set: {
      status: 'ended',
      logoutAt: now,
      lastSeenAt: now,
      logoutReason: reason,
    },
  });
  return now;
}

async function meHandler(req, res) {
  if (!ensureDb(res)) return;
  let user = await loadCurrentUser(req, res);
  if (!user) return;
  user = await ensureFounderRecoveryEmail(user);
  return ok(res, { user: currentAccountDto(user), data: { user: currentAccountDto(user) } });
}

async function founderMyAccountHandler(req, res) {
  if (!ensureDb(res)) return;
  let user = await loadCurrentUser(req, res);
  if (!user) return;

  if (!isFounderUser(user)) {
    await logAudit(req, 'FOUNDER_MY_ACCOUNT_ACCESS_BLOCKED', String(user._id), { reason: 'non_founder_attempt' });
    return bad(res, 403, 'Founder My Account is restricted to Founder', 'FOUNDER_ONLY');
  }

  user = await ensureFounderRecoveryEmail(user);
  await logAudit(req, 'USER_VIEWED_MY_ACCOUNT', String(user._id), { area: 'founder' });
  return ok(res, { user: founderAccountDto(user), data: { user: founderAccountDto(user) } });
}

async function staffMyAccountHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  if (isFounderUser(user)) {
    return bad(res, 403, 'Founder must use Founder My Account', 'STAFF_ACCOUNT_ONLY');
  }

  await logAudit(req, 'USER_VIEWED_MY_ACCOUNT', String(user._id), { area: 'staff' });
  return ok(res, { user: staffAccountDto(user), data: { user: staffAccountDto(user) } });
}

async function changePasswordHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const currentPassword = String(body.currentPassword || body.oldPassword || body.password || '');
  const newPassword = String(body.newPassword || body.newPass || '');
  const confirmPassword = String(body.confirmPassword || body.confirmNewPassword || '');

  if (!currentPassword || !newPassword || !confirmPassword) {
    await logAudit(req, 'USER_CHANGE_OWN_PASSWORD_FAILED', String(user._id), { reason: 'missing_fields' });
    return res.status(400).json({
      ok: false,
      success: false,
      status: 400,
      code: 'MISSING_FIELDS',
      message: 'currentPassword, newPassword and confirmPassword are required',
      receivedKeys: Object.keys(body),
    });
  }

  if (newPassword !== confirmPassword) {
    await logAudit(req, 'USER_CHANGE_OWN_PASSWORD_FAILED', String(user._id), { reason: 'password_mismatch' });
    return bad(res, 400, 'New password and confirm password must match', 'PASSWORD_MISMATCH');
  }

  const policy = requirePasswordPolicy(newPassword);
  if (!policy.ok) {
    await logAudit(req, 'USER_CHANGE_OWN_PASSWORD_FAILED', String(user._id), { reason: 'weak_password' });
    return bad(res, 400, policy.message, 'WEAK_PASSWORD');
  }

  if (!user.passwordHash) {
    await logAudit(req, 'USER_CHANGE_OWN_PASSWORD_FAILED', String(user._id), { reason: 'missing_password_hash' });
    return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  }

  const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!currentOk) {
    await logAudit(req, 'USER_CHANGE_OWN_PASSWORD_FAILED', String(user._id), { reason: 'invalid_current_password' });
    return bad(res, 401, 'Invalid current password', 'INVALID_CURRENT_PASSWORD');
  }

  const wasMustChangePassword = Boolean(user.mustChangePassword || user.mustResetPassword || user.forceReset);
  const now = new Date();
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  user.passwordHash = await bcrypt.hash(newPassword, rounds);
  user.mustChangePassword = false;
  user.mustResetPassword = false;
  user.forceReset = false;
  user.tempPasswordExpiresAt = null;
  user.lastPasswordChangedAt = now;
  user.sessionsRevokedAt = now;
  if (user.status === 'pending' || user.status === 'expired') user.status = 'active';
  if (user.accountStatus === 'expired') user.accountStatus = 'active';
  user.updatedBy = actorId(req);
  user.updatedAt = now;
  user.tokenVersion = (typeof user.tokenVersion === 'number' ? user.tokenVersion : 0) + 1;
  await endOwnSessions(user, 'own_password_changed', { now, excludeCurrent: true });
  await OtpToken.updateMany(
    { email: user.email, used: false },
    { $set: { used: true, status: 'replaced', replacedAt: now, resetToken: null, resetTokenExpiresAt: now } },
  );
  await user.save();

  await logAudit(req, 'PASSWORD_CHANGED', String(user._id), { revokedOtherSessions: true });
  await logAudit(req, 'USER_CHANGED_OWN_PASSWORD', String(user._id), { revokedOtherSessions: true });
  if (wasMustChangePassword) {
    await logAudit(req, 'MUST_CHANGE_PASSWORD_COMPLETED', String(user._id), null);
  }

  return ok(res, { message: 'Password updated successfully' });
}

async function sessionsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  const docs = await SessionLog.find({ userId: user._id }).sort({ loginAt: -1 }).limit(50).lean();
  const currentSessionId = user.currentSessionId ? String(user.currentSessionId) : null;
  const sessions = (docs || []).map((session) => ({
    ...safeSessionDto(session),
    current: currentSessionId ? String(session._id || session.id) === currentSessionId : false,
  }));
  return ok(res, { sessions, data: { sessions } });
}

async function logoutAllMyDevicesHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  const now = await endOwnSessions(user, 'logout_all_my_devices', { now: new Date(), excludeCurrent: false });
  user.tokenVersion = (typeof user.tokenVersion === 'number' ? user.tokenVersion : 0) + 1;
  user.sessionsRevokedAt = now;
  user.lastLogoutAt = now;
  user.onlineStatus = 'offline';
  user.currentSessionId = null;
  user.updatedBy = actorId(req);
  user.updatedAt = now;
  await user.save();

  await logAudit(req, 'USER_LOGOUT_ALL_OWN_DEVICES', String(user._id), null);
  return ok(res, { message: 'All devices logged out.', tokenVersion: user.tokenVersion });
}

async function profileHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  if (isProtectedFounderUser(user)) {
    return bad(res, 403, 'Founder protected fields cannot be edited here', 'FOUNDER_PROTECTED');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = { updatedBy: actorId(req), updatedAt: new Date() };
  const editableFields = [];

  if (body.fullName !== undefined || body.name !== undefined) {
    const fullName = String(body.fullName || body.name || '').trim();
    if (!fullName) return bad(res, 400, 'fullName is required', 'MISSING_FULL_NAME');
    patch.fullName = fullName;
    patch.name = fullName;
    editableFields.push('fullName');
  }

  if (body.designation !== undefined) {
    patch.designation = body.designation != null ? String(body.designation || '').trim() : null;
    editableFields.push('designation');
  }

  if (!editableFields.length) return bad(res, 400, 'No editable profile fields supplied', 'NO_PROFILE_CHANGES');

  const blockedFields = ['email', 'staffId', 'role', 'roleId', 'roleName', 'department', 'assignedSections', 'coverageAreas', 'sections', 'accountStatus', 'status', 'permissions', 'moduleAccessOverride', 'specialRightsOverride', 'isFounder', 'isProtected'];
  const attemptedBlockedFields = blockedFields.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (attemptedBlockedFields.length) {
    await logAudit(req, 'USER_PROFILE_UPDATE_BLOCKED', String(user._id), { attemptedFields: attemptedBlockedFields });
    return bad(res, 400, 'Protected account fields cannot be changed from My Account', 'PROTECTED_FIELDS');
  }

  const updated = await User.findByIdAndUpdate(user._id, { $set: patch }, { new: true });
  await logAudit(req, 'USER_UPDATED_OWN_PROFILE', String(user._id), { fields: editableFields });
  return ok(res, { user: currentAccountDto(updated), data: { user: currentAccountDto(updated) } });
}

router.get('/account/me', requireTeamAuth, meHandler);
router.get('/founder/my-account', requireTeamAuth, founderMyAccountHandler);
router.get('/my-account', requireTeamAuth, staffMyAccountHandler);
router.post('/account/change-password', requireTeamAuth, changePasswordHandler);
router.get('/account/sessions', requireTeamAuth, sessionsHandler);
router.post('/account/logout-all-my-devices', requireTeamAuth, logoutAllMyDevicesHandler);
router.patch('/account/profile', requireTeamAuth, profileHandler);

module.exports = router;
