// routes/admin.js
// Admin panel routes used by https://admin.newspulse.co.in
// Mounted from server.js as /api/admin (and optionally /admin).

const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const { logAudit } = require('../lib/audit');
const { recordLoginSession, recordLogoutSession } = require('../lib/teamManagement');
const { FOUNDER_STAFF_ID } = require('../lib/staffId');
const {
  getLocalFounderSafeDiagnostics,
  isLocalDevLike,
  resolveLocalFounderSeedConfig,
} = require('../lib/localFounderAuth');

const OFFICIAL_FOUNDER_EMAIL = 'kiran@newspulse.co.in';
const FOUNDER_RECOVERY_EMAIL = 'newspulse.team@gmail.com';

const router = express.Router();

// ✅ Shared admin/founder auth middleware
const {
  requireAdminAuth,
  requireFounderAuth,
} = require('../middleware/adminAuth');

// ✅ Admin controllers
// communitySettings & communityReporter live under controllers/ (not controllers/admin)
const communitySettingsController = require('../controllers/communitySettingsController');
const communityReporterController = require('../controllers/communityReporterController');
const {
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
} = require('../controllers/admin/communityFeatureToggles');

const {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
} = communitySettingsController;

const {
  listReporters,
  getCommunityStats,
  getCommunityReporterAnalytics,
} = communityReporterController;

// ─────────────────────────────────────────────
// In-memory rate limiter for /login
// ─────────────────────────────────────────────

const loginAttempts = new Map(); // key: ip, value: number[]
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  const fresh = arr.filter((ts) => now - ts < WINDOW_MS);
  loginAttempts.set(ip, fresh);
  return fresh.length >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const arr = loginAttempts.get(ip) || [];
  arr.push(now);
  loginAttempts.set(ip, arr);
}

function logLocalAdminRefresh(details) {
  if (!isLocalDevLike()) return;
  // eslint-disable-next-line no-console
  console.log('[admin.refresh.local]', details);
}

function adminLoginEmailCandidates(localFounderConfig, localDev) {
  return [
    process.env.ADMIN_EMAIL,
    process.env.FOUNDER_EMAIL,
    process.env.ADMIN_SEED_FOUNDER_EMAIL,
    OFFICIAL_FOUNDER_EMAIL,
    localDev ? localFounderConfig.email : '',
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && value.toLowerCase() !== FOUNDER_RECOVERY_EMAIL);
}

// ─────────────────────────────────────────────
// PUBLIC: login/logout/health
// ─────────────────────────────────────────────

// POST /api/admin/login
router.post('/login', async (req, res, next) => {
  // IMPORTANT: this router is also mounted at /admin in server.js.
  // /admin/login is handled by a dedicated legacy handler in server.js for tests.
  // We must allow this request to fall through without being blocked by auth middleware.
  if (req.baseUrl === '/admin') return next();

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const body = req.body || {};
  // Some admin builds send `username` instead of `email`.
  const email = String(body.email || body.username || '').trim();
  const password = String(body.password || body.pass || '').trim();

  if (isRateLimited(ip)) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=rate-limit`);
    await logAudit(req, 'SUSPICIOUS_LOGIN_ATTEMPT', null, { email, reason: 'rate-limit' });
    return res
      .status(429)
      .json({ ok: false, message: 'Too many login attempts. Please try again later.' });
  }

  recordAttempt(ip);

  // Supported env vars for admin login (fallback when DB auth is unavailable):
  // Preferred:
  // - ADMIN_EMAIL / ADMIN_PASSWORD / JWT_SECRET
  // Backward-compat:
  // - ADMIN_PASS (legacy naming)
  // - FOUNDER_EMAIL / FOUNDER_PASSWORD (older deployments)
  const localFounderConfig = resolveLocalFounderSeedConfig();
  const localDev = isLocalDevLike();
  const adminEmail = adminLoginEmailCandidates(localFounderConfig, localDev)[0] || '';
  const adminPassword = String(
    process.env.ADMIN_PASSWORD
    || process.env.ADMIN_PASS
    || process.env.FOUNDER_PASSWORD
    || process.env.FOUNDER_PASS
    || process.env.ADMIN_SEED_FOUNDER_PASSWORD
    || (localDev ? localFounderConfig.password : '')
  ).trim();
  const founderName = process.env.ADMIN_SEED_FOUNDER_NAME || process.env.FOUNDER_NAME || (localDev ? localFounderConfig.fullName : 'Founder');
  const founderId = process.env.FOUNDER_ID || 'founder-001';
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();

  const debugLogin = String(process.env.ADMIN_LOGIN_DEBUG || '').trim() === '1';

  if (!jwtSecret) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=missing-jwt-secret`);
    return res.status(500).json({ ok: false, message: 'JWT_SECRET missing' });
  }

  const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
  const dbName = dbReady && mongoose.connection.name ? String(mongoose.connection.name) : null;
  let localDebugUserFound = false;
  let localDebugPasswordMatch = false;
  let localDebugRoleFound = null;
  const logLocalLoginDebug = (details) => {
    if (!localDev) return;
    console.log('[local-admin-login]', {
      attemptedEmail: email.toLowerCase(),
      dbName,
      ...details,
    });
  };

  // In environments where DB auth is unavailable, we require env-based admin creds.
  // Returning 500 here makes misconfiguration explicit (and keeps tests deterministic).
  if (!dbReady && (!adminEmail || !adminPassword)) {
    console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=missing-admin-creds`);
    return res.status(500).json({ ok: false, message: 'Admin credentials not configured' });
  }

  const signForUser = (u) => {
    const tokenVersion = typeof u.tokenVersion === 'number' ? u.tokenVersion : 0;
    return jwt.sign(
      {
        sub: String(u._id),
        userId: String(u._id),
        email: u.email,
        name: u.name,
        role: String(u.role || 'staff').toLowerCase(),
        tokenVersion,
        type: 'access',
      },
      jwtSecret,
      { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' },
    );
  };

  const signRefreshForUser = (u) => {
    const tokenVersion = typeof u.tokenVersion === 'number' ? u.tokenVersion : 0;
    return jwt.sign(
      {
        sub: String(u._id),
        userId: String(u._id),
        email: u.email,
        name: u.name,
        role: String(u.role || 'staff').toLowerCase(),
        tokenVersion,
        type: 'refresh',
        typ: 'refresh',
      },
      jwtSecret,
      { expiresIn: process.env.ADMIN_REFRESH_JWT_EXPIRES_IN || '30d' },
    );
  };

  const signAccessFallbackToken = (payload) => jwt.sign(
    {
      ...payload,
      type: 'access',
      typ: 'access',
    },
    jwtSecret,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' },
  );

  const signRefreshFallbackToken = (payload) => jwt.sign(
    {
      ...payload,
      type: 'refresh',
      typ: 'refresh',
    },
    jwtSecret,
    { expiresIn: process.env.ADMIN_REFRESH_JWT_EXPIRES_IN || '30d' },
  );

  const setLoginCookies = (token, effectiveEmail) => {
    const isProd = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production'
      || !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
    const cookieSameSite = isProd ? 'none' : (process.env.ADMIN_COOKIE_SAMESITE || 'lax');
    const cookieSecure = isProd ? true : (String(process.env.ADMIN_COOKIE_SECURE || '').trim() === '1');
    const cookieDomain = isProd ? (process.env.ADMIN_COOKIE_DOMAIN || '.newspulse.co.in') : undefined;
    try {
      res.cookie('np_admin', effectiveEmail, {
        path: '/',
        sameSite: cookieSameSite,
        secure: cookieSecure,
        ...(cookieDomain ? { domain: cookieDomain } : {}),
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.cookie('np_admin_token', token, {
        httpOnly: true,
        path: '/',
        sameSite: cookieSameSite,
        secure: cookieSecure,
        ...(cookieDomain ? { domain: cookieDomain } : {}),
        maxAge: 2 * 60 * 60 * 1000,
      });
    } catch (_) {
      const sameSiteHdr = isProd ? 'None' : String(cookieSameSite).toLowerCase() === 'none' ? 'None' : 'Lax';
      const secureHdr = cookieSecure ? '; Secure' : '';
      const domainHdr = cookieDomain ? `; Domain=${cookieDomain}` : '';
      res.setHeader('Set-Cookie', `np_admin=${encodeURIComponent(effectiveEmail)}; Path=/; SameSite=${sameSiteHdr}${secureHdr}${domainHdr}`);
    }
  };

  // Primary path: DB-backed user login (works with bootstrap-founder).
  if (dbReady) {
    try {
      const normalizedEmail = email.toLowerCase();
      if (normalizedEmail === FOUNDER_RECOVERY_EMAIL) {
        await logAudit(req, 'AUTH_LOGIN_FAILED', null, { email: normalizedEmail, reason: 'founder_recovery_email_not_login' });
        return res.status(401).json({ ok: false, message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      }
      const u = await User.findOne({ email: normalizedEmail });
      let passwordMatch = false;
      localDebugUserFound = !!u;
      localDebugRoleFound = u ? String(u.role || '') || null : null;
      if (u) {
        const blockedStatus = String(u.accountStatus || u.status || 'active').toLowerCase();
        const legacyStatus = String(u.status || 'active').toLowerCase();
        if (blockedStatus === 'suspended' || legacyStatus === 'suspended') {
          localDebugPasswordMatch = false;
          logLocalLoginDebug({ userFound: true, passwordMatch: false, roleFound: localDebugRoleFound, status: 'suspended' });
          return res.status(403).json({ ok: false, message: 'Account suspended' });
        }
        if (u.loginAllowed === false) {
          localDebugPasswordMatch = false;
          logLocalLoginDebug({ userFound: true, passwordMatch: false, roleFound: localDebugRoleFound, status: 'login_disabled' });
          return res.status(403).json({ ok: false, message: 'Login disabled', code: 'LOGIN_DISABLED' });
        }
        if (blockedStatus === 'locked' || legacyStatus === 'locked' || (u.lockedUntil && u.lockedUntil > new Date())) {
          localDebugPasswordMatch = false;
          logLocalLoginDebug({ userFound: true, passwordMatch: false, roleFound: localDebugRoleFound, status: 'locked' });
          return res.status(403).json({ ok: false, message: 'Account locked' });
        }
        if (blockedStatus === 'expired' || legacyStatus === 'expired' || (u.accessExpiresAt && u.accessExpiresAt <= new Date())) {
          localDebugPasswordMatch = false;
          logLocalLoginDebug({ userFound: true, passwordMatch: false, roleFound: localDebugRoleFound, status: 'expired' });
          return res.status(403).json({ ok: false, message: 'Account expired' });
        }
        if (u.passwordHash) {
          const okPw = await bcrypt.compare(password, u.passwordHash);
          passwordMatch = !!okPw;
          localDebugPasswordMatch = passwordMatch;
          if (okPw) {
            logLocalLoginDebug({ userFound: true, passwordMatch: true, roleFound: localDebugRoleFound, authSource: 'db' });
            u.lastLoginAt = new Date();
            await u.save();
            await recordLoginSession(req, u);

            const accessToken = signForUser(u);
            const refreshToken = signRefreshForUser(u);
            setLoginCookies(accessToken, u.email);
            return res.json({
              ok: true,
              token: accessToken,
              accessToken,
              refreshToken,
              user: { id: String(u._id), email: u.email, name: u.name || '', role: String(u.role || 'staff').toLowerCase() },
            });
          }
        }
      }

      logLocalLoginDebug({ userFound: localDebugUserFound, passwordMatch, roleFound: localDebugRoleFound, authSource: 'db-check' });

      if (localDev && normalizedEmail === localFounderConfig.email) {
        const founderExists = await User.exists({ role: 'founder' });
        if (!founderExists) {
          console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=founder-not-seeded`);
          return res.status(401).json({
            ok: false,
            code: 'ADMIN_FOUNDER_NOT_SEEDED',
            message: 'Local founder account is not seeded yet. POST /api/admin/seed-founder before logging in.',
            founder: getLocalFounderSafeDiagnostics(),
          });
        }
      }

      // Fall through to env login check.
    } catch (e) {
      console.error('[admin/login] db auth failed', e?.message || e);
      return res.status(500).json({ ok: false, message: 'Login failed' });
    }
  }

  // Fallback path: env-based founder login (DB down / maintenance).
  if (adminEmail && adminPassword && email.toLowerCase() === adminEmail.toLowerCase() && password === adminPassword) {
    localDebugPasswordMatch = true;
    logLocalLoginDebug({ userFound: false, passwordMatch: true, roleFound: localDebugRoleFound, authSource: 'env-fallback' });
    console.info(`ADMIN LOGIN SUCCESS email=${email} ip=${ip}`);
    const issueToken = async () => {
      // If DB is available, ensure a real User document exists so JWT-based auth
      // (requireAuth + tokenVersion checks) works for founder-only admin endpoints.
      if (dbReady) {
        const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
        const lowerEmail = adminEmail.toLowerCase();
        let ensured = await User.findOne({ email: lowerEmail });

        if (!ensured) {
          ensured = await User.create({
            email: lowerEmail,
            name: founderName,
            passwordHash: await bcrypt.hash(adminPassword, rounds),
            staffId: FOUNDER_STAFF_ID,
            staffIdGeneratedAt: new Date(),
            staffIdLocked: true,
            role: 'founder',
            status: 'active',
            tokenVersion: 0,
            mustChangePassword: false,
            createdAt: new Date(),
            lastLoginAt: new Date(),
          });
        } else {
          // Ensure required fields exist and enforce founder role.
          ensured.role = 'founder';
          ensured.status = 'active';
          if (!ensured.staffId) ensured.staffId = FOUNDER_STAFF_ID;
          ensured.staffIdLocked = true;
          if (!ensured.staffIdGeneratedAt) ensured.staffIdGeneratedAt = ensured.createdAt || new Date();
          ensured.lastLoginAt = new Date();
          if (!ensured.name) ensured.name = founderName;
          if (!ensured.passwordHash) ensured.passwordHash = await bcrypt.hash(adminPassword, rounds);
          await ensured.save();
        }

        await recordLoginSession(req, ensured);

        return {
          accessToken: signAccessFallbackToken({
            sub: String(ensured._id),
            userId: String(ensured._id),
            email: ensured.email,
            name: ensured.name,
            role: 'founder',
            tokenVersion: typeof ensured.tokenVersion === 'number' ? ensured.tokenVersion : 0,
          }),
          refreshToken: signRefreshFallbackToken({
            sub: String(ensured._id),
            userId: String(ensured._id),
            email: ensured.email,
            name: ensured.name,
            role: 'founder',
            tokenVersion: typeof ensured.tokenVersion === 'number' ? ensured.tokenVersion : 0,
          }),
        };
      }

      // DB unavailable: fall back to payload-only auth.
      // requireAuth is designed to accept payload-only when DB is down.
      return {
        accessToken: signAccessFallbackToken({ sub: founderId, email: adminEmail, name: founderName, role: 'founder', tokenVersion: 0 }),
        refreshToken: signRefreshFallbackToken({ sub: founderId, email: adminEmail, name: founderName, role: 'founder', tokenVersion: 0 }),
      };
    };

    Promise.resolve()
      .then(issueToken)
      .then((tokens) => {
        setLoginCookies(tokens.accessToken, adminEmail);

        return res.json({
          ok: true,
          token: tokens.accessToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: {
            id: 'founder',
            email: adminEmail,
            name: founderName,
            role: 'founder',
          },
        });
      })
      .catch((e) => {
        console.error('[admin/login] failed to issue token', e?.message || e);
        return res.status(500).json({ ok: false, message: 'Login failed' });
      });

    return;
  }

  console.warn(`ADMIN LOGIN FAIL email=${email} ip=${ip} reason=invalid-credentials`);
  await logAudit(req, 'SUSPICIOUS_LOGIN_ATTEMPT', null, { email, reason: 'invalid-credentials' });
  logLocalLoginDebug({
    userFound: localDebugUserFound,
    passwordMatch: localDebugPasswordMatch,
    roleFound: localDebugRoleFound,
    authSource: 'invalid-credentials',
  });
  return res.status(401).json({
    ok: false,
    message: 'Invalid admin credentials',
    ...(debugLogin ? {
      debug: {
        configuredEmailDomain: adminEmail.includes('@') ? adminEmail.split('@')[1] : null,
        receivedEmailDomain: email.includes('@') ? email.split('@')[1] : null,
      },
    } : {}),
  });
});

router.post('/refresh', async (req, res, next) => {
  if (req.baseUrl === '/admin') return next();

  logLocalAdminRefresh({
    phase: 'hit',
    route: `${req.baseUrl || ''}${req.path || ''}`,
    hasRefreshToken: !!String(req.body?.refreshToken || '').trim(),
  });

  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  const localFounderConfig = resolveLocalFounderSeedConfig();
  const fallbackFounderId = process.env.FOUNDER_ID || 'founder-001';
  const fallbackAdminEmail = String(
    process.env.ADMIN_EMAIL
    || process.env.FOUNDER_EMAIL
    || process.env.ADMIN_SEED_FOUNDER_EMAIL
    || localFounderConfig.email
    || ''
  ).trim().toLowerCase();
  const fallbackFounderName = process.env.ADMIN_SEED_FOUNDER_NAME || process.env.FOUNDER_NAME || localFounderConfig.fullName || 'Founder';
  if (!jwtSecret) {
    logLocalAdminRefresh({ phase: 'error', route: `${req.baseUrl || ''}${req.path || ''}`, status: 500, error: 'JWT_SECRET missing' });
    return res.status(500).json({ ok: false, success: false, message: 'JWT_SECRET missing' });
  }

  const refreshToken = String(req.body?.refreshToken || '').trim();
  if (!refreshToken) {
    logLocalAdminRefresh({ phase: 'error', route: `${req.baseUrl || ''}${req.path || ''}`, status: 401, error: 'Invalid refresh token' });
    return res.status(401).json({ ok: false, success: false, message: 'Invalid refresh token' });
  }

  try {
    const payload = jwt.verify(refreshToken, jwtSecret);
    const tokenType = String(payload?.typ || payload?.type || '').toLowerCase();
    if (tokenType !== 'refresh') {
      return res.status(401).json({ ok: false, success: false, message: 'Invalid refresh token' });
    }

    const accessToken = jwt.sign({
      sub: payload.sub || fallbackFounderId,
      userId: payload.userId || payload.sub || fallbackFounderId,
      email: payload.email || fallbackAdminEmail,
      name: payload.name || fallbackFounderName,
      role: payload.role || 'founder',
      tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0,
      type: 'access',
      typ: 'access',
    }, jwtSecret, { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '2h' });

    logLocalAdminRefresh({ phase: 'response', route: `${req.baseUrl || ''}${req.path || ''}`, status: 200, dbQueryResultCount: 1, error: null });
    return res.status(200).json({ ok: true, success: true, accessToken });
  } catch (_err) {
    logLocalAdminRefresh({ phase: 'error', route: `${req.baseUrl || ''}${req.path || ''}`, status: 401, dbQueryResultCount: 0, error: 'Invalid refresh token' });
    return res.status(401).json({ ok: false, success: false, message: 'Invalid refresh token' });
  }
});

// POST /api/admin/logout
router.post('/logout', async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').toLowerCase().startsWith('bearer ')
      ? String(req.headers.authorization || '').slice(7).trim()
      : String(req.cookies?.np_admin_token || req.cookies?.np_token || req.cookies?.token || '').trim();
    if (token) {
      try {
        const payload = jwt.verify(token, String(process.env.JWT_SECRET || '').trim() || 'dev-secret-change-me');
        const userId = payload?.sub || payload?.userId || null;
        if (userId) await recordLogoutSession(req, userId, 'logout');
      } catch (_e) {
        await logAudit(req, 'SUSPICIOUS_LOGOUT_ATTEMPT', null, { reason: 'invalid-token' });
      }
    }
    const isProd = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production'
      || !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
    const cookieDomain = isProd ? (process.env.ADMIN_COOKIE_DOMAIN || '.newspulse.co.in') : undefined;
    const opts = cookieDomain ? { path: '/', domain: cookieDomain } : { path: '/' };
    res.clearCookie('np_admin', opts);
    res.clearCookie('np_admin_token', opts);
    res.clearCookie('np_admin_email', opts);
    res.clearCookie('np_admin_session', opts);
  } catch (_) {}
  return res.status(200).json({ ok: true });
});

// GET /api/admin/health
router.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    service: 'admin-backend',
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Optional: GET /api/admin/system/health
router.get('/system/health', (_req, res) => {
  return res.json({
    ok: true,
    status: 'healthy',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// PROTECTED: everything below
// ─────────────────────────────────────────────

router.use((req, res, next) => {
  // Legacy namespace: let server.js handle /admin/* (tests rely on /admin/login, /admin/refresh, /admin/metrics).
  // Exiting the router here prevents this file from shadowing those handlers.
  if (req.baseUrl === '/admin') return next('router');
  if (req.path === '/viral-videos' || req.path.startsWith('/viral-videos/')) return next('router');
  if (req.path === '/seed-founder' || req.path === '/bootstrap-founder') return next('router');
  return requireAdminAuth(req, res, next);
});

// GET /api/admin/me
router.get('/me', (req, res) => {
  const a = req.admin || null;
  if (!a) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  return res.status(200).json({
    ok: true,
    authenticated: true,
    admin: {
      id: a.id || 'unknown',
      email: a.email || '',
      role: String(a.role || '').toLowerCase(),
    },
  });
});

// GET /api/admin/stats
router.get('/stats', (_req, res) => {
  const readyState = mongoose?.connection?.readyState;
  const dbConnected = readyState === 1;
  const dbName = dbConnected && mongoose?.connection?.name ? String(mongoose.connection.name) : null;

  const systemHealth = {
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  };
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: dbConnected ? 'System stats fetched' : 'System stats fetched (DB unavailable)',
    data: {
      systemHealth,
      db: {
        connected: dbConnected,
        readyState: typeof readyState === 'number' ? readyState : -1,
        ...(dbName ? { name: dbName } : {}),
      },
    },
  });
});

// GET /api/admin/reporters
router.get('/reporters', listReporters);

// GET /api/admin/community/reporters (analytics)
router.get('/community/reporters', getCommunityReporterAnalytics);

// GET /api/admin/community/stats
router.get('/community/stats', getCommunityStats);

// GET /api/admin/community/settings
router.get('/community/settings', getAdminCommunitySettings);

// PATCH /api/admin/community/settings (founder only)
router.patch('/community/settings', requireFounderAuth, patchAdminCommunitySettings);

// GET /api/admin/feature-toggles
router.get('/feature-toggles', getCommunityFeatureToggles);

// PATCH /api/admin/feature-toggles
router.patch('/feature-toggles', updateCommunityFeatureToggles);

module.exports = router;
