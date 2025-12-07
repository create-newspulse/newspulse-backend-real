const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
// Note: Avoiding external 'cors' package per request

const newsRoutes = require('./routes/news');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require('./routes/adminAuth');
const aiTrainingInfoRoutes = require('./routes/system/aiTrainingInfo');
const systemHealthRoutes = require('./routes/system/health');
const communityRoutes = require('./routes/community');
const adminCommunityRoutes = require('./routes/adminCommunity');
const communityAdminContactsRoutes = require('./routes/communityAdminContacts');
const communityReporterRoutes = require('./routes/communityReporterRoutes');
const adminSettingsRoutes = require('./routes/adminSettings');
const communityReporterSettingsRouter = require('./routes/adminSettings/communityReporterSettings');
const CommunitySubmission = require('./models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require('./routes/ai'); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require('./routes/feed'); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }

dotenv.config(); // Load environment variables from .env file

const app = express();

// --- Global CORS (clean setup for admin panel) ---
const allowedOrigins = [
  'http://localhost:5173',
  'https://admin.newspulse.co.in',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Preflight support
app.options('*', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
// Targeted preflight for key endpoints
app.options('/system/ai-training-info', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.options('/api/admin/community/*', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
// --- END Global CORS ---

/**
 * CORS SETUP
 * ----------
 * - Allow localhost / 127.0.0.1 (any port) for dev (Expo, web, etc.)
 * - Allow your production domains
 * - Allow Vercel previews (*.vercel.app)
 */

// Global CORS handled above via 'cors' package

// Parse incoming JSON requests
app.use(express.json());

// Lightweight system endpoints (placed early, before any 404 handlers)
app.get('/system/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    env: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
  });
});

app.get('/system/ai-training-info', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString(),
  });
});

// MongoDB Connection (require explicit MONGO_URI, no localhost fallback)
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.warn('⚠️ MONGO_URI is not set correctly; starting server without DB connection for now.');
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
    });
}

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🟢 News Pulse Admin Backend is Live');
});

// API Routes
app.use('/api/news', newsRoutes);
app.use('/api/community', communityRoutes); // POST /api/community/submissions (public)
// Community Reporter public endpoints (submit, my-stories)
app.use('/api/community-reporter', communityReporterRoutes);
// Admin routes mounted at both legacy root and new /api/admin paths where required.
app.use('/admin', adminRoutes); // legacy POST /admin/login
app.use('/admin-auth', adminAuthRoutes); // legacy GET /admin-auth/session
app.use('/system/ai-training-info', aiTrainingInfoRoutes); // GET /system/ai-training-info
app.use('/api/system/ai-training-info', aiTrainingInfoRoutes); // GET /api/system/ai-training-info
// Health endpoints (API + compatibility alias)
app.use('/api/system/health', systemHealthRoutes);
app.use('/system/health', systemHealthRoutes);
// New admin community reporter + identity endpoints
app.use('/api/admin/community', adminCommunityRoutes);
// Admin Settings
app.use('/api/admin', adminSettingsRoutes);
app.use('/admin-api/admin', adminSettingsRoutes);
// Community Reporter Settings (mount admin router)
app.use('/api/admin', communityReporterSettingsRouter);
// Optional feeds and AI routes
if (aiRoutes) app.use('/api/ai', aiRoutes);
if (feedRoutes) app.use('/api/feed', feedRoutes);
// Mount reporter contacts + stories under same path for Admin Panel compatibility
app.use('/api/admin/community', communityAdminContactsRoutes);
// Admin API proxy alias (frontend often proxies /admin-api/* with auth header)
app.use('/admin-api/admin/community', communityAdminContactsRoutes);
// Non-/api alias (Admin Panel calls /admin/community/* directly)
app.use('/admin/community', communityAdminContactsRoutes);

// Explicit compatibility alias: ensure GET /admin/community/journalist-applications resolves even if router order changes
app.get('/admin/community/journalist-applications', requireAdminAuth, (req, res, next) => {
  try {
    req.url = '/journalist-applications';
    return communityAdminContactsRoutes(req, res, next);
  } catch (e) {
    console.error('[nested][ALIAS][journalist-applications] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});

// Fallback direct handlers (defensive) in case router mounting order changes upstream
app.get('/admin/community/reporter-contacts', requireAdminAuth, async (req, res, next) => {
  if (res.headersSent) return next();
  // Delegate to router if it has the path
  if (communityAdminContactsRoutes) return next();
  return res.json({ ok: true, items: [], total: 0 });
});

app.get('/admin/community/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKeyRaw = (req.query.reporterKey || '').toString().trim();
    if (!reporterKeyRaw) return res.status(400).json({ ok: false, message: 'Missing reporterKey' });
    const reporterKey = reporterKeyRaw.toLowerCase();
    const pageNum = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const status = (req.query.status || '').toString().trim();

    const baseFilter = {
      $or: [
        { reporterEmail: reporterKey },
        { 'contact.email': reporterKey },
        { email: reporterKey },
      ],
    };
    if (status && status !== 'all') {
      baseFilter.$and = (baseFilter.$and || []).concat([{ status }]);
    }

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(baseFilter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      CommunitySubmission.countDocuments(baseFilter),
    ]);
    const items = docs.map(d => ({
      id: d._id.toString(),
      title: d.headline || '',
      summary: null,
      status: d.status || 'draft',
      language: d.language || 'en',
      category: d.category || null,
      city: (d.location?.city || d.city || d.locationDetail?.city || null),
      createdAt: d.createdAt ? d.createdAt.toISOString() : null,
      updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
      aiRisk: typeof d.riskScore === 'number' ? String(d.riskScore) : null,
      priority: d.priority || null,
    }));
    return res.json({ ok: true, items, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('[ADMIN][reporter-stories] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

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

// Public: GET config (no auth)
// Note: Reading flag via a simple closure; keep in sync if later wired to DB.
let _communityReporterFlagCache = { myCommunityStoriesEnabled: false };
try {
  // Attempt to import router-local state by requiring the router module instance.
  // If the router is reloaded, fallback remains false.
  const _router = communityReporterSettingsRouter;
  // No direct export for state; maintain a local cache overridden by admin POST handlers.
} catch (_) {}
app.get('/api/community-reporter/config', (req, res) => {
  return res.json({
    ok: true,
    communityMyStoriesEnabled: _communityReporterFlagCache.myCommunityStoriesEnabled,
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    // Light debug log of reporter-related routes on startup
    const reporterRoutes = [];
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path && layer.route.path.includes('reporter')) {
        reporterRoutes.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => {
          if (rLayer.route && rLayer.route.path && rLayer.route.path.includes('reporter')) {
            reporterRoutes.push(prefix + rLayer.route.path);
          }
        });
      }
    });
    console.log('[startup][reporter-routes]', reporterRoutes);
  } catch (e) {
    console.warn('[startup][reporter-routes] failed', e?.message || e);
  }
});

function extractPrefix(regexp) {
  try {
    const src = (regexp && regexp.source) || '';
    // Match something like ^\/(admin|api)[^*]*?
    const m = src.match(/\\\/(admin[^\\^]+|api[^\\^]+|system[^\\^]+)\\/i);
    if (m && m[1]) return '/' + m[1];
  } catch (_) {}
  return '';
}

// Debug endpoint to verify reporter routes present (nested instance)
app.get('/_debug/routes', (req, res) => {
  const list = [];
  try {
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path) {
        list.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => {
          if (rLayer.route && rLayer.route.path) list.push(prefix + rLayer.route.path);
        });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Introspection failed', error: e?.message || e });
  }
  return res.json({ ok: true, total: list.length, reporter: list.filter(r => r.includes('reporter')), all: list });
});
