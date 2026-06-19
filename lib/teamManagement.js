const mongoose = require('mongoose');

const User = require('../models/User');
const SessionLog = require('../models/SessionLog');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAuth } = require('../middleware/requireAuth');
const { hasPermission, normalizeRole } = require('./teamAccess');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function canWriteNativeModels() {
  return isDbReady() && Boolean(mongoose.connection && mongoose.connection.db);
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

function getReqIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',')[0].trim() || req.socket?.remoteAddress || req.ip || null;
}

function getDevice(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return null;
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  return 'desktop';
}

function syncReqUserFromAdmin(req) {
  if (!req.admin) return;
  req.user = {
    id: req.admin.id || null,
    email: req.admin.email || null,
    name: req.admin.name || null,
    role: req.admin.role || null,
    permissions: Array.isArray(req.admin.permissions) ? req.admin.permissions : [],
    status: req.admin.status || 'active',
    accountStatus: req.admin.accountStatus || req.admin.status || 'active',
    tokenVersion: typeof req.admin.tokenVersion === 'number' ? req.admin.tokenVersion : 0,
    isFounder: Boolean(req.admin.isFounder || normalizeRole(req.admin.role) === 'founder'),
    isProtected: Boolean(req.admin.isProtected || normalizeRole(req.admin.role) === 'founder'),
  };
}

function requireTeamAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) return requireAuth(req, res, next);

  return requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return next(err);
    syncReqUserFromAdmin(req);
    return next();
  });
}

function actorIsFounder(user) {
  return Boolean(user?.isFounder || normalizeRole(user?.role) === 'founder');
}

function can(permission, user) {
  return actorIsFounder(user) || hasPermission(user, permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    if (!can(permission, req.user)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
    return next();
  };
}

function isSameUser(req, userId) {
  return String(req.user?.id || '') === String(userId || '');
}

function canViewUser(req, userId, allPermission, ownPermission) {
  if (can(allPermission, req.user)) return true;
  return isSameUser(req, userId) && can(ownPermission, req.user);
}

function currentAccountStatus(user) {
  const legacy = String(user?.status || '').toLowerCase();
  if (['suspended', 'locked', 'expired'].includes(legacy)) return legacy;
  const accountStatus = String(user?.accountStatus || '').toLowerCase();
  if (['active', 'suspended', 'locked', 'expired'].includes(accountStatus)) return accountStatus;
  return 'active';
}

function ensureActiveAccount(user, res) {
  const status = currentAccountStatus(user);
  if (status === 'active') return true;
  const code = status === 'suspended' ? 'ACCOUNT_SUSPENDED' : status === 'locked' ? 'ACCOUNT_LOCKED' : 'ACCOUNT_EXPIRED';
  bad(res, 403, `Account ${status}`, code);
  return false;
}

function dayStart(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseDate(value, fallback = new Date()) {
  if (value === undefined || value === null || value === '') return dayStart(fallback);
  return dayStart(value);
}

function parseDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesBetween(start, end) {
  const a = start ? new Date(start).getTime() : NaN;
  const b = end ? new Date(end).getTime() : NaN;
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.floor((b - a) / 60000);
}

function actorObjectId(req) {
  return mongoose.isValidObjectId(String(req.user?.id || '')) ? req.user.id : null;
}

async function recordLoginSession(req, user, options = {}) {
  try {
    if (!canWriteNativeModels() || !user?._id) return null;
    const now = options.now || new Date();
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const session = await SessionLog.create({
      userId: user._id,
      loginAt: now,
      lastSeenAt: now,
      ipAddress: getReqIp(req),
      userAgent,
      device: getDevice(userAgent),
      status: 'active',
    });
    user.lastLoginAt = now;
    user.lastSeenAt = now;
    user.onlineStatus = 'online';
    user.currentSessionId = session._id;
    await user.save();
    return session;
  } catch (_) {
    return null;
  }
}

async function recordLogoutSession(req, userId, reason = 'logout') {
  try {
    if (!canWriteNativeModels() || !mongoose.isValidObjectId(String(userId || ''))) return null;
    const now = new Date();
    const user = await User.findById(String(userId));
    if (!user) return null;
    let session = null;
    if (user.currentSessionId && mongoose.isValidObjectId(String(user.currentSessionId))) {
      session = await SessionLog.findById(user.currentSessionId);
    }
    if (!session) {
      session = await SessionLog.findOne({ userId: user._id, status: 'active' }).sort({ loginAt: -1 });
    }
    if (session) {
      session.logoutAt = now;
      session.lastSeenAt = now;
      session.status = 'ended';
      session.logoutReason = String(reason || 'logout').slice(0, 120);
      await session.save();
    }
    user.lastLogoutAt = now;
    user.lastSeenAt = now;
    user.onlineStatus = 'offline';
    user.currentSessionId = null;
    await user.save();
    return session;
  } catch (_) {
    return null;
  }
}

async function heartbeat(req, userId) {
  if (!canWriteNativeModels() || !mongoose.isValidObjectId(String(userId || ''))) return null;
  const now = new Date();
  const user = await User.findById(String(userId));
  if (!user) return null;
  const nextOnlineStatus = user.onlineStatus === 'on_break' ? 'on_break' : 'online';
  user.lastSeenAt = now;
  user.onlineStatus = nextOnlineStatus;
  if (user.currentSessionId) {
    await SessionLog.findByIdAndUpdate(user.currentSessionId, { $set: { lastSeenAt: now } });
  }
  await user.save();
  return user;
}

async function markIdleUsers() {
  if (!isDbReady()) return;
  const minutes = Math.max(1, parseInt(process.env.TEAM_PRESENCE_IDLE_MINUTES || '5', 10));
  const cutoff = new Date(Date.now() - minutes * 60000);
  await User.updateMany(
    { onlineStatus: 'online', lastSeenAt: { $lt: cutoff } },
    { $set: { onlineStatus: 'idle' } },
  );
}

module.exports = {
  actorIsFounder,
  actorObjectId,
  bad,
  can,
  canViewUser,
  currentAccountStatus,
  dayStart,
  ensureActiveAccount,
  ensureDb,
  getDevice,
  getReqIp,
  heartbeat,
  isDbReady,
  isSameUser,
  markIdleUsers,
  minutesBetween,
  ok,
  parseDate,
  parseDateTime,
  recordLoginSession,
  recordLogoutSession,
  requirePermission,
  requireTeamAuth,
};