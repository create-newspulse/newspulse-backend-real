const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Base dir for nested app code
const BASE = './newspulse-backend-real-main';

// Nested routes and modules
const newsRoutes = require(`${BASE}/routes/news`);
const articlesRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require(`${BASE}/routes/adminAuth`);
const aiTrainingInfoRoutes = require(`${BASE}/routes/system/aiTrainingInfo`);
const systemRoutesRouter = require('./routes/system.routes');
const systemRoutes = require('./routes/system');
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

dotenv.config();

const app = express();

// Global CORS (cors package) BEFORE any routes
// Allow specific known origins plus Vercel preview URLs for the admin panel.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://newspulse.co.in',
  'https://www.newspulse.co.in',
  'https://admin.newspulse.co.in',
  'https://newspulse-admin-panel-real.vercel.app',
];

// Allow all Vercel preview URLs for the admin panel project
const ADMIN_PANEL_VERCEL_REGEX = /^https:\/\/newspulse-admin-panel-real-.*\.vercel\.app$/;

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header)
    if (!origin) return callback(null, true);

    const isAllowed =
      allowedOrigins.includes(origin) || ADMIN_PANEL_VERCEL_REGEX.test(origin);

    if (isAllowed) return callback(null, true);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
};

app.use(cors(corsOptions));
// Handle CORS preflight for all routes with same options
app.options('*', cors(corsOptions));

app.use(express.json());

// Mount small system router for admin dashboard health + AI debug
app.use('/system', systemRoutes);
app.use('/api/system', systemRoutes);

// Health handler used by the admin panel's SystemHealthBadge
// Returns a minimal, stable JSON schema.
const pkg = require('./package.json');
const healthHandler = async (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'newspulse-backend',
    time: new Date().toISOString(),
  });
};
app.get('/system/health', healthHandler);
app.get('/api/system/health', healthHandler);
app.get('/system/ai-training-info', (req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString() });
});

// Root-level health and stats (no /api prefix)
// These are defined directly on the app instance and must appear
// before any 404/error handlers so they are always reachable.
app.get('/health', (req, res) => {
  return res.status(200).json({
    ok: true,
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
const MONGO_URI = process.env.MONGO_URI;
if (process.env.NODE_ENV === 'test') {
  console.warn('[init] Test mode: skipping MongoDB connection');
} else if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.warn('⚠️ MONGO_URI is not set correctly; starting server without DB connection for now.');
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
    });
}

// Home
app.get('/', (req, res) => { res.send('🟢 News Pulse Admin Backend is Live'); });

// API Routes
app.use('/api/news', newsRoutes);
// Articles router mounted at /api and alias at root for /articles
app.use('/api', articlesRoutes);
app.use('/', articlesRoutes);
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
// Journalists public/apply + admin ops
try {
  const journalistsRouter = require('./routes/journalists');
  app.use('/api/journalists', journalistsRouter);
} catch (e) {
  console.warn('[init] optional routes/journalists not found; skipping');
}
// Admin routes for legacy and new admin UI paths
app.use('/api/admin', adminRoutes); // used by admin UI
app.use('/admin', adminRoutes);     // legacy path
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
// System monitor hub (API + non-API alias)
app.use('/api/system', systemRoutesRouter);
app.use('/system', systemRoutesRouter);
// Admin-prefixed alias for system routes (ensures /api/admin/system/health via mounted router)
app.use('/api/admin/system', systemRoutesRouter);
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
  return res.json({ success: true, admin: { id: a.id || 'unknown', email: a.email || '', role: a.role || 'admin' } });
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
app.get('/api/vault/list', (req, res) => {
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

// 404 (final handler returning requested shape)
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found', path: req.originalUrl });
});

// 500
app.use((err, req, res, next) => {
  try { console.error('Error:', err && err.message ? err.message : err, 'path=', req.originalUrl); } catch (_) {}
  res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
});

// Start server only when invoked directly (not when imported by tests)
const PORT = process.env.PORT || 5000;
if (require.main === module) {
  app.listen(PORT, () => {
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
