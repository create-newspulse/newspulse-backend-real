const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const SessionLog = require('../models/SessionLog');
const OtpToken = require('../models/OtpToken');
const {
  ADMIN_MODULE_KEYS,
  FOUNDER_PERMISSIONS,
  SPECIAL_RIGHT_KEYS,
} = require('../lib/teamAccess');

const PRIMARY_EMAIL = 'kiran@newspulse.co.in';
const RECOVERY_EMAIL = 'newspulse.team@gmail.com';
const FOUNDER_STAFF_ID = 'NP-FND-0001';
const DISABLE_NOTE = 'Legacy duplicate disabled after migration to kiran@newspulse.co.in';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function roleValue(user) {
  return String(user?.role || user?.roleName || '').trim().toLowerCase();
}

function isFounderLike(user) {
  if (!user) return false;
  return Boolean(
    user.isFounder === true
      || user.isOwner === true
      || user.isProtected === true
      || roleValue(user) === 'founder'
      || roleValue(user) === 'admin'
      || String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID
      || [PRIMARY_EMAIL, RECOVERY_EMAIL, 'admin@newspulse.ai', 'founder@example.com'].includes(normalizeEmail(user.email)),
  );
}

function uniqueUsers(users) {
  const seen = new Set();
  const out = [];
  for (const user of users || []) {
    const id = String(user?._id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(user);
  }
  return out;
}

async function findPrimaryFounder() {
  return User.findOne({ staffId: FOUNDER_STAFF_ID })
    || User.findOne({ email: PRIMARY_EMAIL, isFounder: true })
    || User.findOne({ email: PRIMARY_EMAIL, role: /^founder$/i });
}

async function findDuplicateCandidates(primaryId) {
  const candidates = await User.find({
    $or: [
      { email: RECOVERY_EMAIL },
      { email: 'admin@newspulse.ai' },
      { email: 'founder@example.com' },
      { role: /^founder$/i },
      { roleName: /^founder$/i },
      { isFounder: true },
      { isOwner: true },
      { isProtected: true },
    ],
  }).sort({ createdAt: 1 });
  return uniqueUsers(candidates).filter((user) => String(user._id) !== String(primaryId) && isFounderLike(user));
}

async function revokeSessionsAndTokens(userIds, emails, now) {
  if (userIds.length) {
    await SessionLog.updateMany(
      { userId: { $in: userIds }, status: 'active' },
      { $set: { status: 'ended', logoutAt: now, lastSeenAt: now, logoutReason: 'founder_duplicate_login_disabled' } },
    );
  }

  const resetEmails = Array.from(new Set((emails || []).map(normalizeEmail).filter(Boolean)));
  if (resetEmails.length) {
    await OtpToken.updateMany(
      { email: { $in: resetEmails }, used: false },
      { $set: { used: true, status: 'replaced', replacedAt: now, resetToken: null, resetTokenExpiresAt: now } },
    );
  }
}

async function auditCleanup(primaryFounder, disabledEmails) {
  try {
    await AuditLog.create({
      action: 'FOUNDER_DUPLICATE_LOGIN_DISABLED',
      key: `user:${String(primaryFounder._id)}`,
      actor: { id: 'system:cleanupFounderDuplicates', email: null, role: 'system' },
      meta: {
        primaryEmail: PRIMARY_EMAIL,
        recoveryEmail: RECOVERY_EMAIL,
        disabledOldLogin: RECOVERY_EMAIL,
        disabledEmails,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.warn('[cleanup:founder-duplicates] Audit log skipped:', error?.message || error);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('Missing MONGODB_URI (or legacy MONGO_URI). Aborting Founder duplicate cleanup.');
  }

  await mongoose.connect(uri);

  const now = new Date();
  const primaryFounder = await findPrimaryFounder();
  if (!primaryFounder) throw new Error('Primary Founder NP-FND-0001 was not found. Run repair:founder-email first.');

  const primaryUpdate = {
    email: PRIMARY_EMAIL,
    recoveryEmail: RECOVERY_EMAIL,
    staffId: FOUNDER_STAFF_ID,
    staffIdLocked: true,
    role: 'founder',
    roleName: 'Founder',
    isFounder: true,
    isOwner: true,
    isProtected: true,
    fullAccess: true,
    canBeDeleted: false,
    canBeSuspended: false,
    canBeDemoted: false,
    accountStatus: 'active',
    status: 'active',
    loginAllowed: true,
    accountNote: null,
    moduleAccessOverride: ADMIN_MODULE_KEYS.slice(),
    specialRightsOverride: SPECIAL_RIGHT_KEYS.slice(),
    permissions: FOUNDER_PERMISSIONS.slice(),
    updatedAt: now,
    sessionsRevokedAt: now,
  };
  if (!primaryFounder.staffIdGeneratedAt) primaryUpdate.staffIdGeneratedAt = primaryFounder.createdAt || now;

  const updatedPrimary = await User.findByIdAndUpdate(
    primaryFounder._id,
    { $set: primaryUpdate, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  const duplicates = await findDuplicateCandidates(updatedPrimary._id);
  const disabledEmails = [];
  const duplicateIds = [];
  for (const duplicate of duplicates) {
    disabledEmails.push(normalizeEmail(duplicate.email));
    duplicateIds.push(duplicate._id);
    await User.findByIdAndUpdate(duplicate._id, {
      $set: {
        status: 'suspended',
        accountStatus: 'suspended',
        loginAllowed: false,
        isFounder: false,
        isOwner: false,
        isProtected: false,
        fullAccess: false,
        canBeDeleted: false,
        canBeSuspended: false,
        canBeDemoted: false,
        role: 'legacy_duplicate',
        roleName: 'Legacy Duplicate',
        permissions: [],
        moduleAccessOverride: [],
        specialRightsOverride: [],
        accountNote: DISABLE_NOTE,
        currentSessionId: null,
        onlineStatus: 'offline',
        sessionsRevokedAt: now,
        resetTokensRevokedAt: now,
        updatedAt: now,
      },
      $inc: { tokenVersion: 1 },
    });
  }

  await revokeSessionsAndTokens([updatedPrimary._id, ...duplicateIds], [PRIMARY_EMAIL, RECOVERY_EMAIL, ...disabledEmails], now);
  await auditCleanup(updatedPrimary, disabledEmails);

  console.log('[cleanup:founder-duplicates] Primary Founder email:', updatedPrimary.email);
  console.log('[cleanup:founder-duplicates] Recovery email:', updatedPrimary.recoveryEmail);
  console.log('[cleanup:founder-duplicates] Staff ID:', updatedPrimary.staffId);
  console.log('[cleanup:founder-duplicates] Founder protection:', Boolean(updatedPrimary.isFounder && updatedPrimary.isProtected && updatedPrimary.fullAccess));
  console.log('[cleanup:founder-duplicates] Disabled duplicate login count:', duplicates.length);
  console.log('[cleanup:founder-duplicates] Disabled old login:', disabledEmails.includes(RECOVERY_EMAIL) ? RECOVERY_EMAIL : 'none found');
  console.log('[cleanup:founder-duplicates] No accounts deleted. Logout/login is required.');
}

main()
  .catch((error) => {
    console.error('[cleanup:founder-duplicates] Failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
