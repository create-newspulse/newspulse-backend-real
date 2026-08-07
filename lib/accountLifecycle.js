const { FOUNDER_STAFF_ID } = require('./staffId');
const { isFounderRole } = require('./teamAccess');

const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  LOCKED: 'locked',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
  DELETED_TEST: 'deleted_test',
});

function isFounderAccount(user) {
  if (!user) return false;
  const staffId = String(user.staffId || '').trim().toUpperCase();
  return Boolean(user.isFounder || user.isProtected || isFounderRole(user.role) || staffId === FOUNDER_STAFF_ID);
}

function hasNoExpiry(user) {
  if (isFounderAccount(user)) return true;
  return Boolean(user && user.noExpiry === true) || !user?.accessExpiresAt;
}

function accessExpiryDate(user) {
  if (!user || hasNoExpiry(user)) return null;
  const date = new Date(user.accessExpiresAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isAccountExpired(user, now = new Date()) {
  if (!user || isFounderAccount(user)) return false;
  const expiresAt = accessExpiryDate(user);
  return Boolean(expiresAt && expiresAt <= now);
}

function lifecycleStatus(user, now = new Date()) {
  if (!user) return ACCOUNT_STATUS.ACTIVE;
  if (isFounderAccount(user)) return ACCOUNT_STATUS.ACTIVE;
  const accountStatus = String(user.accountStatus || user.status || ACCOUNT_STATUS.ACTIVE).toLowerCase();
  const userStatus = String(user.status || accountStatus || ACCOUNT_STATUS.ACTIVE).toLowerCase();
  if (user.isDeleted || user.deletedAt) return ACCOUNT_STATUS.DELETED;
  if (user.lockedUntil && new Date(user.lockedUntil) > now) return ACCOUNT_STATUS.LOCKED;
  if ([ACCOUNT_STATUS.SUSPENDED, ACCOUNT_STATUS.LOCKED, ACCOUNT_STATUS.ARCHIVED, ACCOUNT_STATUS.DELETED, ACCOUNT_STATUS.DELETED_TEST].includes(accountStatus)) return accountStatus;
  if ([ACCOUNT_STATUS.SUSPENDED, ACCOUNT_STATUS.LOCKED, ACCOUNT_STATUS.ARCHIVED, ACCOUNT_STATUS.DELETED, ACCOUNT_STATUS.DELETED_TEST].includes(userStatus)) return userStatus;
  if (isAccountExpired(user, now) || accountStatus === ACCOUNT_STATUS.EXPIRED || userStatus === ACCOUNT_STATUS.EXPIRED) return ACCOUNT_STATUS.EXPIRED;
  return ACCOUNT_STATUS.ACTIVE;
}

async function expireAccount(User, user, options = {}) {
  if (!User || !user || !user._id || isFounderAccount(user)) return null;
  const now = options.now || new Date();
  const status = lifecycleStatus(user, now);
  if (status !== ACCOUNT_STATUS.EXPIRED) return null;
  const currentStatus = String(user.accountStatus || user.status || '').toLowerCase();
  if (currentStatus === ACCOUNT_STATUS.EXPIRED && user.loginAllowed === false) return null;
  return User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        status: ACCOUNT_STATUS.EXPIRED,
        accountStatus: ACCOUNT_STATUS.EXPIRED,
        loginAllowed: false,
        sessionsRevokedAt: now,
        currentSessionId: null,
        onlineStatus: 'offline',
        lastLogoutAt: now,
        updatedAt: now,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );
}

function accountLifecycleResponse(res, status) {
  if (status === ACCOUNT_STATUS.SUSPENDED) return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' });
  if (status === ACCOUNT_STATUS.LOCKED) return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_LOCKED', message: 'Account locked' });
  if (status === ACCOUNT_STATUS.ARCHIVED) return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_ARCHIVED', message: 'Account archived' });
  if (status === ACCOUNT_STATUS.DELETED || status === ACCOUNT_STATUS.DELETED_TEST) return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_DELETED', message: 'Account deleted' });
  if (status === ACCOUNT_STATUS.EXPIRED) return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_EXPIRED', message: 'Your staff account access period has expired.' });
  return null;
}

module.exports = {
  ACCOUNT_STATUS,
  accountLifecycleResponse,
  accessExpiryDate,
  expireAccount,
  hasNoExpiry,
  isAccountExpired,
  isFounderAccount,
  lifecycleStatus,
};