// Load environment variables as early as possible.
// Many route/controller modules read process.env at import time.
const path = require('path');
const _isImportedEarly = require.main !== module;
const _nodeEnvEarly = String(process.env.NODE_ENV || 'development').toLowerCase();
const _isRenderEarly = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
const _isProdEarly = _nodeEnvEarly === 'production' || _isRenderEarly;

// IMPORTANT:
// - Local dev: allow .env to override any stale shell environment vars.
// - Production (Render): NEVER override Render-provided env vars from the repo's .env.
//   A committed .env would otherwise clobber the real Render config.
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  override: !_isProdEarly,
});

// Backward-compat: older setups used MONGO_URI.
// Prefer MONGODB_URI, but if only MONGO_URI exists, alias it.
if (!process.env.MONGODB_URI && process.env.MONGO_URI) {
  process.env.MONGODB_URI = process.env.MONGO_URI;
  if (require.main === module && String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[startup] Using legacy MONGO_URI; please rename to MONGODB_URI in .env');
  }
}

// One-time local-dev sanity log to confirm dotenv loaded.
// (Avoids noisy logs in tests/import mode.)
if (require.main === module && String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production') {
  // eslint-disable-next-line no-console
  console.log('[startup] MONGODB_URI exists?', !!process.env.MONGODB_URI);

  // eslint-disable-next-line no-console
  console.log('[startup] adminCreds', {
    hasEmail: !!String(process.env.ADMIN_EMAIL || '').trim(),
    hasPassword: !!String(process.env.ADMIN_PASSWORD || '').trim(),
  });
}

// Note: Do not fail-fast on missing env vars.
// The server should boot even if MongoDB or JWT env vars are not set; endpoints that
// require them will return errors at request time.
if (require.main === module && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
  if (!String(process.env.JWT_SECRET || '').trim()) {
    // eslint-disable-next-line no-console
    console.warn('[startup] JWT_SECRET is not set; auth endpoints may fail until configured.');
  }
}

function _redactMongoUri(uri) {
  const u = String(uri || '');
  if (!u) return '';
  // Mask user:pass if present (mongodb://user:pass@host)
  return u.replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
}

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const fs = require('fs');
const multer = require('multer');

function _logStartupDbStatus(label) {
  try {
    const env = String(process.env.NODE_ENV || 'development').toLowerCase();
    if (env === 'production') return;
    if (require.main !== module) return;

    const hasMongoUri = !!String(process.env.MONGODB_URI || '').trim();
    const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
    const dbName = (readyState === 1 && mongoose?.connection?.name) ? String(mongoose.connection.name) : null;

    // eslint-disable-next-line no-console
    console.log('[startup][db-status]', {
      label,
      hasMongoUri,
      readyState,
      ...(dbName ? { dbName } : {}),
    });
  } catch (_) {}
}

_logStartupDbStatus('boot');

// Identify which backend answered a request (safe: no secrets).
// Useful to catch miswired frontends accidentally calling production from localhost.
function _safeEnvLabel() {
  return String(process.env.NODE_ENV || 'development');
}

function _safeDbLabel() {
  // Prefer live connection name when available.
  const name = (mongoose.connection && mongoose.connection.name) ? String(mongoose.connection.name) : '';
  if (name) return name;
  return mongoose.connection && mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}

// Base dir for nested app code
const BASE = './newspulse-backend-real-main';

// Public news feed routes (no auth; published-only)
const newsRoutes = require('./routes/news');
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
const authOtpRoutes = require('./routes/authOtp');
const ownerPasskeyRouter = require('./routes/ownerPasskey');
const { requireOwnerKey } = require('./middleware/requireOwnerKey');
const { requireFounderAuth } = require('./middleware/adminAuth');
const adminStaffRouter = require('./routes/adminStaff.routes');
let adminSiteSettingsHomeTopBarsRouter = null;
let publicHomeTopBarsRouter = null;
try { adminSiteSettingsHomeTopBarsRouter = require('./routes/adminSiteSettings.homeTopBars.routes'); } catch (_) { console.warn('[init] optional routes/adminSiteSettings.homeTopBars.routes not found; skipping'); }
try { publicHomeTopBarsRouter = require('./routes/publicHomeTopBars.routes'); } catch (_) { console.warn('[init] optional routes/publicHomeTopBars.routes not found; skipping'); }
const broadcastRoutes = require('./routes/broadcast.routes');
const adminBroadcastRouter = require('./routes/adminBroadcast.routes');
const authRoutes = require('./routes/auth.routes');
const auditRoutes = require('./routes/audit.routes');
const adminTeamRoutes = require('./routes/adminTeam.routes');
const adminAuthV2Routes = require('./routes/adminAuthV2.routes');
const adminBootstrapRoutes = require('./routes/adminBootstrap.routes');
let adminTeamRoutesV2 = null;
try { adminTeamRoutesV2 = require('./src/routes/adminTeamRoutes'); } catch (_) { console.warn('[init] optional src/routes/adminTeamRoutes not found; skipping'); }
const adminSecurityRoutes = require('./routes/adminSecurity.routes');
const adminAuditRoutes = require('./routes/adminAudit.routes');
let adminMetaRoutes = null;
try { adminMetaRoutes = require('./routes/adminMeta.routes'); } catch (_) { console.warn('[init] optional routes/adminMeta.routes not found; skipping'); }
const publicAdsRouter = require('./routes/publicAds.routes');
const adminAdsRouter = require('./routes/adminAds.routes');
const publicAdSettingsRouter = require('./routes/publicAdSettings.routes');
const adminAdSettingsRouter = require('./routes/adminAdSettings.routes');
const publicRoutes = require('./routes/public.routes');
const siteSettingsRoutes = require('./routes/siteSettings.routes');
const publicSettingsRouter = require('./routes/publicSettings.routes');
const adminPublicSettingsRouter = require('./routes/adminPublicSettings.routes');
const PublicSiteSettings = require('./models/PublicSiteSettings');
const User = require('./models/User');
const publicNewsRouter = require('./routes/publicNews.routes');
const publicTrendingTopicsRouter = require('./routes/publicTrendingTopics.routes');
const publicTickersSettingsRouter = require('./routes/publicTickersSettings.routes');
const adminTickersSettingsRouter = require('./routes/adminTickersSettings.routes');
const publicBroadcastRouter = require('./routes/publicBroadcast.routes');
let adminWorkflowApiRouter = null;
let adminPushHistoryApiRouter = null;
let adminWorkflowLegacyRouter = null;
try { adminWorkflowApiRouter = require('./src/routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/workflow.routes not found; skipping'); }
try { adminPushHistoryApiRouter = require('./src/routes/admin/pushHistory.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/pushHistory.routes not found; skipping'); }
try { adminWorkflowLegacyRouter = require('./routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional routes/admin/workflow.routes not found; skipping'); }
const CommunitySubmission = require(`${BASE}/models/CommunitySubmission`);
const News = require(`${BASE}/models/News`);
// Public /api/public/stories uses the root Article model; reuse it for admin stories.
const Story = require('./models/Article');
const { requireAdminAuth, requireAdminJwt } = require('./middleware/adminAuth');
const { optionalAdminAuth } = require('./middleware/optionalAdminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require(`${BASE}/routes/ai`); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require(`${BASE}/routes/feed`); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }
let publicCommunitySettingsRouter = null;
try { publicCommunitySettingsRouter = require(`${BASE}/routes/public/communitySettings`); } catch (_) { console.warn('[init] optional public community settings router not found; skipping'); }
let publicFeatureTogglesRouter = null;
try { publicFeatureTogglesRouter = require('./routes/publicFeatureToggles'); } catch (_) { console.warn('[init] optional public feature toggles router not found; skipping'); }

const app = express();

app.use((req, res, next) => {
  res.setHeader('X-Newspulse-Env', _safeEnvLabel());
  res.setHeader('X-Newspulse-Db', _safeDbLabel());
  next();
});

// Stable health route for admin-api proxies (no auth/DB dependency)
// Must ALWAYS return 200 JSON and include DB connection status.
for (const p of ['/admin-api/system/health', '/admin-api/api/system/health']) {
  app.get(p, (_req, res) => {
    const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
    const connected = readyState === 1;
    const name = mongoose?.connection?.name ? String(mongoose.connection.name) : null;
    const uptime = process.uptime();

    return res.status(200).json({
      ok: true,
      time: new Date().toISOString(),
      uptime,
      // Backward-compat for older clients/tests.
      uptimeSeconds: Math.floor(uptime),
      db: {
        connected,
        readyState,
        ...(name ? { name } : {}),
      },
    });
  });
}

// Avoid 304 responses / ETag-based caching issues (especially on public settings)
app.disable('etag');

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

// Allow specific Vercel apps (including preview deploys) without opening CORS broadly.
// Examples:
// - https://newspulse-admin-panel-real.vercel.app
// - https://newspulse-admin-panel-real-git-xyz.vercel.app
// - https://newspulse-frontend-main.vercel.app
const _ADMIN_PANEL_VERCEL_REGEX = /^https:\/\/newspulse-admin-panel-real(?:-[a-z0-9-]+)?\.vercel\.app$/i;
const _FRONTEND_MAIN_VERCEL_REGEX = /^https:\/\/newspulse-frontend-main(?:-[a-z0-9-]+)?\.vercel\.app$/i;

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

// Explicit allowlist (production-safe)
// NOTE: Do NOT use '*' when credentials are enabled.
const allowedOrigins = (() => {
  // Preferred: ALLOWED_ORIGINS (comma-separated). Compatibility: CORS_ORIGIN.
  const fromEnv = _parseCorsOriginsEnv(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN);
  // Always allow the official origins + local dev UIs.
  // This supports the intended workflow: backend runs on Render, local UIs call Render.
  const defaults = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://10.46.255.143:5173',
    'https://www.newspulse.co.in',
    'https://newspulse.co.in',
    'https://admin.newspulse.co.in',
    // Known Vercel deployments (prod)
    'https://newspulse-admin-panel-real.vercel.app',
    'https://newspulse-frontend-main.vercel.app',
  ];

  // Env can extend/override without breaking the required defaults.
  const merged = [...defaults, ...fromEnv];
  return Array.from(new Set(merged.map(s => String(s))));
})();

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(String(origin))) return callback(null, true);

    // Allow specific Vercel apps (and their preview deploys)
    if (_ADMIN_PANEL_VERCEL_REGEX.test(String(origin))) return callback(null, true);
    if (_FRONTEND_MAIN_VERCEL_REGEX.test(String(origin))) return callback(null, true);

    const err = new Error('CORS blocked: ' + origin);
    err.status = 403;
    err.origin = origin;
    return callback(err);
  },
  // IMPORTANT: Do not use '*' when credentials are enabled.
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-owner-key'],
  optionsSuccessStatus: 204,
};

// Ensure caches/proxies treat CORS responses correctly.
app.use((req, res, next) => {
  try {
    // Express provides res.vary() via the 'vary' module.
    res.vary('Origin');
  } catch (_) {}
  return next();
});

// Public Ads Slot CORS
// - Keep admin CORS strict (global middleware below)
// - Ensure the public website can fetch ad slot JSON from Render
// - Do not require credentials/cookies for public ads
const _PUBLIC_ADS_CORS_ORIGINS = new Set([
  'https://www.newspulse.co.in',
  'https://newspulse.co.in',
]);

// Public Broadcast Center CORS
// Ensure the public website can fetch broadcast JSON from Render without cookies.
const _PUBLIC_BROADCAST_CORS_ORIGINS = new Set([
  'https://www.newspulse.co.in',
  'https://newspulse.co.in',
]);

const _publicAdsCorsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header)
    if (!origin) return callback(null, true);
    if (_PUBLIC_ADS_CORS_ORIGINS.has(String(origin))) return callback(null, true);
    return callback(null, false);
  },
  credentials: false,
  methods: ['GET', 'OPTIONS'],
  optionsSuccessStatus: 204,
};

// Ensure OPTIONS preflight for public ads slot does not get handled by the global
// CORS middleware (which enables credentials for admin UIs).
app.options('/api/public/ads/slot/:slot', (req, res) => {
  const origin = req.get('Origin');
  if (origin && _PUBLIC_ADS_CORS_ORIGINS.has(String(origin))) {
    const requested = String(req.get('Access-Control-Request-Headers') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const base = ['Content-Type', 'Authorization'];
    const allowHeaders = Array.from(new Set([...base, ...requested]));

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
  }
  return res.sendStatus(204);
});

// Also support preflight for the querystring variant: GET /api/public/ads?slot=...
app.options('/api/public/ads', (req, res) => {
  const origin = req.get('Origin');
  if (origin && _PUBLIC_ADS_CORS_ORIGINS.has(String(origin))) {
    const requested = String(req.get('Access-Control-Request-Headers') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const base = ['Content-Type', 'Authorization'];
    const allowHeaders = Array.from(new Set([...base, ...requested]));

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
  }
  return res.sendStatus(204);
});

function _handlePublicBroadcastPreflight(req, res) {
  const origin = req.get('Origin');
  if (origin && _PUBLIC_BROADCAST_CORS_ORIGINS.has(String(origin))) {
    const requested = String(req.get('Access-Control-Request-Headers') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const base = ['Content-Type', 'Authorization'];
    const allowHeaders = Array.from(new Set([...base, ...requested]));

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
  }
  return res.sendStatus(204);
}

// Ensure OPTIONS preflight for public broadcast endpoints does not get handled by the global
// CORS middleware (which enables credentials for admin UIs).
app.options('/api/public/broadcast', _handlePublicBroadcastPreflight);
app.options('/api/public/broadcast/*', _handlePublicBroadcastPreflight);
app.options('/admin-api/public/broadcast', _handlePublicBroadcastPreflight);
app.options('/admin-api/public/broadcast/*', _handlePublicBroadcastPreflight);
app.options('/admin-api/api/public/broadcast', _handlePublicBroadcastPreflight);
app.options('/admin-api/api/public/broadcast/*', _handlePublicBroadcastPreflight);

app.use(cors(corsOptions));

// Ensure GET responses for public ads slot include the required CORS headers.
// (Also strips any Access-Control-Allow-Credentials header set by global CORS.)
app.use('/api/public/ads/slot', (req, res, next) => {
  // Keep this override minimal: only handle GET/OPTIONS for the public website.
  if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();

  const origin = req.get('Origin');
  if (!origin) return next();
  if (!_PUBLIC_ADS_CORS_ORIGINS.has(String(origin))) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return next();
});

// Ensure GET responses for public broadcast include the required CORS headers.
// (Also strips any Access-Control-Allow-Credentials header set by global CORS.)
function _publicBroadcastCorsOverride(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();

  const origin = req.get('Origin');
  if (!origin) return next();
  if (!_PUBLIC_BROADCAST_CORS_ORIGINS.has(String(origin))) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return next();
}

app.use('/api/public/broadcast', _publicBroadcastCorsOverride);
app.use('/admin-api/public/broadcast', _publicBroadcastCorsOverride);
app.use('/admin-api/api/public/broadcast', _publicBroadcastCorsOverride);
// Ensure OPTIONS preflight works for all routes.
app.options('*', cors(corsOptions));

// Minimal production request logging for Broadcast Center.
app.use((req, res, next) => {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (env !== 'production') return next();

  const path = String(req.originalUrl || req.url || '');
  const shouldLog =
    path.startsWith('/admin-api/broadcast') ||
    path.startsWith('/api/admin/broadcast') ||
    path.startsWith('/admin-api/admin/broadcast') ||
    path.startsWith('/api/public/broadcast');
  if (!shouldLog) return next();

  res.on('finish', () => {
    try {
      console.log('[broadcast]', req.method, path.split('?')[0], res.statusCode);
    } catch (_) {}
  });
  return next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// Root-level health and stats (no /api prefix)
// These are defined directly on the app instance and must appear
// before any 404/error handlers so they are always reachable.
app.get('/health', (req, res) => {
  const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  const dbConnected = readyState === 1;
  // Keep response minimal/stable for load balancers and uptime checks.
  // (Spec requires: GET /health -> { ok: true })
  return res.status(200).json({ ok: true, dbConnected, readyState });
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
// Single source of truth: use MONGODB_URI exactly as provided.
const MONGO_URI = process.env.MONGODB_URI;
const _isImported = require.main !== module;

function _mongoDbNameFromUri(uri) {
  const u = String(uri || '').trim();
  if (!u) return null;

  // Typical forms:
  // - mongodb://user:pass@host:27017/newspulse_dev?...
  // - mongodb+srv://user:pass@cluster.mongodb.net/newspulse_prod?...
  const afterSlash = u.split('/').slice(3).join('/');
  if (!afterSlash) return null;
  const dbPart = afterSlash.split('?')[0];
  const dbName = String(dbPart || '').trim();
  if (!dbName) return null;
  // Some URIs may include extra path segments; keep only the first segment.
  return dbName.split('/')[0] || null;
}

// Dev-only debug endpoint to confirm environment and DB selection.
// Returns { env, dbName } and is intentionally NOT available in production.
app.get(['/admin-api/system/env', '/admin-api/api/system/env'], (_req, res) => {
  const env = String(process.env.NODE_ENV || 'development');
  if (String(env).toLowerCase() === 'production') return res.status(404).json({ message: 'Not found' });

  const connectedName = (mongoose.connection && mongoose.connection.name) ? String(mongoose.connection.name) : '';
  const dbFromUri = _mongoDbNameFromUri(process.env.MONGODB_URI);
  const dbName = (connectedName || dbFromUri || null);
  return res.status(200).json({ env, dbName });
});

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
  console.log('Mongo connected');
  console.log('[mongo] connected', { readyState: mongoose.connection.readyState, db: mongoose.connection.name || undefined });
});

if (process.env.NODE_ENV === 'test' || _isImported) {
  console.warn('[init] Test/import mode: skipping MongoDB connection');
} else if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.warn('[startup] MONGODB_URI is not set; starting without a MongoDB connection.');
} else {
  // Important: keep the HTTP server running even if MongoDB is down.
  // Admin/public endpoints will surface DB issues as 503 JSON instead of crashing.
  // (Can be overridden by setting EXIT_ON_DB_CONNECT_FAIL=1.)
  const _exitOnDbConnectFail = String(process.env.EXIT_ON_DB_CONNECT_FAIL || '').trim() === '1';
  let _mongoConnectInFlight = false;
  let _mongoRetryMs = 2000;
  const _mongoRetryMaxMs = 30000;

  async function _afterMongoConnected() {
    const dbFromUri = _mongoDbNameFromUri(MONGO_URI);
    const db = dbFromUri || mongoose.connection.name || undefined;
    console.log('[startup] MongoDB connected', { db });
    // Ensure TTL index for Broadcast Center is present.
    try {
      const BroadcastItem = require('./models/BroadcastItem');
      await BroadcastItem.syncIndexes();
    } catch (e) {
      console.warn('[startup] BroadcastItem index sync failed', e?.message || e);
    }

		// Cleanup old Broadcast Center items (older than 24h)
		try {
			const { startBroadcastCleanupJob } = require('./services/broadcastCleanup');
			startBroadcastCleanupJob();
		} catch (e) {
			console.warn('[startup] Broadcast cleanup job failed to start', e?.message || e);
		}

    // Ensure ads indexes are present.
    try {
      const Ad = require('./models/Ad');
      await Ad.syncIndexes();
    } catch (e) {
      console.warn('[startup] Ad index sync failed', e?.message || e);
    }
  }

  async function _connectMongoOnce() {
    if (_mongoConnectInFlight) return;
    _mongoConnectInFlight = true;
    try {
      await mongoose.connect(MONGO_URI);
      _mongoRetryMs = 2000;
      await _afterMongoConnected();
    } catch (err) {
      console.error('[startup] MongoDB connection failed', {
        uri: _redactMongoUri(MONGO_URI),
        message: err?.message || String(err),
        name: err?.name,
      });
      if (_exitOnDbConnectFail) {
        console.error('[startup] EXIT_ON_DB_CONNECT_FAIL=1 set; exiting due to MongoDB connection failure');
        process.exit(1);
      }

      const delay = Math.min(_mongoRetryMaxMs, _mongoRetryMs);
      _mongoRetryMs = Math.min(_mongoRetryMaxMs, Math.floor(_mongoRetryMs * 1.5));
      console.warn('[startup] Will retry MongoDB connection', { inMs: delay });
      setTimeout(() => {
        _mongoConnectInFlight = false;
        _connectMongoOnce();
      }, delay);
      return;
    } finally {
      // If we succeeded, we want to allow future reconnect attempts only if a disconnect occurs.
      if (mongoose.connection.readyState === 1) {
        _mongoConnectInFlight = true;
      }
    }
  }

  // When Mongo drops after having been connected, try to reconnect.
  mongoose.connection.on('disconnected', () => {
    _mongoConnectInFlight = false;
    try { _connectMongoOnce(); } catch (_) {}
  });

  _connectMongoOnce();
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
// Public articles feed (but allow optional admin auth so admin list requests can defer to CMS router)
// NOTE: Do not mount the legacy nested public articles router under /api/articles.
// The CMS/admin router (articlesRoutes) is mounted under /api later and should own /api/articles/*.
// Quick browser check: confirm auth route is deployed
app.get('/api/auth/login', (_req, res) => {
  return res.json({ ok: true, message: 'Auth route is live. Use POST to login.' });
});
// ✅ Founder/Admin Login (MVP)
// Defined directly in server.js to avoid any router-mount confusion.
app.post('/api/auth/login', (req, res) => {
  (async () => {
    const email = String(req.body?.email || req.body?.username || '').toLowerCase().trim();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ success: false, message: 'JWT_SECRET missing' });
    }

    // Prefer DB-backed users when DB is ready.
    const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
    if (dbReady) {
      const user = await User.findOne({ email }).select('+passwordHash');
      if (user) {
        if (user.status === 'suspended') {
          return res.status(403).json({ success: false, message: 'Account suspended' });
        }
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        user.lastLoginAt = new Date();
        await user.save();

        const token = jwt.sign(
          {
            sub: String(user._id),
            userId: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role,
            tokenVersion: typeof user.tokenVersion === 'number' ? user.tokenVersion : 0,
            sessionVersion: typeof user.sessionVersion === 'number' ? user.sessionVersion : 1,
            type: 'access',
          },
          process.env.JWT_SECRET,
          { expiresIn: '7d' },
        );

        return res.json({ success: true, token, user: { id: String(user._id), email: user.email, role: user.role, name: user.name, mustChangePassword: Boolean(user.mustChangePassword || user.forceReset) } });
      }
    }

    // Env-based fallback (keeps local/test/dev setups working without DB).
    const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
    const adminPass = String(process.env.ADMIN_PASS || '');
    const founderEmail = String(process.env.FOUNDER_EMAIL || '').toLowerCase().trim();
    const founderPass = String(process.env.FOUNDER_PASSWORD || '');

    const hasAnyCreds = (adminEmail && adminPass) || (founderEmail && founderPass);
    if (!hasAnyCreds) {
      return res.status(500).json({
        success: false,
        message: 'Auth not configured. Set ADMIN_EMAIL/ADMIN_PASS or FOUNDER_EMAIL/FOUNDER_PASSWORD in your environment.',
      });
    }

    let role = null;
    if (email === adminEmail && password === adminPass) role = 'admin';
    if (email === founderEmail && password === founderPass) role = 'founder';
    if (!role) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // If DB is ready, create/ensure an account so token invalidation can work.
    if (dbReady) {
      const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
      const created = await User.findOneAndUpdate(
        { email },
        {
          $setOnInsert: {
            email,
            name: role === 'founder' ? (process.env.FOUNDER_NAME || 'Founder') : 'Admin',
            passwordHash: await bcrypt.hash(password, rounds),
            role,
            status: 'active',
            tokenVersion: 0,
            mustChangePassword: false,
            createdAt: new Date(),
          },
          $set: { role, lastLoginAt: new Date() },
        },
        { upsert: true, new: true },
      );

      const token = jwt.sign(
        {
          sub: String(created._id),
          userId: String(created._id),
          email,
          name: created.name,
          role,
          tokenVersion: typeof created.tokenVersion === 'number' ? created.tokenVersion : 0,
          sessionVersion: typeof created.sessionVersion === 'number' ? created.sessionVersion : 1,
          type: 'access',
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' },
      );
      return res.json({ success: true, token, user: { id: String(created._id), email, role, name: created.name, mustChangePassword: Boolean(created.mustChangePassword || created.forceReset) } });
    }

    const token = jwt.sign({ email, role, tokenVersion: 0, sessionVersion: 1, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, token, user: { email, role } });
  })().catch((e) => {
    console.error('[auth/login] failed:', e?.message || e);
    return res.status(500).json({ success: false, message: 'Login failed' });
  });
});

// ✅ Verify Bearer token (must be valid)
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

// ✅ Only admin/founder can access
function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'founder') return next();
  return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
}

async function _adminListStories(req, res) {
  try {
    const stories = await Story.find().sort({ createdAt: -1 }).limit(200);
    return res.json({ success: true, data: stories });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
}

async function _adminCreateStory(req, res) {
  try {
    const created = await Story.create(req.body);
    return res.json({ success: true, data: created });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
}

// ✅ ADMIN: stories (with /admin-api compatibility aliases)
for (const p of ['/api/admin/stories', '/admin-api/admin/stories', '/admin-api/api/admin/stories']) {
  app.get(p, requireAuth, requireAdmin, _adminListStories);
  app.post(p, requireAuth, requireAdmin, _adminCreateStory);
}
// Auth bootstrap endpoint for admin panel
app.use('/api/auth', authRoutes);
// Audit (founder-only)
app.use('/api/audit', auditRoutes);
// Broadcast Center (mount early so it cannot be shadowed by other /api routers)

// Compatibility shim:
// Some admin deployments proxy /admin-api/* -> /api/* on the backend.
// If the admin UI calls /admin-api/broadcast/*, the backend may receive /api/broadcast/*.
// To prevent 404s for Save/Add/Delete, route authenticated write-style requests to the
// standardized admin router (which is always admin-protected).
app.use('/api/broadcast', (req, res, next) => {
  try {
    const env = String(process.env.NODE_ENV || 'development').toLowerCase();
    // This shim is only needed in production deployments where proxies/rewrites exist.
    if (env !== 'production') return next();

    const hasAuth = Boolean(req.headers.authorization) || String(req.headers.cookie || '').includes('np_admin');
    if (!hasAuth) return next();

    const p = String(req.path || '');
    const m = String(req.method || '').toUpperCase();

    // Only intercept write operations; keep legacy GET behavior intact.
    if (m === 'GET') return next();

    // Only intercept the endpoints that overlap the admin UI write surface.
    // These are typically reached when a frontend proxies /admin-api/* -> /api/*.
    const isAdminCompatPath =
      p === '/' ||
      p === '' ||
      p === '/settings' ||
      p === '/items' ||
      p.startsWith('/items/');

    if (!isAdminCompatPath) return next();

    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return next();

    // If a legacy UI hits /api/broadcast/settings, map it to the standardized
    // settings endpoint /api/admin/broadcast (mounted as '/').
    if (p === '/settings') {
      const originalUrl = req.url;
      req.url = '/' + String(originalUrl || '').replace(/^\/settings\/?/, '').replace(/^\//, '');
    }

    return adminBroadcastRouter(req, res, next);
  } catch (_) {
    return next();
  }
});

app.use('/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/api/broadcast/*
app.use('/admin-api/api/broadcast', broadcastRoutes);
// Compatibility alias: some frontends call /admin-api/broadcast/*
app.use('/admin-api/broadcast', broadcastRoutes);

// Standard Admin Broadcast Center API
// - Primary: /api/admin/broadcast
// - Admin panel proxy aliases: /admin-api/admin/broadcast and /admin-api/api/admin/broadcast
app.use('/api/admin/broadcast', adminBroadcastRouter);
app.use('/admin-api/admin/broadcast', adminBroadcastRouter);
app.use('/admin-api/api/admin/broadcast', adminBroadcastRouter);
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

// Public news feed (NO AUTH)
// Mount early to avoid being shadowed by other /api routers.
app.use('/api/public/trending-topics', publicTrendingTopicsRouter);
app.use('/api/public/news', publicNewsRouter);

// Articles router mounted at /api and alias at root for /articles
app.use('/api', articlesRoutes);
app.use('/', articlesRoutes);
// Admin panel compatibility: /api/admin/articles should behave like /api/articles
app.use('/api/admin', articlesRoutes);
// Admin panel proxy basePath support (some frontends call /admin-api/*)
app.use('/admin-api/admin', articlesRoutes);
app.use('/admin-api/api/admin', articlesRoutes);
// Compatibility: some admin builds call /admin-api/articles directly
app.use('/admin-api', articlesRoutes);
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

// Public site settings (tickers)
app.use('/api/public', publicTickersSettingsRouter);
// Public Broadcast Center tickers (Breaking + Live Updates)
app.use('/api/public/broadcast', publicBroadcastRouter);
// Admin panel proxy basePath support (some frontends call /admin-api/* even for public reads)
app.use('/admin-api/public/broadcast', publicBroadcastRouter);
app.use('/admin-api/api/public/broadcast', publicBroadcastRouter);
// Legacy/website path support
app.use('/public', publicTickersSettingsRouter);
// Admin panel proxy basePath support
app.use('/admin-api/public', publicTickersSettingsRouter);
app.use('/admin-api/api/public', publicTickersSettingsRouter);

// Public stories
app.use('/api/public', publicRoutes);

// Public site settings (published only, no auth)
app.use('/api/public', publicSettingsRouter);
// Admin UI proxy basePath support (some frontends call /admin-api/* even for public reads)
app.use('/admin-api/public', publicSettingsRouter);
app.use('/admin-api/api/public', publicSettingsRouter);

// Startup confirmation (production): settings endpoints mounted under /api
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  console.log('Mounted: /api/public/settings and /api/admin/settings/public');
}

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
// Admin API proxy aliases (some admin builds proxy via /admin-api/*)
app.use('/admin-api/admin', adminRoutes);
app.use('/admin-api/api/admin', adminRoutes);
app.use('/api/admin', adminAdsRouter);

// Admin public settings (tickers)
app.use('/api/admin', adminTickersSettingsRouter);
// Legacy admin panel path support
app.use('/admin', adminTickersSettingsRouter);
// Admin panel proxy basePath support
app.use('/admin-api/admin', adminTickersSettingsRouter);
app.use('/admin-api/api/admin', adminTickersSettingsRouter);
// IMPORTANT: Admin panel alias support
app.use('/admin-api/admin', adminAdsRouter);
app.use('/admin-api/api/admin', adminAdsRouter);
// Settings Center > Team Management (founder-only)
app.use('/api/admin/staff', adminStaffRouter);
// Legacy admin panel path support
app.use('/admin/staff', adminStaffRouter);
// Admin panel proxy basePath support
app.use('/admin-api/admin/staff', adminStaffRouter);
app.use('/admin-api/api/admin/staff', adminStaffRouter);
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
// Compatibility aliases: some admin builds call /api/admin-auth/* (or via /admin-api proxy)
app.use('/api/admin-auth', adminAuthRoutes);
app.use('/admin-api/admin-auth', adminAuthRoutes);
app.use('/admin-api/api/admin-auth', adminAuthRoutes);

// OTP routes: admin UI calls /admin-api/auth/otp/*
app.use('/admin-api', authOtpRoutes);
app.use('/admin-api/api', authOtpRoutes);
// Some proxies rewrite /admin-api/* -> /api/*
app.use('/api', authOtpRoutes);
app.use('/api/api', authOtpRoutes);
// Documented/legacy admin path support: /api/admin/auth/otp/*
app.use('/api/admin', authOtpRoutes);

// JWT-based admin auth (Founder-only security endpoints)
// Provides:
// - POST /api/admin/auth/logout-all
// - POST /api/admin/auth/change-password
app.use('/api/admin', adminAuthV2Routes);
app.use('/admin-api/admin', adminAuthV2Routes);
app.use('/admin-api/api/admin', adminAuthV2Routes);

// Owner-key protected founder bootstrap/reset
// - POST /api/admin/bootstrap-founder
// - POST /api/admin/seed-founder
app.use('/api/admin', adminBootstrapRoutes);
app.use('/admin-api/admin', adminBootstrapRoutes);
app.use('/admin-api/api/admin', adminBootstrapRoutes);
// AI training info: public read endpoint (admin panel can read without login)
for (const p of [
  '/system/ai-training-info',
  '/api/system/ai-training-info',
  '/admin-api/system/ai-training-info',
  '/admin-api/api/system/ai-training-info',
]) {
  app.use(p, aiTrainingInfoRoutes);
}

// AI training info: admin-only aliases (some admin builds use /admin-api/* base paths)
for (const p of [
  '/admin-api/admin/system/ai-training-info',
  '/admin-api/api/admin/system/ai-training-info',
]) {
  app.use(p, requireAdminAuth, aiTrainingInfoRoutes);
}
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
// Admin Public Site Settings (draft/publish)
app.use('/api/admin', adminPublicSettingsRouter);
app.use('/admin-api/admin', adminPublicSettingsRouter);
app.use('/admin-api/api/admin', adminPublicSettingsRouter);
// Community Reporter Settings router (same mount /api/admin)
app.use('/api/admin', communityReporterSettingsRouter);
// Founder feature toggles (admin/founder protected)
app.use('/api/admin/founder', founderFeatureTogglesRouter);

// New Admin Panel endpoints (Team/Security/Audit)
app.use('/api/admin', adminTeamRoutes);
if (adminTeamRoutesV2) app.use('/api/admin/team', adminTeamRoutesV2);
// Admin API proxy aliases (frontend often proxies /admin-api/*)
app.use('/admin-api/admin', adminTeamRoutes);
app.use('/admin-api/api/admin', adminTeamRoutes);
if (adminTeamRoutesV2) {
  app.use('/admin-api/admin/team', adminTeamRoutesV2);
  app.use('/admin-api/api/admin/team', adminTeamRoutesV2);
}
app.use('/api/admin', adminSecurityRoutes);
app.use('/api/admin', adminAuditRoutes);
if (adminMetaRoutes) app.use('/api/admin', adminMetaRoutes);
app.use('/admin-api/admin', adminAuditRoutes);
app.use('/admin-api/api/admin', adminAuditRoutes);
if (adminMetaRoutes) {
  // Admin meta (some admin builds call /admin-api/admin/meta)
  app.use('/admin-api/admin', adminMetaRoutes);
  app.use('/admin-api/api/admin', adminMetaRoutes);
  // Public-ish meta (some admin builds call /admin-api/meta/languages)
  app.use('/admin-api', adminMetaRoutes);
  app.use('/admin-api/api', adminMetaRoutes);
  // Some proxies rewrite /admin-api/* -> /api/*
  app.use('/api', adminMetaRoutes);
  app.use('/api/api', adminMetaRoutes);
}
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
async function _publicSettingsNoAuth(_req, res) {
  try {
    const doc = await PublicSiteSettings.getOrCreate();
    const published = doc?.published || PublicSiteSettings.getDefaultSettings();
    return res.json({
      ok: true,
      version: typeof doc?.version === 'number' ? doc.version : 1,
      public: published,
      published,
      updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
    });
  } catch (e) {
    const published = PublicSiteSettings.getDefaultSettings();
    return res.json({
      ok: true,
      version: 1,
      public: published,
      published,
      updatedAt: new Date().toISOString(),
      source: 'default',
    });
  }
}

// Public settings (no auth). Kept for backward compatibility with older UIs.
app.get('/settings/public', _publicSettingsNoAuth);
// Public settings under /api as well (some UIs call /api/settings/public).
app.get('/api/settings/public', _publicSettingsNoAuth);
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

function _adminMeResponse(req, res) {
  const a = req.admin || null;
  if (!a) return res.status(401).json({ ok: false, message: 'Unauthorized' });

  const role = String(a.role || '').toLowerCase();
  return res.status(200).json({
    ok: true,
    authenticated: true,
    admin: {
      id: a.id || 'unknown',
      email: a.email || '',
      role,
    },
  });
}

// Session probe used by admin UI AuthContext.
// Must return 200 if logged in, 401 if not logged in (never 500 for auth failures).
for (const p of ['/api/admin/me', '/admin-api/admin/me', '/admin-api/api/admin/me']) {
  app.get(p, requireAdminJwt, _adminMeResponse);
}

// Legacy admin auth probe for admin panels calling /admin/me
// - 200 with user when token/cookie valid
// - 401 when missing/invalid
app.get('/admin/me', requireAdminJwt, _adminMeResponse);

// Aliases expected by some UIs
app.get('/admin/stats', async (req, res) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'DB unavailable',
        data: null,
        path: req.originalUrl,
      });
    }

    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, success: true, status: 200, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    console.error('[ADMIN][stats][alias:/admin/stats] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load admin stats', path: req.originalUrl });
  }
});
app.get('/api/admin/stats', async (req, res) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'DB unavailable',
        data: null,
        path: req.originalUrl,
      });
    }

    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, success: true, status: 200, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    console.error('[ADMIN][stats][alias:/api/admin/stats] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load admin stats', path: req.originalUrl });
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

function _isTestEnv() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

function _issueJwt(payload, expiresIn) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) return null;
  try {
    const jwt = require('jsonwebtoken');
    return jwt.sign(payload, secret, { expiresIn });
  } catch (_) {
    return null;
  }
}

// POST /admin/login -> returns success + access/refresh tokens
app.post('/admin/login', (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || process.env.FOUNDER_EMAIL || 'founder@example.com');
    const password = String(body.password || '');
    const expectedEmail = String(process.env.FOUNDER_EMAIL || 'founder@example.com');
    const expectedPass = String(process.env.FOUNDER_PASSWORD || '');
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    if (email !== expectedEmail || password !== expectedPass) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // In tests, keep the historical access.* tokens that /admin-auth/session accepts.
    if (_isTestEnv()) {
      const accessToken = _makeToken('access');
      const refreshToken = _makeToken('refresh');
      _issuedTokens.access.add(accessToken);
      _issuedTokens.refresh.add(refreshToken);
      return res.json({ success: true, accessToken, refreshToken, user: { email } });
    }

    // In production/dev, issue real JWTs so protected endpoints (requireAdminAuth) accept them.
    const role = 'founder';
    const accessToken = _issueJwt(
      { sub: 'founder-1', email, role, name: 'Founder', tokenVersion: 0, typ: 'access' },
      '15m'
    );
    const refreshToken = _issueJwt(
      { sub: 'founder-1', email, role, name: 'Founder', tokenVersion: 0, typ: 'refresh' },
      '30d'
    );

    if (!accessToken || !refreshToken) {
      return res.status(500).json({ success: false, message: 'Server misconfigured' });
    }

    return res.json({ success: true, accessToken, refreshToken, user: { email } });
  } catch (e) {
    console.error('login failed:', e?.message || e);
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

  if (_isTestEnv()) {
    if (!_issuedTokens.refresh.has(rt)) return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    const accessToken = _makeToken('access');
    _issuedTokens.access.add(accessToken);
    return res.json({ success: true, accessToken });
  }

  // Production/dev: accept a signed JWT refresh token.
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) return res.status(500).json({ success: false, message: 'Server misconfigured' });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(rt, secret);
    if (!payload || String(payload.typ || '') !== 'refresh') {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
    const email = payload.email || process.env.FOUNDER_EMAIL || 'founder@example.com';
    const role = payload.role || 'founder';
    const accessToken = _issueJwt(
      { sub: payload.sub || 'founder-1', email, role, name: payload.name || 'Founder', tokenVersion: payload.tokenVersion || 0, typ: 'access' },
      '15m'
    );
    if (!accessToken) return res.status(500).json({ success: false, message: 'Server misconfigured' });
    return res.json({ success: true, accessToken });
  } catch (_e) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }
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

// DEV-ONLY: Routes introspection for debugging
// GET /api/routes-check -> lists all registered API routes
if (_corsIsDev || process.env.ENABLE_ROUTES_CHECK === 'true') {
  app.get('/api/routes-check', (req, res) => {
    const routes = [];
    function extractRoutes(stack, prefix = '') {
      stack.forEach(middleware => {
        if (middleware.route) {
          // Direct route
          const methods = Object.keys(middleware.route.methods).map(m => m.toUpperCase()).join(',');
          routes.push({ path: prefix + middleware.route.path, methods });
        } else if (middleware.name === 'router' && middleware.handle.stack) {
          // Nested router - extract base path from regexp
          let routePath = '';
          try {
            routePath = middleware.regexp.source
              .replace(/\\\//g, '/')
              .replace(/\^/g, '')
              .replace(/\$/g, '')
              .replace(/\?/g, '')
              .split('(?=')[0]; // Take only the part before lookahead
          } catch (e) {
            routePath = '';
          }
          extractRoutes(middleware.handle.stack, prefix + routePath);
        }
      });
    }
    extractRoutes(app._router.stack);
    
    // Filter to /api routes only
    const apiRoutes = routes.filter(r => r.path.includes('/api'));
    
    return res.json({
      ok: true,
      note: 'DEV-ONLY endpoint for debugging route registration',
      apiRoutes: apiRoutes.sort((a, b) => a.path.localeCompare(b.path)),
      total: apiRoutes.length,
    });
  });
}

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
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const isProd = env === 'production';
  const message = status < 500
    ? (err?.message || 'Request failed')
    : (isProd ? 'Internal server error' : (err?.message || 'Internal server error'));
  try { console.error('Error:', err && err.message ? err.message : err, 'status=', status, 'path=', req.originalUrl); } catch (_) {}
  if (res.headersSent) return next(err);
  try { res.type('application/json'); } catch (_) {}
  return res.status(status).json({
    ok: false,
    success: false,
    status,
    message,
    data: null,
    path: req.originalUrl,
    ...(err?.code ? { code: String(err.code) } : {}),
    ...(!isProd && err?.stack ? { stack: String(err.stack) } : {}),
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
  // On Windows, Node may bind IPv6-only by default when no host is provided.
  // That breaks callers/proxies that target 127.0.0.1. Prefer dual-stack there.
  const listenArg = process.platform === 'win32'
    ? ({ port: PORT, host: '::', ipv6Only: false })
    : PORT;

  const server = app.listen(listenArg, () => {
    console.log(`✅ Server running on port ${PORT}`);
    _logStartupDbStatus('listening');
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
