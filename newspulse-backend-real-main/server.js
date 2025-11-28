const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const newsRoutes = require('./routes/news');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require('./routes/adminAuth');
const aiTrainingInfoRoutes = require('./routes/system/aiTrainingInfo');
const communityRoutes = require('./routes/community');
const adminCommunityRoutes = require('./routes/adminCommunity');
const { requireAdminAuth } = require('../middleware/adminAuth');

dotenv.config(); // Load environment variables from .env file

const app = express();

// Middleware
// CORS: allow local dev, production admin UI, and Vercel previews
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://newspulse-frontend-main.vercel.app',
  'https://admin.newspulse.co.in',
  'https://newspulse.co.in',
  'https://www.newspulse.co.in',
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isAllowed =
      allowedOrigins.includes(origin) ||
      origin.toLowerCase().endsWith('.vercel.app');
    if (isAllowed) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};
app.use(cors(corsOptions));

app.use(express.json()); // Parse incoming JSON requests

// MongoDB Connection (require explicit MONGO_URI, no localhost fallback)
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.error('❌ MONGO_URI is not set correctly in .env (or still placeholder).');
  process.exit(1);
}
mongoose
  .connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
  });

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🟢 News Pulse Admin Backend is Live');
});

// API Routes
app.use('/api/news', newsRoutes);
app.use('/api/community', communityRoutes); // POST /api/community/submissions (public)
// Admin routes mounted at both legacy root and new /api/admin paths where required.
app.use('/admin', adminRoutes); // legacy POST /admin/login
app.use('/admin-auth', adminAuthRoutes); // legacy GET /admin-auth/session
app.use('/system/ai-training-info', aiTrainingInfoRoutes); // GET /system/ai-training-info
// New admin community reporter + identity endpoints
app.use('/api/admin/community', adminCommunityRoutes);
app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  const a = req.admin || {};
  return res.json({
    success: true,
    admin: {
      id: a.id || 'unknown',
      email: a.email || '',
      role: a.role || 'admin',
    },
  });
});

// Direct health route safeguard (in case router mounting conflicts)
app.get('/admin/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-backend',
    uptime: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    via: 'direct',
  });
});

// JSON 404 handler (must be after all routes)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    success: false,
    status: 404,
    message: 'Route not found',
    path: req.originalUrl,
  });
});

// JSON error handler (no stack trace leakage)
app.use((err, req, res, next) => {
  try {
    console.error('Error:', err && err.message ? err.message : err, 'path=', req.originalUrl);
  } catch (_) {}
  res.status(500).json({
    ok: false,
    success: false,
    status: 500,
    message: 'Internal server error',
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
