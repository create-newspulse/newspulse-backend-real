const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const User = require('../models/User');
const News = require('../models/News');
const FinanceRecord = require('../models/FinanceRecord');
const ComplianceReport = require('../models/ComplianceReport');
const AuditLog = require('../models/AuditLog');
const SessionLog = require('../models/SessionLog');
const { FOUNDER_STAFF_ID } = require('../lib/staffId');

const CLEANUP_REASON = 'test_or_duplicate_cleanup';
const CLEANUP_ACTOR = 'system_cleanup';

const TARGETS = Object.freeze([
  {
    label: 'Test Editor',
    names: ['test editor'],
    emails: ['krn85397@gmail.com'],
  },
  {
    label: 'abcd',
    names: ['abcd'],
    emails: ['abcd@123gmai.com'],
  },
  {
    label: 'Unnamed staff duplicate disabled account',
    names: ['unnamed staff'],
    emails: [],
    missingEmailWithLogoutReason: 'founder_duplicate_login_disabled',
  },
]);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function displayName(user) {
  return String(user?.fullName || user?.name || '').trim();
}

function emailOf(user) {
  return normalize(user?.email);
}

function roleValue(user) {
  return normalize(user?.role || user?.roleName);
}

function isMissingEmail(user) {
  const email = String(user?.email || '').trim();
  return !email || email === '-';
}

function isFounderOrProtected(user) {
  return Boolean(
    user?.isFounder === true
      || user?.isOwner === true
      || user?.isProtected === true
      || roleValue(user) === 'founder'
      || String(user?.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID,
  );
}

function targetMatchesUser(target, user, duplicateSessionUserIds) {
  const name = normalize(displayName(user));
  const email = emailOf(user);
  if (target.names.includes(name)) return true;
  if (target.emails.includes(email)) return true;
  if (target.missingEmailWithLogoutReason && isMissingEmail(user)) {
    return duplicateSessionUserIds.has(String(user._id));
  }
  return false;
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

async function getDuplicateSessionUserIds() {
  const docs = await SessionLog.find({ logoutReason: 'founder_duplicate_login_disabled' }).select('userId').lean();
  return new Set((docs || []).map((doc) => String(doc.userId || '')).filter(Boolean));
}

async function findTargetAccounts() {
  const duplicateSessionUserIds = await getDuplicateSessionUserIds();
  const emails = TARGETS.flatMap((target) => target.emails);
  const nameRegexes = TARGETS.flatMap((target) => target.names.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')));
  const or = [
    ...emails.map((email) => ({ email })),
    ...nameRegexes.flatMap((regex) => [{ name: regex }, { fullName: regex }]),
  ];
  if (duplicateSessionUserIds.size) {
    or.push({ _id: { $in: Array.from(duplicateSessionUserIds).filter((id) => mongoose.isValidObjectId(id)) } });
  }
  if (!or.length) return [];
  const candidates = await User.find({ $or: or }).sort({ createdAt: 1 });
  return uniqueUsers(candidates).filter((user) => TARGETS.some((target) => targetMatchesUser(target, user, duplicateSessionUserIds)));
}

async function hasPublishedNews(user) {
  const count = await News.countDocuments({
    status: 'published',
    $or: [
      { 'workflowHistory.byUserId': user._id },
      { 'internalComments.byUserId': user._id },
    ],
  });
  return count > 0;
}

async function hasFinanceRecords(user) {
  const count = await FinanceRecord.countDocuments({ $or: [{ createdBy: user._id }, { updatedBy: user._id }] });
  return count > 0;
}

async function hasImportantComplianceRecords(user) {
  const email = emailOf(user);
  const id = String(user._id);
  const createdOrUpdatedBy = [id, email, displayName(user)].filter(Boolean);
  const complianceCount = await ComplianceReport.countDocuments({
    $or: [
      { createdBy: { $in: createdOrUpdatedBy } },
      { updatedBy: { $in: createdOrUpdatedBy } },
    ],
  });
  if (complianceCount > 0) return true;

  const auditCount = await AuditLog.countDocuments({
    key: `user:${id}`,
    action: { $regex: /COMPLIANCE/i },
  });
  return auditCount > 0;
}

async function safetyBlockers(user) {
  const blockers = [];
  if (isFounderOrProtected(user)) blockers.push('Founder/protected account');
  if (await hasPublishedNews(user)) blockers.push('published news exists');
  if (await hasFinanceRecords(user)) blockers.push('finance/payment records exist');
  if (await hasImportantComplianceRecords(user)) blockers.push('important compliance records exist');
  return blockers;
}

async function archiveAccount(user, now) {
  await SessionLog.updateMany(
    { userId: user._id, status: 'active' },
    { $set: { status: 'ended', logoutAt: now, lastSeenAt: now, logoutReason: CLEANUP_REASON } },
  );

  const updated = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        status: 'archived',
        accountStatus: 'archived',
        isArchived: true,
        archivedAt: now,
        archivedBy: null,
        isDeleted: true,
        deletedAt: now,
        deletedBy: null,
        deleteReason: CLEANUP_REASON,
        isTestAccount: true,
        testAccountReason: CLEANUP_REASON,
        testAccountMarkedAt: now,
        testAccountMarkedBy: null,
        loginAllowed: false,
        currentSessionId: null,
        onlineStatus: 'offline',
        lastLogoutAt: now,
        sessionsRevokedAt: now,
        updatedAt: now,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );

  await AuditLog.create({
    action: 'TEST_STAFF_ACCOUNT_CLEANUP',
    key: `user:${String(user._id)}`,
    actor: { id: CLEANUP_ACTOR, email: null, role: 'system' },
    meta: {
      targetEmail: user.email || null,
      targetName: displayName(user) || null,
      cleanupMode: 'archived',
      reason: CLEANUP_REASON,
      timestamp: now.toISOString(),
    },
  });

  return updated;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('Missing MONGODB_URI (or legacy MONGO_URI). Aborting test staff cleanup.');
  }

  await mongoose.connect(uri);
  const now = new Date();
  const targets = await findTargetAccounts();
  let archivedCount = 0;
  const skipped = [];

  console.log('[cleanup:test-staff] Found target accounts count:', targets.length);

  for (const user of targets) {
    const name = displayName(user) || '(unnamed)';
    const email = user.email || '(blank)';
    if (String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID) {
      skipped.push({ id: String(user._id), name, email, reason: 'NP-FND-0001 untouched' });
      continue;
    }
    const blockers = await safetyBlockers(user);
    if (blockers.length) {
      skipped.push({ id: String(user._id), name, email, reason: blockers.join('; ') });
      continue;
    }
    await archiveAccount(user, now);
    archivedCount += 1;
    console.log('[cleanup:test-staff] Archived:', { id: String(user._id), name, email });
  }

  const founder = await User.findOne({ staffId: FOUNDER_STAFF_ID }).lean();
  console.log('[cleanup:test-staff] Archived/deleted count:', archivedCount);
  console.log('[cleanup:test-staff] Skipped count:', skipped.length);
  for (const item of skipped) console.log('[cleanup:test-staff] Skipped:', item);
  console.log('[cleanup:test-staff] Confirm Founder untouched:', Boolean(founder && founder.role === 'founder' && founder.isProtected === true));
  console.log('[cleanup:test-staff] Confirm NP-FND-0001 untouched:', Boolean(founder && String(founder.staffId || '').toUpperCase() === FOUNDER_STAFF_ID));
  console.log('[cleanup:test-staff] Cleanup mode: archived');
}

main()
  .catch((error) => {
    console.error('[cleanup:test-staff] Failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
