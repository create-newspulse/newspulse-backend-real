const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const { requireAuth } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const { recordLoginSession, recordLogoutSession } = require('../lib/teamManagement');
const { normalizeRole, requirePasswordPolicy, safeUserDto } = require('../lib/teamAccess');

const router = express.Router();

function normalizeEmail(value) {
  return String(value || '').toLowerCase().trim();
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function jwtSecret() {
  return String(process.env.JWT_SECRET || '').trim();
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function signAccessToken(user) {
  const secret = jwtSecret();
  const tokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
  return jwt.sign(
    {
      sub: String(user._id),
      userId: String(user._id),
      email: user.email,
      name: user.fullName || user.name,
      role: normalizeRole(user.role) || user.role,
      tokenVersion,
      type: 'access',
      typ: 'access',
    },
    secret,
    { expiresIn: process.env.AUTH_ACCESS_TOKEN_EXPIRES_IN || '2h' },
  );
}

function signRefreshToken(user) {
  const secret = jwtSecret();
  const tokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
  return jwt.sign(
    {
      sub: String(user._id),
      userId: String(user._id),
      email: user.email,
      role: normalizeRole(user.role) || user.role,
      tokenVersion,
      type: 'refresh',
      typ: 'refresh',
    },
    secret,
    { expiresIn: process.env.AUTH_REFRESH_TOKEN_EXPIRES_IN || '30d' },
  );
}

function cookieOptions(req, maxAge) {
  const isHttps = Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    maxAge,
    path: '/',
  };
}

function setAuthCookies(req, res, accessToken, refreshToken) {
  const accessOptions = cookieOptions(req, 2 * 60 * 60 * 1000);
  const refreshOptions = cookieOptions(req, 30 * 24 * 60 * 60 * 1000);
  res.cookie('token', accessToken, accessOptions);
  res.cookie('np_token', accessToken, accessOptions);
  res.cookie('np_admin_token', accessToken, accessOptions);
  res.cookie('np_refresh_token', refreshToken, refreshOptions);
}

function clearAuthCookies(res) {
  for (const name of ['token', 'np_token', 'np_admin_token', 'np_refresh_token']) {
    res.clearCookie(name, { path: '/' });
  }
}

async function findLoginUser(identifier) {
  const normalizedEmail = normalizeEmail(identifier);
  const query = User.findOne({ email: normalizedEmail });
  if (query && typeof query.select === 'function') return query.select('+passwordHash');
  return query;
}

async function enforceLoginAccountState(req, res, user) {
  const now = new Date();
  const status = String(user.status || 'active').toLowerCase();
  const accountStatus = String(user.accountStatus || '').toLowerCase();

  if (status === 'locked' && user.lockedUntil && user.lockedUntil <= now) {
    user.status = 'active';
    if (accountStatus === 'locked') user.accountStatus = 'active';
    user.lockedUntil = null;
    user.failedLoginCount = 0;
    await user.save();
    return true;
  }

  if (status === 'suspended' || accountStatus === 'suspended') {
    await logAudit(req, 'AUTH_LOGIN_FAILED', String(user._id), { reason: 'suspended' });
    bad(res, 403, 'Account suspended', 'ACCOUNT_SUSPENDED');
    return false;
  }

  if (status === 'locked' || accountStatus === 'locked' || (user.lockedUntil && user.lockedUntil > now)) {
    await logAudit(req, 'AUTH_LOGIN_FAILED', String(user._id), { reason: 'locked' });
    bad(res, 403, 'Account locked', 'ACCOUNT_LOCKED');
    return false;
  }

  if (status === 'expired' || accountStatus === 'expired' || (user.accessExpiresAt && user.accessExpiresAt <= now)) {
    await logAudit(req, 'AUTH_LOGIN_FAILED', String(user._id), { reason: 'expired' });
    bad(res, 403, 'Account expired', 'ACCOUNT_EXPIRED');
    return false;
  }

  if (user.mustChangePassword && user.tempPasswordExpiresAt && user.tempPasswordExpiresAt <= now) {
    user.status = 'expired';
    await user.save();
    await logAudit(req, 'AUTH_LOGIN_FAILED', String(user._id), { reason: 'temporary_password_expired' });
    bad(res, 403, 'Temporary password expired', 'TEMP_PASSWORD_EXPIRED');
    return false;
  }

  return true;
}

async function recordFailedLogin(req, user, reason) {
  if (!user) {
    await logAudit(req, 'AUTH_LOGIN_FAILED', null, { reason });
    return;
  }

  const failedLoginCount = (typeof user.failedLoginCount === 'number' ? user.failedLoginCount : 0) + 1;
  user.failedLoginCount = failedLoginCount;
  if (failedLoginCount >= 5) {
    user.status = 'locked';
    user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
  }
  await user.save();
  await logAudit(req, 'AUTH_LOGIN_FAILED', String(user._id), { reason, failedLoginCount });
}

async function loginHandler(req, res) {
  try {
    const identifier = String(req.body?.email || req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!identifier || !password) return bad(res, 400, 'Email and password required', 'MISSING_CREDENTIALS');
    if (!jwtSecret()) return bad(res, 500, 'JWT_SECRET missing on server', 'SERVER_MISCONFIGURED');
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');

    const user = await findLoginUser(identifier);
    if (!user || !user.passwordHash) {
      await recordFailedLogin(req, null, 'invalid_credentials');
      return bad(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }

    if (!(await enforceLoginAccountState(req, res, user))) return;

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      await recordFailedLogin(req, user, 'invalid_credentials');
      return bad(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }

    user.lastLoginAt = new Date();
    user.failedLoginCount = 0;
    if (user.lockedUntil && user.lockedUntil <= new Date()) user.lockedUntil = null;
    await user.save();
    await recordLoginSession(req, user);

    const token = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    setAuthCookies(req, res, token, refreshToken);
    await logAudit(req, 'AUTH_LOGIN_SUCCESS', String(user._id), null);

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      token,
      accessToken: token,
      refreshToken,
      user: safeUserDto(user),
    });
  } catch (err) {
    return bad(res, 500, err?.message || 'Login failed', 'LOGIN_FAILED');
  }
}

async function logoutHandler(req, res) {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await User.findByIdAndUpdate(req.user.id, { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } });
    await recordLogoutSession(req, req.user.id, 'logout');
    await logAudit(req, 'AUTH_LOGOUT', req.user.id, null);
    clearAuthCookies(res);
    return res.status(200).json({ ok: true, success: true, status: 200 });
  } catch (err) {
    return bad(res, 500, err?.message || 'Logout failed', 'LOGOUT_FAILED');
  }
}

async function changePasswordHandler(req, res) {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    const currentPassword = String(req.body?.currentPassword || req.body?.oldPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || !newPassword) {
      return bad(res, 400, 'currentPassword and newPassword are required', 'MISSING_FIELDS');
    }

    const policy = requirePasswordPolicy(newPassword);
    if (!policy.ok) return bad(res, 400, policy.message, 'WEAK_PASSWORD');

    const query = User.findById(req.user.id);
    const user = query && typeof query.select === 'function' ? await query.select('+passwordHash') : await query;
    if (!user || !user.passwordHash) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');

    const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentOk) return bad(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');

    const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
    user.passwordHash = await bcrypt.hash(newPassword, rounds);
    user.mustChangePassword = false;
    user.mustResetPassword = false;
    user.forceReset = false;
    user.tempPasswordExpiresAt = null;
    user.status = user.status === 'pending' || user.status === 'expired' ? 'active' : user.status;
    user.updatedBy = mongoose.isValidObjectId(req.user.id) ? req.user.id : null;
    user.updatedAt = new Date();
    user.tokenVersion = (typeof user.tokenVersion === 'number' ? user.tokenVersion : 0) + 1;
    await user.save();

    await logAudit(req, 'AUTH_CHANGE_PASSWORD', String(user._id), null);
    return res.status(200).json({ ok: true, success: true, status: 200, user: safeUserDto(user) });
  } catch (err) {
    return bad(res, 500, err?.message || 'Password change failed', 'CHANGE_PASSWORD_FAILED');
  }
}

async function refreshHandler(req, res) {
  try {
    if (!jwtSecret()) return bad(res, 500, 'JWT_SECRET missing on server', 'SERVER_MISCONFIGURED');
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');

    const refreshToken = String(req.body?.refreshToken || req.cookies?.np_refresh_token || '').trim();
    if (!refreshToken) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');

    let payload;
    try {
      payload = jwt.verify(refreshToken, jwtSecret());
    } catch (_e) {
      return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    }

    if (payload.type !== 'refresh' && payload.typ !== 'refresh') return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    const userId = payload.sub || payload.userId;
    if (!userId || !mongoose.isValidObjectId(String(userId))) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');

    const user = await User.findById(String(userId));
    if (!user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    const tokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
    if ((typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0) !== tokenVersion) {
      return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    }
    if (!(await enforceLoginAccountState(req, res, user))) return;

    const token = signAccessToken(user);
    const nextRefreshToken = signRefreshToken(user);
    setAuthCookies(req, res, token, nextRefreshToken);
    return res.status(200).json({ ok: true, success: true, status: 200, token, accessToken: token, refreshToken: nextRefreshToken, user: safeUserDto(user) });
  } catch (err) {
    return bad(res, 500, err?.message || 'Refresh failed', 'REFRESH_FAILED');
  }
}

async function meHandler(req, res) {
  try {
    const user = req._authUserDoc || (isDbReady() && req.user?.id ? await User.findById(req.user.id) : null);
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      user: user ? safeUserDto(user) : safeUserDto(req.user),
    });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to load user', 'ME_FAILED');
  }
}

router.post('/login', loginHandler);
router.post('/logout', requireAuth, logoutHandler);
router.post('/change-password', requireAuth, changePasswordHandler);
router.post('/refresh', refreshHandler);
router.get('/me', requireAuth, meHandler);

router.loginHandler = loginHandler;
router.logoutHandler = logoutHandler;
router.changePasswordHandler = changePasswordHandler;
router.refreshHandler = refreshHandler;
router.meHandler = meHandler;

module.exports = router;