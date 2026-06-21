const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Counter = require('../models/Counter');
const User = require('../models/User');

const FOUNDER_STAFF_ID = 'NP-FND-0001';
const NORMAL_STAFF_ID_PATTERN = /^NP-(\d{4})-(\d{4})$/;

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function hasNativeConnection() {
  return isDbReady() && Boolean(mongoose.connection && mongoose.connection.db);
}

function normalizeStaffId(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function isFounderUser(user) {
  return Boolean(user?.isFounder || String(user?.role || '').trim().toLowerCase() === 'founder');
}

function isFounderStaffId(staffId) {
  return normalizeStaffId(staffId) === FOUNDER_STAFF_ID;
}

function isNormalStaffId(staffId) {
  return NORMAL_STAFF_ID_PATTERN.test(String(normalizeStaffId(staffId) || ''));
}

function isValidStaffIdForUser(user, staffId) {
  const normalized = normalizeStaffId(staffId);
  if (!normalized) return false;
  if (isFounderUser(user)) return normalized === FOUNDER_STAFF_ID;
  return isNormalStaffId(normalized);
}

function staffIdForSequence(year, value) {
  return `NP-${year}-${String(value).padStart(4, '0')}`;
}

function currentYear() {
  return new Date().getFullYear();
}

async function resolveQueryResult(query) {
  if (!query) return query;
  if (typeof query.lean === 'function') return query.lean();
  return query;
}

async function readAllUsersForFallback() {
  if (typeof User.find !== 'function') return [];
  try {
    const query = User.find({});
    const sorted = query && typeof query.sort === 'function' ? query.sort({ createdAt: 1 }) : query;
    const users = await resolveQueryResult(sorted);
    return Array.isArray(users) ? users : [];
  } catch (_) {
    return [];
  }
}

async function nextFallbackSequence(year) {
  const users = await readAllUsersForFallback();
  let maxSequence = 0;

  for (const user of users) {
    const match = String(normalizeStaffId(user?.staffId) || '').match(NORMAL_STAFF_ID_PATTERN);
    if (!match) continue;
    if (Number(match[1]) !== Number(year)) continue;
    maxSequence = Math.max(maxSequence, Number(match[2]) || 0);
  }

  return maxSequence + 1;
}

async function createSystemAudit(action, targetUserId = null, meta = null) {
  try {
    if (!hasNativeConnection()) return;
    await AuditLog.create({
      action,
      key: targetUserId ? `user:${String(targetUserId)}` : null,
      actor: { id: 'system', email: null, role: 'system' },
      ip: null,
      userAgent: 'system/staff-id',
      meta: {
        targetUserId: targetUserId ? String(targetUserId) : null,
        ...(meta || {}),
      },
    });
  } catch (_) {}
}

async function findDuplicateUser(staffId, excludeUserId = null) {
  const normalized = normalizeStaffId(staffId);
  if (!normalized) return null;
  let query = null;

  if (hasNativeConnection()) {
    query = await resolveQueryResult(User.findOne({ staffId: normalized }));
  } else {
    const users = await readAllUsersForFallback();
    query = users.find((user) => normalizeStaffId(user?.staffId) === normalized) || null;
  }

  if (!query) return null;
  const duplicateId = query._id || query.id || null;
  if (excludeUserId && duplicateId && String(duplicateId) === String(excludeUserId)) return null;
  return query;
}

async function nextCounterValue(year) {
  if (!hasNativeConnection()) {
    return nextFallbackSequence(year);
  }
  const key = `staffId_${year}`;
  const counter = await Counter.findOneAndUpdate(
    { key },
    {
      $inc: { value: 1 },
      $set: { updatedAt: new Date() },
      $setOnInsert: { key },
    },
    { new: true, upsert: true, setDefaultsOnInsert: false },
  );
  return typeof counter?.value === 'number' ? counter.value : 1;
}

async function generateStaffId(options = {}) {
  const year = Number(options.year || currentYear());
  const founder = Boolean(options.founder);
  const excludeUserId = options.excludeUserId || null;

  if (founder) {
    const duplicate = await findDuplicateUser(FOUNDER_STAFF_ID, excludeUserId);
    if (duplicate) {
      await createSystemAudit('TEAM_STAFF_ID_DUPLICATE_DETECTED', excludeUserId, {
        staffId: FOUNDER_STAFF_ID,
        duplicateUserId: String(duplicate._id || duplicate.id || ''),
        mode: 'founder',
      });
      throw new Error('Founder Staff ID already assigned to another account');
    }
    return { staffId: FOUNDER_STAFF_ID, year: null, sequence: 1 };
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const sequence = await nextCounterValue(year);
    const staffId = staffIdForSequence(year, sequence);
    const duplicate = await findDuplicateUser(staffId, excludeUserId);
    if (!duplicate) return { staffId, year, sequence };

    await createSystemAudit('TEAM_STAFF_ID_DUPLICATE_DETECTED', excludeUserId, {
      staffId,
      duplicateUserId: String(duplicate._id || duplicate.id || ''),
      year,
      sequence,
      mode: 'counter_collision',
    });
  }

  throw new Error(`Unable to allocate Staff ID for ${year}`);
}

async function previewNextStaffId(options = {}) {
  const year = Number(options.year || currentYear());
  if (!hasNativeConnection()) {
    const sequence = await nextFallbackSequence(year);
    return { staffId: staffIdForSequence(year, sequence), year, sequence };
  }
  const existing = await Counter.findOne({ key: `staffId_${year}` });
  const sequence = ((existing && typeof existing.value === 'number') ? existing.value : 0) + 1;
  return { staffId: staffIdForSequence(year, sequence), year, sequence };
}

async function persistStaffId(user, patch, action, meta = null) {
  const targetUserId = user?._id || user?.id || null;
  const finalPatch = {
    ...patch,
    staffId: normalizeStaffId(patch.staffId),
    staffIdLocked: patch.staffIdLocked !== undefined ? Boolean(patch.staffIdLocked) : true,
    staffIdGeneratedAt: patch.staffIdGeneratedAt || new Date(),
    updatedAt: new Date(),
  };

  let updated = null;
  if (targetUserId && typeof User.findByIdAndUpdate === 'function') {
    updated = await User.findByIdAndUpdate(targetUserId, { $set: finalPatch }, { new: true });
  } else if (user && typeof user.save === 'function') {
    Object.assign(user, finalPatch);
    updated = await user.save();
  } else {
    updated = { ...user, ...finalPatch };
  }

  await createSystemAudit(action, targetUserId, {
    staffId: finalPatch.staffId,
    ...(meta || {}),
  });
  return updated;
}

async function ensureUserStaffId(user, options = {}) {
  if (!user) return { user: null, changed: false, flagged: false, staffId: null };
  const existing = normalizeStaffId(user.staffId);
  const targetUserId = user._id || user.id || null;
  const now = options.generatedAt || new Date();

  if (existing) {
    if (!isValidStaffIdForUser(user, existing)) {
      await createSystemAudit('TEAM_STAFF_ID_INVALID_DETECTED', targetUserId, { staffId: existing });
      return { user, changed: false, flagged: true, staffId: existing };
    }

    const duplicate = await findDuplicateUser(existing, targetUserId);
    if (duplicate) {
      await createSystemAudit('TEAM_STAFF_ID_DUPLICATE_DETECTED', targetUserId, {
        staffId: existing,
        duplicateUserId: String(duplicate._id || duplicate.id || ''),
        mode: 'existing',
      });
      return { user, changed: false, flagged: true, staffId: existing };
    }

    if (existing !== user.staffId || user.staffIdLocked !== true || !user.staffIdGeneratedAt) {
      const updated = await persistStaffId(user, {
        staffId: existing,
        staffIdLocked: true,
        staffIdGeneratedAt: user.staffIdGeneratedAt || user.createdAt || now,
      }, 'TEAM_STAFF_ID_BACKFILLED', { mode: 'normalize_existing' });
      return { user: updated, changed: true, flagged: false, staffId: existing };
    }

    return { user, changed: false, flagged: false, staffId: existing };
  }

  const generated = await generateStaffId({ founder: isFounderUser(user), excludeUserId: targetUserId });
  const updated = await persistStaffId(user, {
    staffId: generated.staffId,
    staffIdLocked: true,
    staffIdGeneratedAt: now,
  }, options.action || 'TEAM_STAFF_ID_BACKFILLED', {
    year: generated.year,
    sequence: generated.sequence,
    mode: isFounderUser(user) ? 'founder_backfill' : 'normal_backfill',
  });

  return { user: updated, changed: true, flagged: false, staffId: generated.staffId };
}

async function resolveStaffIdForNewUser(userLike, options = {}) {
  const requested = normalizeStaffId(options.requestedStaffId);
  const founder = isFounderUser(userLike);
  const generatedAt = options.generatedAt || new Date();

  if (requested) {
    if (!isValidStaffIdForUser(userLike, requested)) {
      throw new Error(founder ? 'Founder Staff ID must be NP-FND-0001' : 'Invalid Staff ID format');
    }
    const duplicate = await findDuplicateUser(requested, options.excludeUserId || null);
    if (duplicate) {
      await createSystemAudit('TEAM_STAFF_ID_DUPLICATE_DETECTED', options.excludeUserId || null, {
        staffId: requested,
        duplicateUserId: String(duplicate._id || duplicate.id || ''),
        mode: 'requested_create',
      });
      const error = new Error('Staff ID already exists');
      error.code = 'STAFF_ID_EXISTS';
      throw error;
    }
    return { staffId: requested, generated: false, generatedAt, year: null, sequence: null };
  }

  const generated = await generateStaffId({ founder, excludeUserId: options.excludeUserId || null });
  return {
    staffId: generated.staffId,
    generated: true,
    generatedAt,
    year: generated.year,
    sequence: generated.sequence,
  };
}

module.exports = {
  FOUNDER_STAFF_ID,
  currentYear,
  ensureUserStaffId,
  generateStaffId,
  isFounderStaffId,
  isNormalStaffId,
  isValidStaffIdForUser,
  normalizeStaffId,
  previewNextStaffId,
  resolveStaffIdForNewUser,
};