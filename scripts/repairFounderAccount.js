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
const FOUNDER_NAME = 'Kiran Parmar';

const KNOWN_FOUNDER_EMAILS = Object.freeze([
  TARGET_EMAIL,
  RECOVERY_EMAIL,
  process.env.FOUNDER_EMAIL,
  process.env.ADMIN_EMAIL,
  process.env.FOUNDER_ALT_EMAIL,
  process.env.ADMIN_ALT_EMAIL,
  'founder@example.com',
  'admin@newspulse.ai',
  'admin@newspulse.co.in',
  'founder@newspulse.ai',
  'founder@newspulse.co.in',
].map(normalizeEmail).filter(Boolean));

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function roleValue(user) {
  return String(user?.role || user?.roleName || '').trim().toLowerCase();
}

function isFounderLike(user) {
  if (!user) return false;
  const email = normalizeEmail(user.email);
  return Boolean(
    user.isFounder === true
      || user.isOwner === true
      || user.isProtected === true
      || roleValue(user) === 'founder'
      || String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID
      || KNOWN_FOUNDER_EMAILS.includes(email),
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
  const query = {
    $or: [
      { isFounder: true },
      { isOwner: true },
      { isProtected: true },
      { role: /^founder$/i },
      { roleName: /^founder$/i },
      { staffId: FOUNDER_STAFF_ID },
      { email: { $in: KNOWN_FOUNDER_EMAILS } },
    ],
  };
  const candidates = await User.find(query).sort({ createdAt: 1 });
  return uniqueUsers(candidates).filter(isFounderLike);
}

function choosePrimaryFounder(candidates) {
  const withFounderStaffId = candidates.find((user) => String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID);
  if (withFounderStaffId) return withFounderStaffId;
  const protectedFounder = candidates.find((user) => user.isFounder === true && user.isProtected === true);
  if (protectedFounder) return protectedFounder;
  const founderFlag = candidates.find((user) => user.isFounder === true);
  if (founderFlag) return founderFlag;
  return candidates[0] || null;
}

async function ensureNoNonFounderDuplicate(primaryFounderId) {
  const duplicate = await User.findOne({ email: TARGET_EMAIL });
  if (!duplicate) return;
  if (String(duplicate._id) === String(primaryFounderId)) return;
  if (isFounderLike(duplicate)) {
    throw new Error('kiran@newspulse.co.in already exists on a different Founder-like account. Resolve duplicate Founder accounts before repairing the primary Founder.');
  }
  throw new Error('kiran@newspulse.co.in already exists on a non-Founder account. Resolve duplicate before repairing Founder.');
}

async function revokeFounderSecurityState(founderId, emails, now) {
  await SessionLog.updateMany(
    { userId: founderId, status: 'active' },
    {
      $set: {
        status: 'ended',
        logoutAt: now,
        lastSeenAt: now,
        logoutReason: 'founder_account_repaired',
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
      actor: { id: 'system:repairFounderAccount', email: null, role: 'system' },
      meta: {
        targetEmail: TARGET_EMAIL,
        staffId: FOUNDER_STAFF_ID,
        timestamp: new Date().toISOString(),
        details,
      },
    });
  } catch (error) {
    console.warn('[repair:founder] Audit log skipped:', error?.message || error);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('Missing MONGODB_URI (or legacy MONGO_URI). Aborting Founder repair.');
  }

  await mongoose.connect(uri);

  const candidates = await findFounderCandidates();
  if (!candidates.length) {
    throw new Error('No existing Founder-like protected account found. Refusing to create Founder from repair script.');
  }

  const primaryFounder = choosePrimaryFounder(candidates);
  await ensureNoNonFounderDuplicate(primaryFounder._id);

  const duplicateFounderLike = candidates.filter((user) => String(user._id) !== String(primaryFounder._id));
  if (duplicateFounderLike.length) {
    console.warn('[repair:founder] Warning: duplicate Founder-like accounts detected. Keeping NP-FND-0001 primary when present. No duplicates were deleted.');
    for (const user of duplicateFounderLike) {
      console.warn('[repair:founder] Duplicate candidate:', {
        id: String(user._id),
        email: normalizeEmail(user.email),
        staffId: user.staffId || null,
        role: user.role || null,
        isFounder: Boolean(user.isFounder),
        isProtected: Boolean(user.isProtected),
      });
    }
  }

  const now = new Date();
  const previousEmail = normalizeEmail(primaryFounder.email);
  const tempPassword = String(process.env.FOUNDER_TEMP_PASSWORD || '');
  const passwordReset = Boolean(tempPassword);
  const update = {
    email: TARGET_EMAIL,
    recoveryEmail: RECOVERY_EMAIL,
    fullName: FOUNDER_NAME,
    name: FOUNDER_NAME,
    staffId: FOUNDER_STAFF_ID,
    staffIdLocked: true,
    role: 'founder',
    roleName: 'Founder',
    roleId: null,
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

  if (!primaryFounder.staffIdGeneratedAt) update.staffIdGeneratedAt = primaryFounder.createdAt || now;

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
    primaryFounder._id,
    { $set: update, ...(passwordReset ? { $inc: { tokenVersion: 1 } } : {}) },
    { new: true },
  );

  if (!updatedFounder) throw new Error('Founder account disappeared during repair.');

  if (passwordReset) await revokeFounderSecurityState(updatedFounder._id, [previousEmail, TARGET_EMAIL], now);

  await writeAudit(updatedFounder, {
    previousEmail: previousEmail || null,
    emailUpdated: previousEmail !== TARGET_EMAIL,
    protectionEnsured: true,
    passwordReset,
    duplicateFounderLikeCount: duplicateFounderLike.length,
  });

  console.log('[repair:founder] Founder account repaired.');
  console.log('[repair:founder] Founder email:', updatedFounder.email);
  console.log('[repair:founder] Staff ID:', updatedFounder.staffId);
  console.log('[repair:founder] Role:', updatedFounder.roleName || 'Founder');
  console.log('[repair:founder] Protected:', Boolean(updatedFounder.isProtected));
  console.log('[repair:founder] Owner:', Boolean(updatedFounder.isOwner));
  console.log('[repair:founder] Full access:', Boolean(updatedFounder.fullAccess));
  console.log('[repair:founder] Password reset:', passwordReset ? 'yes' : 'no');
  console.log('[repair:founder] PowerShell usage: $env:FOUNDER_TEMP_PASSWORD="temporaryStrongPasswordHere"; npm run repair:founder');
}

main()
  .catch((error) => {
    console.error('[repair:founder] Failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
