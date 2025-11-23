const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const User = require('./models/User');
const RefreshToken = require('./models/RefreshToken');
const ActivityLog = require('./models/ActivityLog');
const state = require('./lib/state');
const newsRoutes = require('./routes/news');
const alertsRoutes = require('./routes/alerts');
const securityRoutes = require('./routes/security');
const aiActivityLog = require('./routes/safezone/aiActivityLog');
const systemHealth = require('./routes/system/health');
const aiHealth = require('./routes/system/aiHealth');
const monitorHub = require('./routes/system/monitorHub');
const aiTrainingInfo = require('./routes/system/aiTrainingInfo');
const emailTest = require('./routes/system/emailTest');
const adminAuth = require('./routes/adminAuth');
const adminThreatRoutes = require('./routes/adminThreatRoutes');
const reportsExport = require('./routes/reports/export');
const dashboardStats = require('./routes/dashboardStats');
const News = require('./models/News');
const authOtp = require('./routes/authOtp');
const communityRoutes = require('./routes/community');
const adminCommunityRoutes = require('./routes/adminCommunity');
const adminCommunityReporterRoutes = require('./routes/adminCommunityReporter');
const communityReporterRoutes = require('./routes/communityReporter');

dotenv.config(); // Load environment variables from .env file

const app = express();
const server = http.createServer(app);
const startTime = Date.now();

// Initialize mailer early to surface configuration issues in logs at startup.
try {
  const { getTransporter } = require('./lib/mailer');
  const tx = getTransporter();
  if (!tx) {
    console.warn('[MAILER][startup] Transporter not initialized (missing SMTP env vars).');
  }
} catch (e) {
  console.error('[MAILER][startup-error]', e?.message || e);
}

// Optional Redis connection for distributed rate limiting
let redisClient = null;
const REDIS_URL = process.env.REDIS_URL || '';
if (REDIS_URL) {
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (e) => console.error('Redis error:', e?.message || e));
    redisClient.connect().then(() => console.log('✅ Redis connected')).catch(err => console.error('❌ Redis connect failed:', err?.message || err));
  } catch (e) {
    console.warn('⚠️  Redis not initialized (missing dependency or connection issue). Falling back to in-memory limiter.');
  }
}

// Middleware
// Centralized CORS configuration (env-driven + sane defaults)
// Default allowed origins always include localhost dev port 5173 for Vite.
const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'https://admin.newspulse.co.in',
  'https://newspulse-frontend-main.vercel.app',
];
// Allow overriding via CORS_ALLOWED_ORIGINS (comma-separated)
const extraOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
const allowList = new Set([...defaultOrigins, ...extraOrigins]);

// Preview pattern for Vercel deployments of the admin panel
const vercelPreviewPattern = /https:\/\/newspulse-admin-panel-real-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/i;
const genericVercelPattern = /https:\/\/[a-z0-9-]+\.vercel\.app$/i; // fallback (optional)

const dynamicCors = cors({
  origin: (origin, callback) => {
    // Non-browser requests (curl/Postman) -> allow
    if (!origin) return callback(null, true);
    const explicit = allowList.has(origin);
    const matchesPreview = vercelPreviewPattern.test(origin);
    const matchesGeneric = (process.env.CORS_ALLOW_GENERIC_VERCEL === '1') && genericVercelPattern.test(origin);
    const localhostDev = /http:\/\/localhost:51\d{2}$/i.test(origin);
    const adminDomain = /admin\.newspulse\.co\.in$/i.test(origin);
    const ok = explicit || matchesPreview || matchesGeneric || localhostDev || adminDomain;
    if (ok) return callback(null, true);
    console.warn('[CORS][block]', origin);
    return callback(new Error('CORS: Origin not allowed: ' + origin), false);
  },
  credentials: true,
});
app.use(dynamicCors);
// Ensure preflight responses include CORS headers
app.options('*', dynamicCors);

app.use(express.json()); // Parse incoming JSON requests
app.use(cookieParser());

// MongoDB Connection (resilient: don't crash app if DB is temporarily unreachable)
const rawMongoUri = (process.env.MONGO_URI || '').trim();
const connectWithRetry = async (delayMs = 30000) => {
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.warn('⚠️  MONGO_URI not set. API will run with limited functionality.');
    return;
  }
  // Allow skipping DB in local/dev with MONGO_URI=skip|none|disabled
  if (/^(skip|none|disable|disabled)$/i.test(uri)) {
    console.warn('⏭️  MongoDB connection disabled by MONGO_URI flag. Running without DB.');
    return;
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    const preview = uri.length > 12 ? uri.slice(0, 12) + '…' : uri;
    console.error(`❌ Invalid MONGO_URI scheme: "${preview}". Expected it to start with "mongodb://" or "mongodb+srv://". Will retry.`);
    setTimeout(() => connectWithRetry(delayMs), delayMs);
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error (will retry):', err?.message || err);
    setTimeout(() => connectWithRetry(delayMs), delayMs);
  }
};
if (process.env.NODE_ENV !== 'test') {
  connectWithRetry();
}

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🎉 News Pulse Backend is Live!');
});

// CHANGE: Root-level admin routes that always return JSON and never crash
app.get('/admin/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/admin-auth/session', (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : '';
    if (!token) return res.json({ success: false, user: null });

    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const payload = jwt.verify(token, secret);
    const user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
    return res.json({ success: true, user });
  } catch (err) {
    return res.json({ success: false, user: null });
  }
});

// Rate limiting (in-memory fallback or Redis-backed)
const loginRateLimit = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 20,
  attempts: new Map(),
};

async function isRateLimited(ip) {
  const now = Date.now();
  if (redisClient) {
    const key = `login:attempts:${ip}`;
    const count = parseInt(await redisClient.get(key) || '0', 10);
    return count >= loginRateLimit.maxAttempts;
  }
  const record = loginRateLimit.attempts.get(ip);
  if (!record) return false;
  if (now - record.firstAttemptTs > loginRateLimit.windowMs) {
    loginRateLimit.attempts.delete(ip);
    return false;
  }
  return record.count >= loginRateLimit.maxAttempts;
}

async function registerAttempt(ip) {
  const now = Date.now();
  if (redisClient) {
    const key = `login:attempts:${ip}`;
    const exists = await redisClient.exists(key);
    const count = parseInt(await redisClient.incr(key), 10);
    if (!exists) {
      await redisClient.pexpire(key, loginRateLimit.windowMs);
    }
    return count;
  }
  const record = loginRateLimit.attempts.get(ip);
  if (!record || now - record.firstAttemptTs > loginRateLimit.windowMs) {
    loginRateLimit.attempts.set(ip, { count: 1, firstAttemptTs: now });
    return 1;
  } else {
    record.count += 1;
    return record.count;
  }
}

// Token TTL configuration
const ACCESS_TOKEN_TTL_MINUTES = parseInt(process.env.ACCESS_TOKEN_TTL_MINUTES || '15', 10);
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);
const refreshStore = new Map(); // key: refreshToken -> { sub, exp }

function minutesToSeconds(m) { return m * 60; }
function daysToSeconds(d) { return d * 86400; }

// ADMIN LOGIN ROUTE (currently used by frontend):
// POST /admin/login
// FINAL FOUNDER LOGIN ENDPOINT:
// POST /admin/login
app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    console.log('[ADMIN_LOGIN][attempt]', { emailProvided: !!email, bodyKeys: Object.keys(req.body || {}) });

    const founderEmail = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
    const founderPassword = process.env.FOUNDER_PASSWORD || '';
    const candidateEmail = (email || '').trim().toLowerCase();
    const candidatePassword = password || '';

    if (!candidateEmail || !candidatePassword) {
      console.warn('[ADMIN_LOGIN][missing-fields]', { candidateEmail, hasPassword: !!candidatePassword });
      return res.status(400).json({ ok: false, success: false, message: 'Email and password are required' });
    }

    if ((process.env.LOG_LOGIN_DEBUG || 'false') === 'true') {
      console.log('[ADMIN_LOGIN][debug]', {
        candidateEmail,
        candidatePasswordLength: candidatePassword.length,
        founderEmail,
        founderPasswordLength: (founderPassword || '').length,
        jwtSecretPresent: Boolean(process.env.JWT_SECRET),
        nodeEnv: process.env.NODE_ENV,
      });
    }

    if (!founderEmail || !founderPassword) {
      console.error('[ADMIN_LOGIN][env-missing]', { founderEmailPresent: !!founderEmail, founderPasswordPresent: !!founderPassword });
      return res.status(500).json({ ok: false, success: false, message: 'Admin credentials not configured' });
    }

    if (candidateEmail !== founderEmail || candidatePassword !== founderPassword) {
      console.warn('[ADMIN_LOGIN][invalid-creds]', { candidateEmail });
      return res.status(401).json({ ok: false, success: false, message: 'Invalid email or password' });
    }

    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const ACCESS_MIN = ACCESS_TOKEN_TTL_MINUTES;
    const REFRESH_DAYS = REFRESH_TOKEN_TTL_DAYS;
    const userId = process.env.FOUNDER_ID || 'founder-001';
    const name = process.env.FOUNDER_NAME || 'Founder';

    let accessToken = null;
    let refreshToken = null;
    try {
      const accessPayload = { sub: userId, email: founderEmail, name, role: 'founder', type: 'access' };
      const refreshPayload = { sub: userId, email: founderEmail, name, role: 'founder', type: 'refresh' };
      accessToken = jwt.sign(accessPayload, secret, { expiresIn: `${ACCESS_MIN}m` });
      refreshToken = jwt.sign(refreshPayload, secret, { expiresIn: `${REFRESH_DAYS}d` });
      const expiresAt = new Date(Date.now() + daysToSeconds(REFRESH_DAYS) * 1000);
      try { await RefreshToken.storeToken(userId, refreshToken, expiresAt); } catch (_) {}
      const cookieSecure = (process.env.SECURE_COOKIE || 'true') === 'true';
      res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/admin/refresh', expires: expiresAt });
    } catch (e) {
      console.warn('[ADMIN_LOGIN][token-issue]', e?.message || e);
    }

    return res.json({
      ok: true,
      success: true,
      user: { id: userId, email: process.env.FOUNDER_EMAIL, name, role: 'founder' },
      accessToken,
      refreshToken,
      accessExpiresInMinutes: accessToken ? ACCESS_MIN : undefined,
      refreshExpiresInDays: refreshToken ? REFRESH_DAYS : undefined,
    });
  } catch (err) {
    console.error('[ADMIN_LOGIN][error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Internal server error' });
  }
});

app.post('/admin/refresh', async (req, res) => {
  const cookieToken = req.cookies?.refreshToken;
  const bodyToken = req.body?.refreshToken;
  const refreshToken = cookieToken || bodyToken || '';
  if (!refreshToken) return res.status(401).json({ success: false, message: 'Missing refresh token' });
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const payload = jwt.verify(refreshToken, secret);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');
    let userDoc = null;
    try { userDoc = await User.findById(payload.sub); } catch (_) {}
    if (!userDoc) {
      // Fallback for test mode: synthesize user from payload when DB not available
      if (process.env.NODE_ENV === 'test') {
        userDoc = { _id: payload.sub, email: payload.email, name: payload.name, role: payload.role };
      } else {
        throw new Error('User missing');
      }
    }
    const dbReady = mongoose.connection?.readyState === 1;
    let newRefreshToken = null;
    if (dbReady) {
      const stored = await RefreshToken.findByToken(refreshToken);
      if (!stored || stored.rotatedAt) throw new Error('Token invalid');
      if (new Date() > stored.expiresAt) throw new Error('Token expired');
      stored.rotatedAt = new Date();
      await stored.save();
      const newRefreshPayload = { sub: userDoc._id.toString(), email: userDoc.email, name: userDoc.name, role: userDoc.role, type: 'refresh' };
      newRefreshToken = jwt.sign(newRefreshPayload, secret, { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` });
      const expiresAt = new Date(Date.now() + daysToSeconds(REFRESH_TOKEN_TTL_DAYS) * 1000);
      try { await RefreshToken.storeToken(userDoc._id, newRefreshToken, expiresAt); } catch (_) {}
      const cookieSecure = (process.env.SECURE_COOKIE || 'true') === 'true';
      res.cookie('refreshToken', newRefreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/admin/refresh', expires: expiresAt });
      try { await ActivityLog.create({ type: 'refresh', email: userDoc.email, meta: { rotated: true } }); } catch (_) {}
    } else if (process.env.NODE_ENV !== 'test') {
      // In non-test mode, lack of DB is treated as failure
      throw new Error('DB unavailable');
    }
    const accessPayload = { sub: userDoc._id.toString(), email: userDoc.email, name: userDoc.name, role: userDoc.role, type: 'access' };
    const accessToken = jwt.sign(accessPayload, secret, { expiresIn: `${ACCESS_TOKEN_TTL_MINUTES}m` });
    return res.json({ success: true, accessToken, user: { id: userDoc._id.toString(), email: userDoc.email, name: userDoc.name, role: userDoc.role }, accessExpiresInMinutes: ACCESS_TOKEN_TTL_MINUTES, rotated: Boolean(newRefreshToken) });
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Refresh failed' });
  }
});

app.get('/system/ai-training-info', (_req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: new Date().toISOString() });
});

// Dashboard stats routes (root-level, no /api prefix)
app.use('/', dashboardStats);
// Aliases for admin stats endpoints expected by frontend
app.get('/admin/stats', async (req, res) => {
  try {
    // Reuse dashboardStats logic via internal fetch to /stats path
    // Directly build minimal stats here to avoid extra request
    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load admin stats' });
  }
});
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load admin stats' });
  }
});

// Settings load endpoint alias
app.get('/settings/load', (req, res) => {
  const founderEmail = (process.env.FOUNDER_EMAIL || '').trim();
  const uiFlags = {
    otpEnabled: true,
    aiHealthPath: '/system/ai-health',
  };
  return res.json({ ok: true, settings: { founderEmail: founderEmail || null, uiFlags, timestamp: new Date().toISOString() } });
});

// Articles listing alias (frontend expects /articles not /api/news)
app.get('/articles', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const sortRaw = (req.query.sort || '-date').toString();
    const sort = {};
    // support -field for desc
    sortRaw.split(',').forEach(part => {
      part = part.trim();
      if (!part) return;
      if (part.startsWith('-')) {
        sort[part.slice(1)] = -1;
      } else {
        sort[part] = 1;
      }
    });
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      News.find({}).sort(sort).skip(skip).limit(limit).lean(),
      News.countDocuments({}),
    ]);
    return res.json({ ok: true, page, limit, total, items });
  } catch (e) {
    console.error('[articles] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load articles' });
  }
});
// API alias for articles
app.get('/api/articles', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const sortRaw = (req.query.sort || '-date').toString();
    const sort = {};
    sortRaw.split(',').forEach(part => {
      part = part.trim();
      if (!part) return;
      if (part.startsWith('-')) sort[part.slice(1)] = -1; else sort[part] = 1;
    });
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      News.find({}).sort(sort).skip(skip).limit(limit).lean(),
      News.countDocuments({}),
    ]);
    return res.json({ ok: true, page, limit, total, items });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load articles' });
  }
});

// OTP routes: legacy + generalized + admin-scoped
// Legacy absolute: /auth/otp/* (kept for existing SPA calls)
app.use('/', authOtp);
// Generic API absolute: /api/auth/otp/*
app.use('/api', authOtp);
// Admin-scoped standardized path: /api/admin/auth/otp/* (via relative handlers)
app.use('/api/admin/auth/otp', authOtp);
// Explicit mount so relative handlers map to /auth/otp/* (frontend expectation)
app.use('/auth/otp', authOtp);
// Admin panel expected path prefix for OTP (final -> /admin-api/auth/otp/...)
app.use('/admin-api/auth/otp', authOtp);

app.get('/admin/metrics', async (req, res) => {
  const uptimeSec = Math.round((Date.now() - startTime) / 1000);
  let redisMode = false;
  if (redisClient) {
    redisMode = true;
  }
  // Basic snapshot of in-memory attempts size (not exposing IP list for privacy)
  const inMemoryActiveKeys = loginRateLimit.attempts.size;
  res.json({
    success: true,
    uptimeSeconds: uptimeSec,
    activeUsers: state.activeUsers || 0,
    rateLimit: {
      windowMs: loginRateLimit.windowMs,
      maxAttempts: loginRateLimit.maxAttempts,
      backend: redisMode ? 'redis' : 'memory',
      inMemoryTracked: inMemoryActiveKeys,
    },
    tokens: {
      accessTtlMinutes: ACCESS_TOKEN_TTL_MINUTES,
      refreshTtlDays: REFRESH_TOKEN_TTL_DAYS,
      refreshStoreSize: refreshStore.size,
    },
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/news', newsRoutes);
// Alias for frontend direct /news access (Back to News button)
app.use('/news', newsRoutes);
// Smart Alerts settings endpoints
app.use('/api/alerts', alertsRoutes);
// Security & Lockdown endpoints
app.use('/api/security', securityRoutes);
app.use('/api/ai-activity-log', aiActivityLog);
// Health endpoints (API + compatibility aliases)
app.use('/api/system/health', systemHealth);
app.use('/api/health', systemHealth); // legacy alias
app.use('/system/health', systemHealth); // supports rewrite from /admin-api/system/health

// AI health endpoints (API + non-/api alias)
app.use('/api/system/ai-health', aiHealth);
app.use('/system/ai-health', aiHealth);
app.use('/api/system/monitor-hub', monitorHub);
// Non-/api alias for monitor hub stats (frontend direct call compatibility)
app.use('/system/monitor-hub', monitorHub);
app.use('/api/system/ai-training-info', aiTrainingInfo);
// Non-/api alias for AI training info (frontend direct call compatibility)
app.use('/system/ai-training-info', aiTrainingInfo);
// Email test route (configuration + send test email)
app.use('/api/system/email-test', emailTest);
app.use('/system/email-test', emailTest);
app.use('/api/admin-auth', adminAuth);
// Mount under /api/admin as well so POST /api/admin/login resolves
app.use('/api/admin', adminAuth);
// Threat dashboard mock stats
app.use('/api/admin', adminThreatRoutes);
// Threat stats dashboard aliases so frontend calls to /api/dashboard/threat-stats work
app.use('/api/dashboard', adminThreatRoutes);
app.use('/dashboard', adminThreatRoutes);
// Non-/api alias so POST /admin/login works (SPA expectation)
app.use('/admin', adminAuth);
app.use('/api/reports/export', reportsExport);
// Community submission public API
app.use('/api/community', communityRoutes);
// Phase 1 Community Reporter public API
app.use('/api/community-reporter', communityReporterRoutes);
// Admin community management (protected)
app.use('/api/admin/community', adminCommunityRoutes);
// New Phase 1 Community Reporter admin queue endpoints
app.use('/api/admin/community-reporter', adminCommunityReporterRoutes);
// Non-/api alias consumed by admin panel: /admin/community-reporter/submissions
app.use('/admin/community-reporter', adminCommunityReporterRoutes);

// --- Compatibility alias (non-/api) for local dev code accidentally hitting /admin-auth/session
// Provides a lightweight session probe identical to /api/admin-auth/session so CORS preflight succeeds.
app.get('/admin-auth/session', (req, res) => {
  // Mirror logic from routes/adminAuth.js
  const rawAuth = String(req.headers['authorization'] || '');
  const bearer = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : '';
  const cookieHeader = req.headers.cookie || '';
  let email = '';
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k === 'np_admin') email = decodeURIComponent(v.join('=') || '');
  });
  if (bearer || email) {
    const userEmail = email || 'admin@newspulse.ai';
    return res.json({ ok: true, authenticated: true, email: userEmail, user: { id: 'self', email: userEmail, role: 'admin' } });
  }
  return res.status(401).json({ ok: false, authenticated: false });
});

// Socket.IO for realtime active user count
const io = new Server(server, {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  cors: {
    origin: [
      'http://localhost:3000',
      'https://newspulse-frontend-main.vercel.app',
      'https://admin.newspulse.co.in',
    ],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  state.activeUsers = (state.activeUsers || 0) + 1;
  io.emit('activeUserCount', state.activeUsers);

  socket.on('disconnect', () => {
    state.activeUsers = Math.max(0, (state.activeUsers || 0) - 1);
    io.emit('activeUserCount', state.activeUsers);
  });
});

// JSON 404 handler (after all routes)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    success: false,
    status: 404,
    message: 'Route not found',
    path: req.originalUrl,
  });
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res
    .status(500)
    .json({ message: 'Something went wrong, please try again later.' });
});

// Start the server with port fallback logic
const BASE_PORT = parseInt(process.env.PORT, 10) || 10000;
const MAX_PORT_SEARCH = 5; // will try BASE_PORT..BASE_PORT+4

function tryListen(port, attempt = 1) {
  server.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_SEARCH) {
      console.warn(`⚠️  Port ${port} in use. Trying ${port + 1}...`);
      tryListen(port + 1, attempt + 1);
    } else {
      console.error('❌ Failed to start server:', err.message || err);
      process.exit(1);
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  tryListen(BASE_PORT);
} else {
  console.log('🧪 Test mode: skipping server listen & Mongo retries');
}

module.exports = app;
