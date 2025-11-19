const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const state = require('./lib/state');
const newsRoutes = require('./routes/news');
// const alertsRoutes = require('./routes/alerts');
const aiActivityLog = require('./routes/safezone/aiActivityLog');
const systemHealth = require('./routes/system/health');
const monitorHub = require('./routes/system/monitorHub');
const aiTrainingInfo = require('./routes/system/aiTrainingInfo');
const adminAuth = require('./routes/adminAuth');
const reportsExport = require('./routes/reports/export');

dotenv.config(); // Load environment variables from .env file

const app = express();
const server = http.createServer(app);

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
connectWithRetry();

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

// Simple in-memory rate limiter for login (IP based)
const loginRateLimit = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxAttempts: 20,
  attempts: new Map(), // key: ip, value: { count, firstAttemptTs }
};

function isRateLimited(ip) {
  const now = Date.now();
  const record = loginRateLimit.attempts.get(ip);
  if (!record) return false;
  if (now - record.firstAttemptTs > loginRateLimit.windowMs) {
    loginRateLimit.attempts.delete(ip);
    return false;
  }
  return record.count >= loginRateLimit.maxAttempts;
}

function registerAttempt(ip) {
  const now = Date.now();
  const record = loginRateLimit.attempts.get(ip);
  if (!record) {
    loginRateLimit.attempts.set(ip, { count: 1, firstAttemptTs: now });
  } else if (now - record.firstAttemptTs > loginRateLimit.windowMs) {
    loginRateLimit.attempts.set(ip, { count: 1, firstAttemptTs: now });
  } else {
    record.count += 1;
  }
}

app.post('/admin/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, message: 'Too many login attempts. Please wait and try again.' });
  }
  registerAttempt(ip);

  const { email = '', password = '' } = req.body || {};
  const ok =
    (process.env.FOUNDER_EMAIL || '').toLowerCase() === String(email).toLowerCase() &&
    (process.env.FOUNDER_PASSWORD || '') === String(password);
  if (ok) {
    const id = process.env.FOUNDER_ID || 'founder-1';
    const name = process.env.FOUNDER_NAME || 'Founder';
    const role = 'founder';
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const payload = { sub: id, email, name, role };
    const token = jwt.sign(payload, secret, { expiresIn: '7d' });
    return res.json({ success: true, token, user: { id, email, name, role } });
  }
  return res.status(401).json({ success: false, user: null, message: 'Invalid credentials' });
});

app.get('/system/ai-training-info', (_req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: new Date().toISOString() });
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

tryListen(BASE_PORT);
