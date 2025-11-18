const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
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
  res.json({ authenticated: false });
});

app.post('/admin/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const ok =
    (process.env.FOUNDER_EMAIL || '').toLowerCase() === String(email).toLowerCase() &&
    (process.env.FOUNDER_PASSWORD || '') === String(password);
  if (ok) return res.json({ ok: true, user: { email } });
  return res.status(401).json({ ok: false, message: 'Invalid credentials' });
});

app.get('/system/ai-training-info', (_req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
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

// Start the server
// CHANGE: use PORT with fallback 10000 and log it
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
