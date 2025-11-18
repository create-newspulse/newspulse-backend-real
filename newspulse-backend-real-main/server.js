const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const newsRoutes = require('./routes/news');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require('./routes/adminAuth');
const aiTrainingInfoRoutes = require('./routes/system/aiTrainingInfo');

dotenv.config(); // Load environment variables from .env file

const app = express();

// Middleware
// CORS: allow local dev, production admin UI, and Vercel previews
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://newspulse-frontend-main.vercel.app',
  'https://admin.newspulse.co.in',
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

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/newsdb';

mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log(`✅ MongoDB connected to ${MONGO_URI}`))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    console.error('⚠️  Server running without database. Update MONGO_URI in .env or start local MongoDB.');
    console.error('   Tip: docker run --name newspulse-mongo -p 27017:27017 -d mongo:6');
  });

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🟢 News Pulse Admin Backend is Live');
});

// API Routes
app.use('/api/news', newsRoutes);
// Admin routes mounted at ROOT-level paths (no extra /api prefix)
app.use('/admin', adminRoutes); // POST /admin/login
app.use('/admin-auth', adminAuthRoutes); // GET /admin-auth/session
app.use('/system/ai-training-info', aiTrainingInfoRoutes); // GET /system/ai-training-info

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
