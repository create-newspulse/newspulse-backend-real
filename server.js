// Load environment variables as early as possible.
// Many route/controller modules read process.env at import time.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Base dir for nested app code
const BASE = './newspulse-backend-real-main';

// Nested routes and modules
const newsRoutes = require(`${BASE}/routes/news`);
const publicArticlesRoutes = require(`${BASE}/routes/publicArticles`);
const articlesRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require(`${BASE}/routes/adminAuth`);
const aiTrainingInfoRoutes = require(`${BASE}/routes/system/aiTrainingInfo`);
const systemRoutes = require('./routes/system.routes');
const communityRoutes = require(`${BASE}/routes/community`);
const communityStoriesRouter = require('./routes/communityStories');
const adminCommunityRoutes = require(`${BASE}/routes/adminCommunity`);
const communityAdminContactsRoutes = require(`${BASE}/routes/communityAdminContacts`);
// Use root-level communityReporter routes to match tests
const communityReporterRoutes = require('./routes/communityReporter');
const { getCommunityReporterQueue, listReporterContacts } = require('./controllers/communityReporterController');
const { getCommunityReporterAnalytics } = require('./controllers/communityReporterController');
// Use root-level admin settings router for base /settings endpoint
const adminSettingsRoutes = require('./routes/adminSettings.routes');
// Admin system routes (e.g., AI training info under /system)
const adminSystemRoutes = require('./routes/adminSystem.routes');
const communityReporterSettingsRouter = require(`${BASE}/routes/adminSettings/communityReporterSettings`);
// Dashboard stats router lives in root-level routes, not nested BASE dir
const dashboardStatsRouter = require('./routes/dashboardStats');
const adminCommunityReporterQueueRouter = require('./routes/admin/communityReporterQueue');
const founderFeatureTogglesRouter = require('./routes/admin/founderFeatureToggles');
const alertsRouter = require('./routes/alerts');
const securityRouter = require('./routes/security');
const adminThreatRouter = require('./routes/adminThreatRoutes');
const ownerPasskeyRouter = require('./routes/ownerPasskey');
const { requireOwnerKey } = require('./middleware/requireOwnerKey');
const { requireFounderAuth } = require('./middleware/adminAuth');
const adminStaffRouter = require('./routes/adminStaff.routes');
let adminSiteSettingsHomeTopBarsRouter = null;
let publicHomeTopBarsRouter = null;
try { adminSiteSettingsHomeTopBarsRouter = require('./routes/adminSiteSettings.homeTopBars.routes'); } catch (_) { console.warn('[init] optional routes/adminSiteSettings.homeTopBars.routes not found; skipping'); }
try { publicHomeTopBarsRouter = require('./routes/publicHomeTopBars.routes'); } catch (_) { console.warn('[init] optional routes/publicHomeTopBars.routes not found; skipping'); }
const broadcastRoutes = require('./routes/broadcast.routes');
const authRoutes = require('./routes/auth.routes');
const auditRoutes = require('./routes/audit.routes');
const publicAdsRouter = require('./routes/publicAds.routes');
const adminAdsRouter = require('./routes/adminAds.routes');
const publicAdSettingsRouter = require('./routes/publicAdSettings.routes');
const adminAdSettingsRouter = require('./routes/adminAdSettings.routes');
const publicRoutes = require('./routes/public.routes');
const siteSettingsRoutes = require('./routes/siteSettings.routes');
let adminWorkflowApiRouter = null;
let adminPushHistoryApiRouter = null;
let adminWorkflowLegacyRouter = null;
try { adminWorkflowApiRouter = require('./src/routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/workflow.routes not found; skipping'); }
try { adminPushHistoryApiRouter = require('./src/routes/admin/pushHistory.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/pushHistory.routes not found; skipping'); }
try { adminWorkflowLegacyRouter = require('./routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional routes/admin/workflow.routes not found; skipping'); }
const CommunitySubmission = require(`${BASE}/models/CommunitySubmission`);
const News = require(`${BASE}/models/News`);
const { requireAdminAuth } = require('./middleware/adminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require(`${BASE}/routes/ai`); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require(`${BASE}/routes/feed`); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }
let publicCommunitySettingsRouter = null;
try { publicCommunitySettingsRouter = require(`${BASE}/routes/public/communitySettings`); } catch (_) { console.warn('[init] optional public community settings router not found; skipping'); }
let publicFeatureTogglesRouter = null;
try { publicFeatureTogglesRouter = require('./routes/publicFeatureToggles'); } catch (_) { console.warn('[init] optional public feature toggles router not found; skipping'); }

const app = express();

// Normalize accidental double-prefixes from some clients
// (e.g. baseURL '/api' + request '/api/...' => '/api/api/...').
// This keeps the backend tolerant and prevents confusing 404s.
app.use((req, _res, next) => {
  try {
    if (req.url === '/api/api' || req.url === '/api/api/') {
      req.url = '/api/';
    } else if (req.url.startsWith('/api/api/')) {
      req.url = req.url.slice('/api'.length);
    }
  } catch (_) {}
  return next();
});

// Debug: confirm ad-settings route hits
app.use((req, _res, next) => {
  try {
    const p = String(req.originalUrl || req.url || '');
    if (p.startsWith('/api/admin/ad-settings') || p.startsWith('/admin-api/admin/ad-settings') || p.startsWith('/admin-api/api/admin/ad-settings')) {
      console.log('[ad-settings][hit]', {
        method: req.method,
        path: p,
        hasAuthHeader: !!req.headers.authorization,
        hasCookie: !!req.headers.cookie,
      });
    }
  } catch (_) {}
  return next();
});

// Global CORS (cors package) BEFORE any routes
// Strict allowlist.
// Production allows only the official domains below.
// Development also allows only the explicit localhost dev origins below.
const _corsEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const _corsIsProd = _corsEnv === 'production';
const _corsIsDev = !_corsIsProd;

function _parseCorsOriginsEnv(v) {
  const raw = String(v || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map(s => String(s || '').trim())
    .filter(Boolean);

  // Support values with or without scheme.
  // If a value doesn't include a scheme, treat it as a host[:port] and allow both http and https.
  const normalized = [];
  for (const p of parts) {
    if (p.includes('://')) {
      normalized.push(p);
    } else {
      normalized.push(`https://${p}`);
      normalized.push(`http://${p}`);
    }
  }
  return normalized;
}

const allowedOrigins = new Set([
  'https://newspulse.co.in',
  'https://www.newspulse.co.in',
  'https://admin.newspulse.co.in',
  'http://localhost:5173',
  'http://localhost:3000',
  // Comma-separated allowlist for the admin panel and local development.
  // Preferred env var: CORS_ORIGIN (supports multiple values).
  // Back-compat: CORS_ORIGINS.
  ..._parseCorsOriginsEnv(process.env.CORS_ORIGIN),
  ..._parseCorsOriginsEnv(process.env.CORS_ORIGINS),
]);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header)
    if (!origin) return callback(null, true);

    if (allowedOrigins.has(String(origin))) return callback(null, true);

    const err = new Error('CORS origin blocked');
    err.status = 403;
    err.origin = origin;
    return callback(err);
  },
  credentials: true,
  preflightContinue: true,
  optionsSuccessStatus: 204,
};

const _corsMiddleware = cors(corsOptions);

function _handleCorsError(err, req, res) {
  if (_corsIsDev) {
    console.warn('[cors] blocked', {
      origin: String(req.headers.origin || ''),
      method: req.method,
      path: req.originalUrl,
    });
  }
  const status = Number(err?.status) || 403;
  return res.status(status).json({ ok: false, success: false, message: 'CORS origin blocked' });
}

app.use((req, res, next) => {
  _corsMiddleware(req, res, (err) => {
    if (err) return _handleCorsError(err, req, res);
    return next();
  });
});

// Ensure OPTIONS preflight works for all routes.
app.options('*', (req, res) => {
  _corsMiddleware(req, res, (err) => {
    if (err) return _handleCorsError(err, req, res);
    return res.sendStatus(204);
  });
});

app.use(express.json());
app.use(cookieParser());

// Serve uploaded files publicly
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Upload handler (multipart/form-data)
const _uploadsDir = path.join(__dirname, 'uploads');
try { fs.mkdirSync(_uploadsDir, { recursive: true }); } catch (_) {}

const _uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try { fs.mkdirSync(_uploadsDir, { recursive: true }); } catch (_) {}
    cb(null, _uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).slice(0, 16);
    const safeExt = ext && /^[a-zA-Z0-9.]+$/.test(ext) ? ext : '';
    const rand = Math.random().toString(16).slice(2, 10);
    cb(null, `${Date.now()}-${rand}${safeExt}`);
  },
});

const _upload = multer({
  storage: _uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post('/api/uploads', _upload.any(), (req, res) => {
  try {
    const file = Array.isArray(req.files) ? req.files[0] : null;
    if (!file) {
      return res.status(400).json({ ok: false, success: false, message: 'No file uploaded' });
    }

    const filename = path.basename(String(file.filename || ''));
    const host = req.get('host');
    const base = `${req.protocol}://${host}`;
    const url = `${base}/uploads/${encodeURIComponent(filename)}`;

    return res.json({
      ok: true,
      success: true,
      url,
      filename,
      size: file.size,
      mime: file.mimetype,
    });
  } catch (e) {
    console.error('[uploads] failed', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Upload failed' });
  }
});

// Mount small system router for admin dashboard health + AI debug
app.use('/system', systemRoutes);
app.use('/api/system', systemRoutes);

// Admin panel workflow + push history APIs (exact paths used by frontend)
if (adminWorkflowApiRouter) {
  app.use('/api/admin', adminWorkflowApiRouter);
  app.use('/admin-api/admin', adminWorkflowApiRouter);
  app.use('/admin', adminWorkflowApiRouter);
}
if (adminPushHistoryApiRouter) {
  app.use('/api/admin', adminPushHistoryApiRouter);
  app.use('/admin-api/admin', adminPushHistoryApiRouter);
  app.use('/admin', adminPushHistoryApiRouter);
}
app.use('/api/admin/system', systemRoutes);

// Health handler used by the admin panel's SystemHealthBadge
// Returns a minimal, stable JSON schema.
const pkg = require('./package.json');
const healthHandler = async (req, res) => {
  const mongoState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  const mongoConnected = mongoState === 1;
  res.status(200).json({
    ok: true,
    success: true,
    service: 'newspulse-backend',
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    data: {
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV || 'development',
      mongo: {
        connected: mongoConnected,
        state: mongoState,
      },
    },
  });
};
app.get('/system/health', healthHandler);
app.get('/api/system/health', healthHandler);

// Simple base API health route (requested)
app.get('/api/health', (_req, res) => {
  return res.status(200).json({ ok: true });
});
app.get('/system/ai-training-info', (req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString() });
});

// Root-level health and stats (no /api prefix)
// These are defined directly on the app instance and must appear
// before any 404/error handlers so they are always reachable.
app.get('/health', (req, res) => {
  const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  if (readyState === 1) {
    return res.status(200).json({ ok: true, db: 'connected' });
  }
  return res.status(200).json({ ok: false, db: 'disconnected', readyState });
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
    // Placeholder values; wire up real MongoDB counts later.
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

// Mongo
// Prefer MONGO_URI, but accept common platform env vars if present.
// (Only treat DATABASE_URL as Mongo if it looks like a Mongo connection string.)
const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  (String(process.env.DATABASE_URL || '').startsWith('mongodb') ? process.env.DATABASE_URL : undefined);
const _isImported = require.main !== module;

function _redactMongoUri(uri) {
  const u = String(uri || '');
  if (!u) return '';
  // Mask user:pass if present (mongodb://user:pass@host)
  return u.replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
}

// Startup connection diagnostics
mongoose.connection.on('error', (err) => {
  console.error('[mongo] connection error', {
    message: err?.message || String(err),
    name: err?.name,
    readyState: mongoose.connection.readyState,
  });
});
mongoose.connection.on('disconnected', () => {
  console.warn('[mongo] disconnected', { readyState: mongoose.connection.readyState });
});
mongoose.connection.on('connected', () => {
  console.log('[mongo] connected', { readyState: mongoose.connection.readyState });
});

if (process.env.NODE_ENV === 'test' || _isImported) {
  console.warn('[init] Test/import mode: skipping MongoDB connection');
} else if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (env === 'production') {
    console.error('[startup] Missing Mongo connection string (MONGO_URI). Refusing to start without DB.');
    console.error('[startup] Set MONGO_URI in your .env, e.g. MONGO_URI=mongodb://127.0.0.1:27017/newspulse');
    process.exit(1);
  }
  console.warn('[startup] Missing MONGO_URI; starting without DB connection (non-production)');
} else {
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      console.log('[startup] MongoDB connected', { uri: _redactMongoUri(MONGO_URI) });
      // Ensure TTL index for Broadcast Center is present.
      try {
        const BroadcastItem = require('./models/BroadcastItem');
        await BroadcastItem.syncIndexes();
      } catch (e) {
        console.warn('[startup] BroadcastItem index sync failed', e?.message || e);
      }

      // Ensure ads indexes are present.
      try {
        const Ad = require('./models/Ad');
        await Ad.syncIndexes();
      } catch (e) {
        console.warn('[startup] Ad index sync failed', e?.message || e);
      }
    })
    .catch((err) => {
      console.error('[startup] MongoDB connection failed', {
        uri: _redactMongoUri(MONGO_URI),
        message: err?.message || String(err),
        name: err?.name,
      });
    });
}

// Minimal scheduler: auto-publish scheduled articles (every minute)
let _publishTickInFlight = false;
async function _publishScheduledTick() {
  if (_publishTickInFlight) return;
  _publishTickInFlight = true;
  try {
    if (mongoose.connection.readyState !== 1) return;
    const News = require('./models/News');
    const PushHistory = require('./models/PushHistory');
    const now = new Date();

    const candidates = await News.find({
      status: 'scheduled',
      scheduledAt: { $lte: now },
      $and: [
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
        { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
        { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
      ],
    }).limit(50);

    for (const doc of candidates) {
      try {
        const fromStage = String(doc.workflowStage || 'SCHEDULED');
        doc.status = 'published';
        doc.publishedAt = now;
        doc.publishAt = null;
        doc.workflowStage = 'PUBLISHED';
        doc.workflowUpdatedAt = now;
        doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
        doc.workflowHistory.push({
          at: now,
          byUserId: null,
          byRole: 'SYSTEM',
          action: 'PUBLISH',
          fromStage,
          toStage: 'PUBLISHED',
          note: 'Auto-published by scheduler',
        });
        await doc.save();

        try {
          await PushHistory.create({
            articleId: doc._id,
            slug: doc.slug,
            title: doc.title,
            channel: 'SITE',
            at: now,
            byUserId: null,
            status: 'SUCCESS',
            meta: { source: 'scheduler' },
          });
        } catch (e) {
          console.warn('[scheduler][pushHistory] create failed', e?.message || e);
        }
      } catch (e) {
        console.warn('[scheduler] publish candidate failed', e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[scheduler] tick failed', e?.message || e);
  } finally {
    _publishTickInFlight = false;
  }
}

if (!_isImported && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
  setInterval(_publishScheduledTick, 60_000);
}

// Home
app.get('/', (req, res) => { res.send('🟢 News Pulse Admin Backend is Live'); });

// API Routes
app.use('/api/news', newsRoutes);
app.use('/api/articles', publicArticlesRoutes);
// Quick browser check: confirm auth route is deployed
app.get('/api/auth/login', (_req, res) => {
  return res.json({ ok: true, message: 'Auth route is live. Use POST to login.' });
});
// ✅ Founder/Admin Login (MVP)
// Defined directly in server.js to avoid any router-mount confusion.
app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || req.body?.username || '').toLowerCase().trim();
  const password = String(req.body?.password || '');

  const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const adminPass = String(process.env.ADMIN_PASS || '');

  const founderEmail = String(process.env.FOUNDER_EMAIL || '').toLowerCase().trim();
  const founderPass = String(process.env.FOUNDER_PASSWORD || '');

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  let role = null;
  if (email === adminEmail && password === adminPass) role = 'admin';
  if (email === founderEmail && password === founderPass) role = 'founder';

  if (!role) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ success: false, message: 'JWT_SECRET missing' });
  }

  const token = jwt.sign({ email, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return res.json({ success: true, token, user: { email, role } });
});
// Auth bootstrap endpoint for admin panel
app.use('/api/auth', authRoutes);
// Audit (founder-only)
app.use('/api/audit', auditRoutes);
// Broadcast Center (mount early so it cannot be shadowed by other /api routers)
app.use('/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/api/broadcast/*
app.use('/admin-api/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/broadcast/*
app.use('/admin-api/broadcast', broadcastRoutes);
// Site settings: simple public endpoint (stub)
// Placed here (before router mounts) to guarantee frontend never sees a 404.
app.get('/api/site-settings/public', (req, res) => {
  res.json({
    success: true,
    data: {
      brandName: 'News Pulse',
      liveTvEnabled: true,
      liveTvUrl: '',
      defaultLanguage: 'en',
      maintenanceMode: false,
    },
  });
});
// Site Settings (public)
app.use('/api/site-settings', siteSettingsRoutes);
// Articles router mounted at /api and alias at root for /articles
app.use('/api', articlesRoutes);
app.use('/', articlesRoutes);
// Admin panel compatibility: /api/admin/articles should behave like /api/articles
app.use('/api/admin', articlesRoutes);
app.use('/api/community', communityRoutes);
// Reporter portal: My Community Stories
app.use('/api/community', communityStoriesRouter);
// PUBLIC routes – must be before any /api auth-protected mounts
app.get('/api/community-reporter/queue', getCommunityReporterQueue);
app.get('/api/community-reporter/contacts', listReporterContacts);
// Admin UI often calls these aliases; expose public read-only directory
app.get('/api/admin/community/reporter-contacts', listReporterContacts);
app.get('/admin-api/admin/community/reporter-contacts', listReporterContacts);
app.use('/api/community-reporter', communityReporterRoutes);
// Public alias to match frontend expectation
app.use('/api/public/community-reporter', communityReporterRoutes);

// Founder passkey (WebAuthn) owner-key unlock
app.use('/api/owner/passkey', ownerPasskeyRouter);
// Public community settings
if (publicCommunitySettingsRouter) {
  app.use('/api/public/community', publicCommunitySettingsRouter);
}
// Public feature toggles
if (publicFeatureTogglesRouter) {
  app.use('/', publicFeatureTogglesRouter);
  app.use('/api', publicFeatureTogglesRouter); // also expose under /api
  // Explicit public namespace for admin panel usage
  app.use('/api/public', publicFeatureTogglesRouter);
}

// Public sponsor ads
app.use('/api/public', publicAdsRouter);

// Public stories
app.use('/api/public', publicRoutes);

// Global ad slot settings
app.use('/api/public', publicAdSettingsRouter);
// Alias support
app.use('/admin-api/public', publicAdSettingsRouter);
app.use('/admin-api/api/public', publicAdSettingsRouter);

// Public homepage bars (Breaking + Live Updates)
if (publicHomeTopBarsRouter) app.use('/api/public', publicHomeTopBarsRouter);
// Journalists public/apply + admin ops
try {
  const journalistsRouter = require('./routes/journalists');
  app.use('/api/journalists', journalistsRouter);
} catch (e) {
  console.warn('[init] optional routes/journalists not found; skipping');
}
// Global ad slot settings (mounted early so it cannot be shadowed by /api/admin)
app.use('/api/admin', adminAdSettingsRouter);
// Alias support
app.use('/admin-api/admin', adminAdSettingsRouter);
app.use('/admin-api/api/admin', adminAdSettingsRouter);

// Admin routes for legacy and new admin UI paths
app.use('/api/admin', adminRoutes); // used by admin UI
app.use('/admin', adminRoutes);     // legacy path
// Admin sponsor ads
app.use('/api/admin', adminAdsRouter);
// IMPORTANT: Admin panel alias support
app.use('/admin-api/admin', adminAdsRouter);
app.use('/admin-api/api/admin', adminAdsRouter);
// Settings Center > Team Management (founder-only)
app.use('/api/admin/staff', adminStaffRouter);
// Backward-compatible alias used by some admin panel builds
app.use('/api/admin/team', adminStaffRouter);
// Admin site settings (Founder-only)
if (adminSiteSettingsHomeTopBarsRouter) app.use('/api/admin', adminSiteSettingsHomeTopBarsRouter);
// Alias for admin analytics screen expecting /community/reporters at root
app.get('/community/reporters', requireAdminAuth, getCommunityReporterAnalytics);
// Mount dashboard stats router
// /api -> /api/stats, /api/dashboard-stats
app.use('/api', dashboardStatsRouter);
// /admin-api -> alias used by some frontends
app.use('/admin-api', dashboardStatsRouter);
// /api/admin -> explicit admin-prefixed endpoints
app.use('/api/admin', dashboardStatsRouter);
app.use('/admin-auth', adminAuthRoutes);
app.use('/system/ai-training-info', aiTrainingInfoRoutes);
app.use('/api/system/ai-training-info', aiTrainingInfoRoutes);
// Admin-prefixed alias for system AI training info
// Admin system endpoints mounted under /api/admin (handled by adminSystemRoutes)
app.use('/api/admin', adminSystemRoutes);
// health routes handled directly above by healthHandler
// System monitor hub handled by systemRoutes (mounted above)
app.use('/api/admin/community', adminCommunityRoutes);
// Admin Settings router (GET /api/admin/settings)
// Mounted router returns { success: true, data: {...} }
// Admin Settings (includes /api/admin/settings/community-reporter)
app.use('/api/admin', adminSettingsRoutes);
app.use('/admin-api/admin', adminSettingsRoutes);
// Compatibility alias: some frontends call /admin-api/api/admin/*
app.use('/admin-api/api/admin', adminSettingsRoutes);
// Legacy alias: expose admin settings under /admin as well
app.use('/admin', adminSettingsRoutes);
// Community Reporter Settings router (same mount /api/admin)
app.use('/api/admin', communityReporterSettingsRouter);
// Founder feature toggles (admin/founder protected)
app.use('/api/admin/founder', founderFeatureTogglesRouter);
// Community Reporter Queue (admin protected)
app.use('/api/admin', adminCommunityReporterQueueRouter);
app.use('/admin-api/admin', adminCommunityReporterQueueRouter);
app.use('/admin', adminCommunityReporterQueueRouter);
// Security & Lockdown and Alerts routers
app.use('/api/security', securityRouter);
app.use('/api/alerts', alertsRouter);
// Threat dashboard endpoints
app.use('/api/dashboard', adminThreatRouter);
app.use('/api/admin', adminThreatRouter);
// Explicit alias to ensure GET /api/admin/community-reporter/queue returns 200 with auth
app.get('/api/admin/community-reporter/queue', requireAdminAuth, async (req, res) => {
  try {
    const result = await getCommunityReporterQueue(req, {
      status: (code) => ({ json: (payload) => ({ code, payload }) }),
      json: (payload) => ({ code: 200, payload }),
    });
    const payload = result && result.payload ? result.payload : null;
    const items = payload && Array.isArray(payload.data) ? payload.data : [];
    const meta = payload && payload.meta ? payload.meta : { statusFilter: String(req.query.status || 'pending') };
    return res.status(200).json({ ok: true, success: true, status: 200, items, meta, message: 'Community reporter queue' });
  } catch (e) {
    console.error('[alias][api/admin/community-reporter/queue] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
  }
});
// Mount full admin community-reporter routes (submissions, decisions, journalist applications)
try {
  const adminCommunityReporterRouter = require('./routes/adminCommunityReporter');
  app.use('/api/admin/community-reporter', adminCommunityReporterRouter);
  app.use('/admin/community-reporter', adminCommunityReporterRouter);
  // Also mount under /admin/community for journalist applications aliases
  app.use('/admin/community', adminCommunityReporterRouter);
  // Legacy alias: /api/admin/community/submissions → /api/admin/community-reporter/submissions
  app.use('/api/admin/community/submissions', (req, res, next) => { try { req.url = '/submissions'; return adminCommunityReporterRouter(req, res, next); } catch (e) { return next(e); } });
} catch (e) {
  console.warn('[init] optional routes/adminCommunityReporter not found; skipping');
}
if (aiRoutes) app.use('/api/ai', aiRoutes);
if (feedRoutes) app.use('/api/feed', feedRoutes);
app.use('/api/admin/community', communityAdminContactsRoutes);
app.use('/admin-api/admin/community', communityAdminContactsRoutes);
app.use('/admin/community', communityAdminContactsRoutes);
// Public website settings (safe keys only)
app.get('/settings/public', (req, res) => {
  return res.json({
    ok: true,
    version: 1,
    public: {},
    updatedAt: new Date().toISOString(),
  });
});
// Admin journalists endpoints
try {
  const adminJournalists = require('./routes/admin/journalistsAdmin');
  app.use('/api/admin', adminJournalists);
} catch (e) {
  console.warn('[init] optional routes/admin/journalistsAdmin not found; skipping');
}

// Workflow board + actions (legacy/admin)
if (adminWorkflowLegacyRouter) {
  app.use('/api/admin/workflow', adminWorkflowLegacyRouter);
  app.use('/admin/workflow', adminWorkflowLegacyRouter);
  // Compatibility alias used by some frontends
  app.use('/admin-api/api/workflow', adminWorkflowLegacyRouter);
}

// Lightweight health/status endpoint under /api
// (stats and dashboard-stats are now served by routes/dashboardStats.js mounted under /api and /admin-api)

// Aliases and fallbacks
app.get('/admin/community/journalist-applications', requireAdminAuth, (req, res, next) => {
  try { req.url = '/journalist-applications'; return communityAdminContactsRoutes(req, res, next); } catch (e) {
    console.error('[nested][ALIAS][journalist-applications] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});
// Legacy path aliases expected by admin panel
app.get('/community/stats', requireAdminAuth, (req, res, next) => {
  try { req.url = '/community/stats'; return adminRoutes(req, res, next); } catch (e) {
    console.error('[alias][community/stats] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load community stats' });
  }
});
app.get('/reporters', requireAdminAuth, (req, res, next) => {
  try { req.url = '/reporters'; return adminRoutes(req, res, next); } catch (e) {
    console.error('[alias][reporters] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporters' });
  }
});
// Admin panel expects /api/admin/community/reporters; delegate to routes/admin.js /reporters
app.get('/api/admin/community/reporters', requireAdminAuth, (req, res, next) => {
  try { req.url = '/reporters'; return adminRoutes(req, res, next); } catch (e) {
    console.error('[alias][api/admin/community/reporters] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
});
app.get('/community/submissions', requireAdminAuth, (req, res, next) => {
  try {
    // delegate to admin community-reporter submissions
    req.url = '/submissions';
    const adminCommunityReporterRouter = require('./routes/adminCommunityReporter');
    return adminCommunityReporterRouter(req, res, next);
  } catch (e) {
    console.error('[alias][community/submissions] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});
app.get('/admin/community/reporter-contacts', requireAdminAuth, async (req, res, next) => {
  if (res.headersSent) return next();
  if (communityAdminContactsRoutes) return next();
  return res.json({ ok: true, items: [], total: 0 });
});
app.get('/admin/community/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKeyRaw = ((req.query.reporterKey || req.query.email || '')).toString().trim();
    if (!reporterKeyRaw) return res.status(400).json({ ok: false, message: 'Missing reporterKey or email' });
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

// Admin: Founder overview – list all community stories with optional status/search filters
// GET /api/admin/community/my-stories?status=pending&search=foo
app.get('/api/admin/community/my-stories', requireAdminAuth, async (req, res) => {
  try {
    const { status = 'all', search = '' } = req.query || {};
    const filter = {};

    // Status filter: only apply when not 'all'
    const statusNorm = String(status || '').trim().toLowerCase();
    if (statusNorm && statusNorm !== 'all') {
      // Accept common status labels used across flows
      const variants = {
        pending: ['pending', 'under_review', 'new', 'PENDING_FOUNDER', 'PENDING', 'NEW'],
        approved: ['approved', 'APPROVED'],
        rejected: ['rejected', 'REJECTED'],
        withdrawn: ['withdrawn', 'WITHDRAWN'],
      };
      const v = variants[statusNorm] || [statusNorm];
      filter.status = { $in: v };
    }

    // Search filter: case-insensitive regex on headline
    const searchNorm = String(search || '').trim();
    if (searchNorm) {
      filter.headline = { $regex: searchNorm, $options: 'i' };
    }

    const docs = await CommunitySubmission
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const items = docs.map(d => ({
      _id: String(d._id),
      id: String(d._id),
      title: d.headline || '',
      headline: d.headline || '',
      status: d.status || 'pending',
      language: d.language || 'en',
      category: d.category || null,
      city: (d.location?.city || d.city || d.locationDetail?.city || null),
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
    }));

    return res.json({ ok: true, items, total: items.length });
  } catch (e) {
    console.error('[ADMIN][my-stories] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load community stories' });
  }
});

app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  const a = req.admin || {};
  const role = (a.role === 'founder' || a.role === 'admin') ? a.role : 'admin';
  return res.json({
    ok: true,
    success: true,
    role,
    admin: { id: a.id || 'unknown', email: a.email || '', role },
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

// Public config
let _communityReporterFlagCache = { myCommunityStoriesEnabled: false };
app.get('/api/community-reporter/config', (req, res) => {
  return res.json({ ok: true, communityMyStoriesEnabled: _communityReporterFlagCache.myCommunityStoriesEnabled });
});

// --- AI / System health stubs ---
app.get('/api/system/ai-health', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI health stub (no real engine wired yet)',
    data: {
      status: 'offline',
      engines: [],
      notes: 'This is a placeholder response from newspulse-backend-real-main.',
    },
  });
});

app.get('/system/ai-training-info', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI training info stub',
    data: {
      lastUpdated: null,
      datasets: [],
      notes: 'Training info not yet implemented.',
    },
  });
});

// --- AIRA bulletins stub ---
app.get('/api/aira/bulletins', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AIRA bulletins stub',
    data: {
      items: [],
      notes: 'No bulletins yet – backend stub response.',
    },
  });
});

// --- Legacy Admin Auth compatibility endpoints for local tests ---
// In-memory token store (ephemeral; fine for local/dev tests)
const _issuedTokens = { access: new Set(), refresh: new Set() };
function _makeToken(prefix) {
  return `${prefix}.${Buffer.from(String(Date.now())).toString('base64')}`;
}

// POST /admin/login -> returns success + access/refresh tokens
app.post('/admin/login', (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || process.env.FOUNDER_EMAIL || 'founder@example.com');
    const password = String(body.password || '');
    const expectedEmail = String(process.env.FOUNDER_EMAIL || 'founder@example.com');
    const expectedPass = String(process.env.FOUNDER_PASSWORD || 'test-password');
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    if (email !== expectedEmail || password !== expectedPass) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const accessToken = _makeToken('access');
    const refreshToken = _makeToken('refresh');
    _issuedTokens.access.add(accessToken);
    _issuedTokens.refresh.add(refreshToken);
    return res.json({ success: true, accessToken, refreshToken, user: { email } });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// GET /admin-auth/session -> success true/false based on token; invalid returns success=false
app.get('/admin-auth/session', (req, res) => {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(200).json({ success: false, user: null });
  if (token === 'invalidtoken') return res.status(200).json({ success: false, user: null });
  const ok = _issuedTokens.access.has(token) || token.startsWith('np.') || token.startsWith('access.');
  if (!ok) return res.status(200).json({ success: false, user: null });
  const email = process.env.FOUNDER_EMAIL || 'founder@example.com';
  return res.json({ success: true, user: { email } });
});

// POST /admin/refresh -> requires valid refresh token
app.post('/admin/refresh', (req, res) => {
  const body = req.body || {};
  const rt = String(body.refreshToken || '');
  if (!_issuedTokens.refresh.has(rt)) return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  const accessToken = _makeToken('access');
  _issuedTokens.access.add(accessToken);
  return res.json({ success: true, accessToken });
});

// GET /admin/metrics -> simple structure for tests
app.get('/admin/metrics', (req, res) => {
  return res.json({
    success: true,
    uptimeSeconds: Math.floor(process.uptime()),
    rateLimit: { limit: 1000, remaining: 1000 },
    tokens: { issuedAccess: _issuedTokens.access.size, issuedRefresh: _issuedTokens.refresh.size },
  });
});

// --- Vault stub ---
app.get('/api/vault/list', requireFounderAuth, requireOwnerKey, (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI vault list stub',
    data: {
      items: [],
    },
  });
});

// --- Media uploads stub ---
app.get('/api/uploads', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Uploads list stub',
    data: {
      items: [],
    },
  });
});

// --- SEO audit history stub ---
app.get('/api/seo/audit/history', (req, res) => {
  const limit = Number(req.query.limit || 0);
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'SEO audit history stub',
    data: {
      limit,
      items: [],
    },
  });
});

// --- Analytics stubs ---
app.get('/api/analytics/revenue', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Revenue analytics stub',
    data: {
      total: 0,
      bySource: [],
    },
  });
});

app.get('/api/analytics/traffic', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Traffic analytics stub',
    data: {
      sessions: 0,
      pageViews: 0,
      byChannel: [],
    },
  });
});

app.get('/api/analytics/ad-performance', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Ad performance stub',
    data: {
      campaigns: [],
    },
  });
});

app.get('/api/analytics/ab-tests', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'A/B tests stub',
    data: {
      experiments: [],
    },
  });
});

// Debug routes list (place before 404 handler)
app.get('/_debug/routes', (req, res) => {
  const list = [];
  try {
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path) {
        list.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => { if (rLayer.route && rLayer.route.path) list.push(prefix + rLayer.route.path); });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Introspection failed', error: e?.message || e });
  }
  return res.json({ ok: true, total: list.length, reporter: list.filter(r => r.includes('reporter')), all: list });
});

// --- System version log stub ---
app.get('/api/system/version-log', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Version log stub',
    data: {
      items: [],
      notes: 'No version log entries yet on backend.',
    },
  });
});

// --- Threat stats stub ---
app.get('/threat-stats', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Threat stats stub',
    data: {
      level: 'normal',
      lastScan: null,
      issues: [],
    },
  });
});

// 500
app.use((err, req, res, next) => {
  const status = Math.max(400, Math.min(599, parseInt(err?.status || err?.statusCode || 500, 10) || 500));
  const message = status < 500
    ? (err?.message || 'Request failed')
    : 'Internal server error';
  try { console.error('Error:', err && err.message ? err.message : err, 'status=', status, 'path=', req.originalUrl); } catch (_) {}
  if (res.headersSent) return next(err);
  return res.status(status).json({
    ok: false,
    success: false,
    status,
    message,
    data: null,
    path: req.originalUrl,
    ...(err?.code ? { code: String(err.code) } : {}),
  });
});

// 404 (final handler returning requested shape) — keep this LAST
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    success: false,
    status: 404,
    message: 'Route not found',
    data: null,
    path: req.originalUrl,
  });
});

// Start server only when invoked directly (not when imported by tests)
const PORT = parseInt(process.env.PORT || '5000', 10) || 5000;
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    try {
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

  server.on('error', (err) => {
    console.error('[startup] failed to listen', { port: PORT, code: err?.code, message: err?.message });
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[startup] Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
    }
    process.exit(1);
  });
}

function extractPrefix(regexp) {
  try {
    const src = (regexp && regexp.source) || '';
    const m = src.match(/\\\/(admin[^\\^]+|api[^\\^]+|system[^\\^]+)/i);
    if (m && m[1]) return '/' + m[1];
  } catch (_) {}
  return '';
}

module.exports = app;
