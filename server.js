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
// const alertsRoutes = require('./routes/alerts');
const aiActivityLog = require('./routes/safezone/aiActivityLog');
const systemHealth = require('./routes/system/health');
const monitorHub = require('./routes/system/monitorHub');
const aiTrainingInfo = require('./routes/system/aiTrainingInfo');
const adminAuth = require('./routes/adminAuth');
const reportsExport = require('./routes/reports/export');
const dashboardStats = require('./routes/dashboardStats');
const authOtp = require('./routes/authOtp');

dotenv.config(); // Load environment variables from .env file

const app = express();
const server = http.createServer(app);
const startTime = Date.now();

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
// CHANGE: CORS allow only localhost:5173 and admin.newspulse.co.in, with credentials + OPTIONS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = origin === 'http://localhost:5173' || origin === 'https://admin.newspulse.co.in';
    return allowed ? callback(null, true) : callback(new Error(`CORS: origin not allowed -> ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions)); // CHANGE
app.options('*', cors(corsOptions)); // CHANGE: handle preflight requests

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
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    const preview = uri.length > 12 ? uri.slice(0, 12) + '…' : uri;
    console.error(`❌ Invalid MONGO_URI scheme: "${preview}". Expected it to start with "mongodb://" or "mongodb+srv://". Will retry.`);
    setTimeout(() => connectWithRetry(delayMs), delayMs);
    return;
  }
  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
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
  const { email, password } = req.body || {};

  const founderEmail = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
  const founderPassword = process.env.FOUNDER_PASSWORD || '';
  const candidateEmail = (email || '').trim().toLowerCase();
  const candidatePassword = password || '';

  if (!candidateEmail || !candidatePassword) {
    return res.status(400).json({ ok: false, success: false, message: 'Email and password are required' });
  }

  if (candidateEmail !== founderEmail || candidatePassword !== founderPassword) {
    return res.status(401).json({ ok: false, success: false, message: 'Invalid email or password' });
  }

  // Optional: issue tokens using existing JWT secret & TTLs.
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
    // Persist refresh token only if model/schema available (defensive try)
    try {
      await RefreshToken.create({ user: userId, token: refreshToken, expiresAt });
    } catch (_) {}
    const cookieSecure = (process.env.SECURE_COOKIE || 'true') === 'true';
    res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/admin/refresh', expires: expiresAt });
  } catch (e) {
    // If token creation fails, still allow login per spec (omit tokens)
    console.warn('Founder login token issuance failed (continuing without tokens):', e?.message || e);
  }

  return res.json({
    ok: true,
    success: true,
    user: {
      id: userId,
      email: process.env.FOUNDER_EMAIL,
      name,
      role: 'founder',
    },
    accessToken,
    refreshToken,
    accessExpiresInMinutes: accessToken ? ACCESS_MIN : undefined,
    refreshExpiresInDays: refreshToken ? REFRESH_DAYS : undefined,
  });
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
    const stored = await RefreshToken.findOne({ token: refreshToken });
    if (!stored || stored.rotatedAt) throw new Error('Token invalid');
    if (new Date() > stored.expiresAt) throw new Error('Token expired');
    const user = await User.findById(payload.sub);
    if (!user) throw new Error('User missing');
    // Rotate
    stored.rotatedAt = new Date();
    await stored.save();
    const newRefreshPayload = { sub: user._id.toString(), email: user.email, name: user.name, role: user.role, type: 'refresh' };
    const newRefreshToken = jwt.sign(newRefreshPayload, secret, { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` });
    const expiresAt = new Date(Date.now() + daysToSeconds(REFRESH_TOKEN_TTL_DAYS) * 1000);
    await RefreshToken.create({ user: user._id, token: newRefreshToken, expiresAt });
    const cookieSecure = (process.env.SECURE_COOKIE || 'true') === 'true';
    res.cookie('refreshToken', newRefreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/admin/refresh', expires: expiresAt });
    const accessPayload = { sub: user._id.toString(), email: user.email, name: user.name, role: user.role, type: 'access' };
    const accessToken = jwt.sign(accessPayload, secret, { expiresIn: `${ACCESS_TOKEN_TTL_MINUTES}m` });
    await ActivityLog.create({ type: 'refresh', email: user.email, meta: { rotated: true } });
    return res.json({ success: true, accessToken, user: { id: user._id.toString(), email: user.email, name: user.name, role: user.role }, accessExpiresInMinutes: ACCESS_TOKEN_TTL_MINUTES });
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Refresh failed' });
  }
});

app.get('/system/ai-training-info', (_req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: new Date().toISOString() });
});

// Dashboard stats routes (root-level, no /api prefix)
app.use('/', dashboardStats);

// OTP routes: legacy + generalized + admin-scoped
// Legacy absolute: /auth/otp/* (kept for existing SPA calls)
app.use('/', authOtp);
// Generic API absolute: /api/auth/otp/*
app.use('/api', authOtp);
// Admin-scoped standardized path: /api/admin/auth/otp/* (via relative handlers)
app.use('/api/admin/auth/otp', authOtp);

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
// app.use('/api/alerts', alertsRoutes); // Disabled: alerts route file not present on Render
app.use('/api/ai-activity-log', aiActivityLog);
app.use('/api/system/health', systemHealth);
// Optional compatibility path
app.use('/api/health', systemHealth);
app.use('/api/system/monitor-hub', monitorHub);
app.use('/api/system/ai-training-info', aiTrainingInfo);
app.use('/api/admin-auth', adminAuth);
app.use('/api/reports/export', reportsExport);

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
