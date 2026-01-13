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
const { getCommunityReporterQueue, listReporterContacts } = require('./controllers/communityReporterController');
const adminSettingsRoutes = require('./routes/adminSettings');
const communityReporterSettingsRouter = require('./routes/adminSettings/communityReporterSettings');
const CommunitySubmission = require('./models/CommunitySubmission');
const News = require('./models/News');
// Team management endpoints (shared root-level router)
let adminTeamRoutes = null;
try { adminTeamRoutes = require('../routes/adminTeam.routes'); } catch (_) { console.warn('[init] optional ../routes/adminTeam.routes not found; skipping'); }
let adminTeamRoutesV2 = null;
try { adminTeamRoutesV2 = require('../src/routes/adminTeamRoutes'); } catch (_) { console.warn('[init] optional ../src/routes/adminTeamRoutes not found; skipping'); }
const { requireAdminAuth } = require('../middleware/adminAuth');
const { optionalAdminAuth } = require('../middleware/optionalAdminAuth');
// Ads + Ad Settings (shared root-level routers)
const publicAdsRouter = require('../routes/publicAds.routes');
const adminAdsRouter = require('../routes/adminAds.routes');
const publicAdSettingsRouter = require('../routes/publicAdSettings.routes');
const adminAdSettingsRouter = require('../routes/adminAdSettings.routes');
const publicRoutes = require('../routes/public.routes');
// Broadcast Center (shared root-level router)
const broadcastRoutes = require('../routes/broadcast.routes');
// Public Broadcast Center (shared root-level router)
let publicBroadcastRouter = null;
try { publicBroadcastRouter = require('../routes/publicBroadcast.routes'); } catch (_) { console.warn('[init] optional ../routes/publicBroadcast.routes not found; skipping'); }
// Shared system routes (health + monitor stubs)
const systemRoutes = require('../routes/system.routes');
// Mount dashboard stats from root-level routes (shared across apps)
const dashboardStatsRoutes = require('../routes/dashboardStats');
let adminAuditRoutes = null;
try { adminAuditRoutes = require('../routes/adminAudit.routes'); } catch (_) { console.warn('[init] optional ../routes/adminAudit.routes not found; skipping'); }
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require('./routes/ai'); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require('./routes/feed'); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }

dotenv.config(); // Load environment variables from .env file

const app = express();

// --- Global CORS: strict allowlist for prod + local dev ---
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://newspulse.co.in',
  'https://www.newspulse.co.in',
  'https://admin.newspulse.co.in',
  'https://newspulse-admin-panel-real.vercel.app',
];

// Allow all Vercel preview URLs for the admin panel project
const ADMIN_PANEL_VERCEL_REGEX = /^https:\/\/newspulse-admin-panel-real-.*\.vercel\.app$/;

const corsOptions = {
  origin: (origin, callback) => {
    try {
      // Allow same-origin or non-browser requests (no origin header)
      if (!origin) return callback(null, true);

      const isAllowed = allowedOrigins.includes(origin) || ADMIN_PANEL_VERCEL_REGEX.test(origin);
      if (isAllowed) return callback(null, true);

      console.log('CORS blocked origin:', origin);
      return callback(new Error('Not allowed by CORS: ' + origin));
    } catch (e) {
      console.log('CORS origin parse error:', e?.message || e);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
};
app.use(cors(corsOptions));
// Ensure preflight requests are handled with same options (incl. credentials)
app.options('*', cors(corsOptions));
console.log('🔓 CORS enabled. Allowed origins:', allowedOrigins);
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
// Shared health handler used by both non-API and API paths
const handleHealth = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'newspulse-backend',
    time: new Date().toISOString(),
  });
};
// Support both paths for safety
app.get('/system/health', handleHealth);
app.get('/api/system/health', handleHealth);

// Mount shared system router (supports GET /api/system/health via router too)
app.use('/api/system', systemRoutes);
app.use('/system', systemRoutes);
app.use('/api/admin/system', systemRoutes);

app.get('/system/ai-training-info', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString(),
  });
});

// Root-level health and stats (no /api prefix)
// Ensure these are defined before 404/error handlers.
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'newspulse-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/stats', (req, res) => {
  try {
    return res.status(200).json({
      status: 'ok',
      service: 'newspulse-backend',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[root:/stats] failed', e?.message || e);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
});

app.get('/dashboard-stats', async (req, res) => {
  try {
    return res.status(200).json({
      status: 'ok',
      totalArticles: 0,
      publishedArticles: 0,
      draftArticles: 0,
      breakingNewsCount: 0,
      totalUsers: 0,
      adminUsers: 0,
      activeReporters: 0,
      pendingReporterRequests: 0,
      storiesLast7Days: 0,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[root:/dashboard-stats] failed', e?.message || e);
    return res.status(500).json({ status: 'error', message: 'Failed to load dashboard stats' });
  }
});

// MongoDB Connection (single source of truth: MONGODB_URI)
const MONGO_URI = process.env.MONGODB_URI;

function _mongoDbNameFromUri(uri) {
  const u = String(uri || '').trim();
  if (!u) return null;

  const afterSlash = u.split('/').slice(3).join('/');
  if (!afterSlash) return null;
  const dbPart = afterSlash.split('?')[0];
  const dbName = String(dbPart || '').trim();
  if (!dbName) return null;
  return dbName.split('/')[0] || null;
}

// SAFETY GUARD: Never allow dev/staging to boot against prod DB.
(() => {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (env === 'production') return;
  const uri = String(MONGO_URI || '');
  if (!uri) return;

  if (uri.toLowerCase().includes('newspulse_prod')) {
    const msg = 'SAFETY STOP: Dev server is pointing to PROD database!';
    console.error(msg);
    throw new Error(msg);
  }
})();

if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.error('[startup] Missing Mongo connection string (MONGODB_URI). Refusing to start without DB.');
  console.error('[startup] Set MONGODB_URI in your environment, e.g. MONGODB_URI=mongodb://127.0.0.1:27017/newspulse_dev');
  process.exit(1);
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => {
      const db = _mongoDbNameFromUri(MONGO_URI) || mongoose.connection.name || undefined;
      console.log('Mongo connected');
      console.log('[startup] MongoDB connected', { db });
    })
    .catch((err) => {
      console.error('Mongo connection failed');
      console.error('[startup] MongoDB connection error', { message: err?.message || String(err), name: err?.name });
      process.exit(1);
    });
}

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🟢 News Pulse Admin Backend is Live');
});

// Compatibility alias for frontends requesting `/articles`
// Provides basic pagination and sorting over `News` items.
app.get('/articles', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const sortField = (req.query.sort || 'date').toString();
    const sortOrder = sortField.startsWith('-') ? -1 : 1;
    const sortBy = sortField.replace(/^[-+]/, '') || 'date';

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      News.find({}).sort({ [sortBy]: sortOrder }).skip(skip).limit(limit).lean(),
      News.countDocuments({}),
    ]);

    return res.json({
      ok: true,
      items,
      total,
      page,
      limit,
      sort: `${sortOrder === -1 ? '-' : ''}${sortBy}`,
    });
  } catch (e) {
    console.error('[compat:/articles] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load articles' });
  }
});

// API Routes
app.use('/api/news', newsRoutes);
// Broadcast Center (mount early)
app.use('/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/api/broadcast/*
app.use('/admin-api/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/broadcast/*
app.use('/admin-api/broadcast', broadcastRoutes);
app.use('/api/community', communityRoutes); // POST /api/community/submissions (public)
// Community Reporter public endpoints (submit, my-stories)
// PUBLIC routes – must be before any auth-protected mounts
app.get('/api/community-reporter/queue', getCommunityReporterQueue);
app.get('/api/community-reporter/contacts', listReporterContacts);
// Admin UI aliases (public read-only for directory)
app.get('/api/admin/community/reporter-contacts', listReporterContacts);
app.get('/admin-api/admin/community/reporter-contacts', listReporterContacts);
app.use('/api/community-reporter', communityReporterRoutes);

// Public sponsor ads + global ad slot settings
app.use('/api/public', publicAdsRouter);

// Public stories
app.use('/api/public', publicRoutes);

// Public Broadcast Center tickers
if (publicBroadcastRouter) {
  app.use('/api/public/broadcast', publicBroadcastRouter);
  // Admin panel proxy basePath support
  app.use('/admin-api/public/broadcast', publicBroadcastRouter);
  app.use('/admin-api/api/public/broadcast', publicBroadcastRouter);
}

app.use('/api/public', publicAdSettingsRouter);
app.use('/admin-api/public', publicAdSettingsRouter);
app.use('/admin-api/api/public', publicAdSettingsRouter);

// Global ad slot settings (mounted early so it cannot be shadowed by /api/admin)
app.use('/api/admin', adminAdSettingsRouter);
app.use('/admin-api/admin', adminAdSettingsRouter);
app.use('/admin-api/api/admin', adminAdSettingsRouter);

// Admin sponsor ads
app.use('/api/admin', adminAdsRouter);
app.use('/admin-api/admin', adminAdsRouter);
app.use('/admin-api/api/admin', adminAdsRouter);
// Admin routes mounted at both legacy root and new /api/admin paths where required.
app.use('/admin', adminRoutes); // legacy POST /admin/login
// Also mount admin router under /api for endpoints like /api/stats, /api/dashboard-stats
// NOTE: Admin router currently mounted at '/api' and legacy '/admin'.
// To ensure final URL '/api/admin/reporters' works, also mount under '/api/admin'.
app.use('/api', adminRoutes);
app.use('/api/admin', adminRoutes);
// Admin API proxy aliases
app.use('/admin-api/admin', adminRoutes);
app.use('/admin-api/api/admin', adminRoutes);
// Mount dashboard stats under /api and /admin-api to satisfy Admin Panel
app.use('/api', dashboardStatsRoutes);
app.use('/admin-api', dashboardStatsRoutes);
// Explicit admin-prefixed mounts for dashboard + stats
app.use('/api/admin', dashboardStatsRoutes);
app.use('/admin-auth', adminAuthRoutes); // legacy GET /admin-auth/session
app.use('/system/ai-training-info', aiTrainingInfoRoutes); // GET /system/ai-training-info
app.use('/api/system/ai-training-info', aiTrainingInfoRoutes); // GET /api/system/ai-training-info
// Admin alias: /api/admin/system/ai-training-info
app.use('/api/admin/system/ai-training-info', aiTrainingInfoRoutes);
// Health endpoints (API + compatibility alias)
app.use('/api/system/health', systemHealthRoutes);
app.use('/system/health', systemHealthRoutes);
// Admin alias: /api/admin/system/health
app.use('/api/admin/system', systemHealthRoutes);
// New admin community reporter + identity endpoints
app.use('/api/admin/community', adminCommunityRoutes);
// Admin Settings
app.use('/api/admin', adminSettingsRoutes);
app.use('/admin-api/admin', adminSettingsRoutes);
// Community Reporter Settings (mount admin router)
app.use('/api/admin', communityReporterSettingsRouter);

// Team management (Admin Panel: /api/admin/team/users)
if (adminTeamRoutes) app.use('/api/admin', adminTeamRoutes);
if (adminTeamRoutesV2) app.use('/api/admin/team', adminTeamRoutesV2);
// Admin API proxy aliases (frontend often proxies /admin-api/*)
if (adminTeamRoutes) {
  app.use('/admin-api/admin', adminTeamRoutes);
  app.use('/admin-api/api/admin', adminTeamRoutes);
}
if (adminTeamRoutesV2) {
  app.use('/admin-api/admin/team', adminTeamRoutesV2);
  app.use('/admin-api/api/admin/team', adminTeamRoutesV2);
}

// Audit logs (Admin Panel: /api/admin/audit)
if (adminAuditRoutes) {
  app.use('/api/admin', adminAuditRoutes);
  app.use('/admin-api/admin', adminAuditRoutes);
  app.use('/admin-api/api/admin', adminAuditRoutes);
}
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

app.get('/api/admin/me', optionalAdminAuth, (req, res) => {
  const a = req.admin || null;
  if (!a) {
    return res.status(200).json({
      ok: true,
      success: true,
      authenticated: false,
      admin: null,
    });
  }

  const role = (a.role === 'founder' || a.role === 'admin') ? a.role : 'admin';
  return res.status(200).json({
    ok: true,
    success: true,
    authenticated: true,
    role,
    admin: {
      id: a.id || 'unknown',
      email: a.email || '',
      role,
    },
  });
});

// Aliases expected by some UIs
app.get('/admin/stats', async (req, res) => {
  try {
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

// Start the server only when invoked directly, not when imported
const PORT = process.env.PORT || 5000;
if (require.main === module) {
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
}

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

module.exports = app;
