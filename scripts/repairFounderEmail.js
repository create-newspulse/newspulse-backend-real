const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

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

const TARGET_EMAIL = 'kiran@newspulse.co.in';
const RECOVERY_EMAIL = 'newspulse.team@gmail.com';
const FOUNDER_STAFF_ID = 'NP-FND-0001';

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
      || roleValue(user) === 'founder'
      || String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID
      || normalizeEmail(user.email) === RECOVERY_EMAIL
      || normalizeEmail(user.email) === TARGET_EMAIL,
  );
}

function uniqueUsers(users) {
  const out = [];
  const seen = new Set();
  for (const user of users || []) {
    const id = String(user?._id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(user);
  }
  return out;
}

async function findFounderCandidates() {
  const candidates = await User.find({
    $or: [
      { staffId: FOUNDER_STAFF_ID },
      { role: /^founder$/i },
      { roleName: /^founder$/i },
      { isFounder: true },
      { email: RECOVERY_EMAIL },
      { email: TARGET_EMAIL },
    ],
  }).sort({ createdAt: 1 });
  return uniqueUsers(candidates).filter(isFounderLike);
}

function chooseFounder(candidates) {
  return candidates.find((user) => String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID)
    || candidates.find((user) => user.isFounder === true && user.isProtected === true)
    || candidates.find((user) => user.isFounder === true)
    || candidates.find((user) => normalizeEmail(user.email) === RECOVERY_EMAIL)
    || candidates[0]
    || null;
}

async function ensureNoDuplicateEmail(primaryFounderId) {
  const duplicate = await User.findOne({ email: TARGET_EMAIL });
  if (!duplicate) return;
  if (String(duplicate._id) === String(primaryFounderId)) return;
  if (!isFounderLike(duplicate)) {
    throw new Error('kiran@newspulse.co.in already exists on a non-Founder account. Resolve duplicate before repairing Founder.');
  }
  throw new Error('kiran@newspulse.co.in already exists on a different Founder-like account. Resolve duplicate Founder accounts before repairing Founder email.');
}

async function revokeSecurityState(founderId, emails, now) {
  await SessionLog.updateMany(
    { userId: founderId, status: 'active' },
    {
      $set: {
        status: 'ended',
        logoutAt: now,
        lastSeenAt: now,
        logoutReason: 'founder_email_repaired',
      },
    },
  );

  const resetEmails = Array.from(new Set((emails || []).map(normalizeEmail).filter(Boolean)));
  if (!resetEmails.length) return;
  await OtpToken.updateMany(
    { email: { $in: resetEmails }, used: false },
    {
      $set: {
        used: true,
        status: 'replaced',
        replacedAt: now,
        resetToken: null,
        resetTokenExpiresAt: now,
      },
    },
  );
}

async function writeAudit(founder, details) {
  try {
    await AuditLog.create({
      action: 'FOUNDER_ACCOUNT_REPAIRED',
      key: `user:${String(founder._id)}`,
      actor: { id: 'system:repairFounderEmail', email: null, role: 'system' },
      meta: {
        targetEmail: TARGET_EMAIL,
        staffId: FOUNDER_STAFF_ID,
        timestamp: new Date().toISOString(),
        details,
      },
    });
  } catch (error) {
    console.warn('[repair:founder-email] Audit log skipped:', error?.message || error);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('Missing MONGODB_URI (or legacy MONGO_URI). Aborting Founder email repair.');
  }

  await mongoose.connect(uri);

  const candidates = await findFounderCandidates();
  if (!candidates.length) {
    throw new Error('No existing Founder account found. Refusing to create a new staff or Founder account.');
  }

  const founder = chooseFounder(candidates);
  await ensureNoDuplicateEmail(founder._id);

  const duplicateFounderLike = candidates.filter((user) => String(user._id) !== String(founder._id));
  if (duplicateFounderLike.length) {
    console.warn('[repair:founder-email] Warning: duplicate Founder-like accounts detected. No duplicate accounts were deleted.');
  }

  const now = new Date();
  const previousEmail = normalizeEmail(founder.email);
  const tempPassword = String(process.env.FOUNDER_TEMP_PASSWORD || '');
  const passwordReset = Boolean(tempPassword);
  const update = {
    email: TARGET_EMAIL,
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
    moduleAccessOverride: ADMIN_MODULE_KEYS.slice(),
    specialRightsOverride: SPECIAL_RIGHT_KEYS.slice(),
    permissions: FOUNDER_PERMISSIONS.slice(),
    updatedAt: now,
  };

  if (!founder.staffIdGeneratedAt) update.staffIdGeneratedAt = founder.createdAt || now;

  if (passwordReset) {
    const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
    update.passwordHash = await bcrypt.hash(tempPassword, rounds);
    update.mustChangePassword = true;
    update.mustResetPassword = true;
    update.forceReset = true;
    update.tempPasswordExpiresAt = null;
    update.lastPasswordChangedAt = now;
    update.sessionsRevokedAt = now;
    update.resetTokensRevokedAt = now;
  }

  const updatedFounder = await User.findByIdAndUpdate(
    founder._id,
    { $set: update, ...(passwordReset ? { $inc: { tokenVersion: 1 } } : {}) },
    { new: true },
  );

  if (!updatedFounder) throw new Error('Founder account disappeared during email repair.');

  if (passwordReset) await revokeSecurityState(updatedFounder._id, [previousEmail, TARGET_EMAIL], now);

  await writeAudit(updatedFounder, {
    previousEmail: previousEmail || null,
    emailUpdated: previousEmail !== TARGET_EMAIL,
    recoveryEmail: RECOVERY_EMAIL,
    protectionEnsured: true,
    passwordReset,
    duplicateFounderLikeCount: duplicateFounderLike.length,
  });

  console.log('Founder email updated to kiran@newspulse.co.in');
  console.log('Recovery email set to newspulse.team@gmail.com');
  console.log('Staff ID confirmed NP-FND-0001');
  console.log('Founder protection confirmed');
  console.log('Password reset:', passwordReset ? 'yes' : 'no');
  console.log('Logout/login required for tokens or Admin Panel storage that still reference the old email.');
}

main()
  .catch((error) => {
    console.error('[repair:founder-email] Failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
