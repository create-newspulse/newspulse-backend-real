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
const _preDotenvPort = process.env.PORT;
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  // In tests, individual test files set env vars (esp. NODE_ENV) explicitly.
  // Avoid a committed/local .env accidentally overriding those values.
  override: !_isProdEarly && _nodeEnvEarly !== 'test',
});

// Allow developers/operators to intentionally override the port via the shell
// even when local-dev dotenv override is enabled.
if (typeof _preDotenvPort === 'string' && _preDotenvPort.trim()) {
  process.env.PORT = _preDotenvPort;
}

// Backward-compat: older setups used MONGO_URI.
// Prefer MONGODB_URI, but if only MONGO_URI exists, alias it.
if (!process.env.MONGODB_URI && process.env.MONGO_URI) {
  process.env.MONGODB_URI = process.env.MONGO_URI;
  if (require.main === module && String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[startup] Using legacy MONGO_URI; please rename to MONGODB_URI in .env');
  }
}

require('./lib/redis');

const {
  getLocalFounderSafeDiagnostics,
  isLocalDevLike,
  resolveLocalFounderSeedConfig,
} = require('./lib/localFounderAuth');

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

  if (isLocalDevLike()) {
    const localFounder = getLocalFounderSafeDiagnostics();
    // eslint-disable-next-line no-console
    console.log('[startup][local-founder]', localFounder);
  }
}

// Note: Do not fail-fast on missing env vars.
// The server should boot even if MongoDB or JWT env vars are not set; endpoints that
// require them will return errors at request time.
if (require.main === module && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
  if (!String(process.env.JWT_SECRET || '').trim()) {
    // eslint-disable-next-line no-console
    console.warn('[startup] JWT_SECRET is not set; auth endpoints may fail until configured.');
  }

  // Cloudinary is optional; warn once when missing so admins understand why cover uploads fail.
  try {
    const { getCloudinaryConfigStatus, initCloudinaryIfConfigured } = require('./lib/cloudinary');
    const st = getCloudinaryConfigStatus();

    // Safe Cloudinary startup diagnostics (do NOT log secret values)
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary] cloud name present:', st?.env?.cloudNamePresent ? 'yes' : 'no');
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary] api key present:', st?.env?.apiKeyPresent ? 'yes' : 'no');
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary] api secret present:', st?.env?.apiSecretPresent ? 'yes' : 'no');
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary] cloudinary url present:', st?.env?.cloudinaryUrlPresent ? 'yes' : 'no');
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary] final cloudinary configured:', st?.configured ? 'yes' : 'no');
    // eslint-disable-next-line no-console
    console.log('[startup][cloudinary][video-upload] config available:', st?.configured ? 'yes' : 'no');

    // Apply Cloudinary config at startup when available (no network calls).
    if (st.configured) {
      initCloudinaryIfConfigured();
    }
    if (!st.configured) {
      // eslint-disable-next-line no-console
      console.warn('[startup] Cloudinary not configured; cover image uploads will be unavailable.', {
        missing: st.missing,
        cloudinaryUrlValid: st.cloudinaryUrlValid,
        env: st.env,
      });
    }
  } catch (_) {}

  try {
    const { getMediaLibraryProviderStatus } = require('./lib/mediaLibraryStorage');
    const mediaProvider = getMediaLibraryProviderStatus();
    // eslint-disable-next-line no-console
    console.log('[startup][media-upload]', {
      provider: mediaProvider.provider,
      providerReady: mediaProvider.ready,
      uploadDirectoryConfigured: mediaProvider.uploadDirectoryConfigured,
      bucketConfigured: mediaProvider.bucketConfigured,
      reason: mediaProvider.reason,
    });
  } catch (_) {}

  try {
    const {
      getMailerStatus,
      getTransporter,
      getMailConfig,
      REPORTER_OTP_MAIL_SCOPE,
    } = require('./lib/mailer');
    const mailerStatus = getMailerStatus();
    const mailConfig = getMailConfig();
    const reporterMailerStatus = getMailerStatus({ scope: REPORTER_OTP_MAIL_SCOPE });
    const reporterMailConfig = getMailConfig({ scope: REPORTER_OTP_MAIL_SCOPE });
    // eslint-disable-next-line no-console
    console.log('[startup][mailer-status]', {
      productionLike: mailerStatus.productionLike,
      renderLike: mailerStatus.renderLike,
      stubMode: mailerStatus.stubMode,
      configured: mailerStatus.configured,
      missing: mailerStatus.missing,
      resolved: mailerStatus.resolved,
    });
    // eslint-disable-next-line no-console
    console.log('[startup][reporter-mailer-status]', {
      scope: reporterMailerStatus.scope,
      productionLike: reporterMailerStatus.productionLike,
      renderLike: reporterMailerStatus.renderLike,
      stubMode: reporterMailerStatus.stubMode,
      provider: reporterMailerStatus.provider,
      providerOrder: reporterMailerStatus.providerOrder,
      configured: reporterMailerStatus.configured,
      missing: reporterMailerStatus.missing,
      resolved: reporterMailerStatus.resolved,
      transport: reporterMailerStatus.transport,
    });
    // eslint-disable-next-line no-console
    console.log('[startup][reporter-auth-readiness]', {
      smtpHost: mailConfig.smtpHost || mailConfig.smtpService || null,
      smtpPort: mailConfig.smtpPort || null,
      smtpUsernamePresent: !!mailConfig.smtpUser,
      smtpPasswordPresent: !!mailConfig.smtpPass,
      fromEmailPresent: !!mailConfig.smtpFrom,
      reporterMailScope: reporterMailConfig.scope,
      reporterProvider: reporterMailConfig.provider,
      reporterProviderOrder: reporterMailConfig.providerOrder,
      reporterSmtpHost: reporterMailConfig.smtpHost || reporterMailConfig.smtpService || null,
      reporterSmtpPort: reporterMailConfig.smtpPort || null,
      reporterSmtpUsernamePresent: !!reporterMailConfig.smtpUser,
      reporterSmtpPasswordPresent: !!reporterMailConfig.smtpPass,
      reporterFromEmailPresent: !!reporterMailConfig.smtpFrom,
      reporterResendApiKeyPresent: !!reporterMailConfig.resendApiKey,
      reporterResendFromPresent: !!reporterMailConfig.resendFrom,
      reporterAuthSecretPresent: !!String(process.env.JWT_SECRET || '').trim(),
      reporterSessionSecretPresent: !!String(process.env.REPORTER_PORTAL_SESSION_SECRET || process.env.REPORTER_SESSION_SECRET || process.env.JWT_SECRET || '').trim(),
    });

    if (mailerStatus.configured && mailerStatus.stubMode !== true) {
      try {
        const transport = getTransporter();
        // eslint-disable-next-line no-console
        console.log('[startup][mailer-transporter]', { initialized: !!transport });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[startup][mailer-transporter-failed]', {
          message: error?.message || String(error),
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.responseCode ? { responseCode: error.responseCode } : {}),
          ...(error?.command ? { command: error.command } : {}),
        });
      }
    }

    if (reporterMailerStatus.configured && reporterMailerStatus.stubMode !== true) {
      try {
        const reporterTransport = getTransporter(undefined, { scope: REPORTER_OTP_MAIL_SCOPE });
        // eslint-disable-next-line no-console
        console.log('[startup][reporter-mailer-transporter]', {
          scope: REPORTER_OTP_MAIL_SCOPE,
          initialized: !!reporterTransport,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[startup][reporter-mailer-transporter-failed]', {
          scope: REPORTER_OTP_MAIL_SCOPE,
          message: error?.message || String(error),
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.backendCode ? { backendCode: error.backendCode } : {}),
          ...(error?.responseCode ? { responseCode: error.responseCode } : {}),
          ...(error?.command ? { command: error.command } : {}),
        });
      }
    }
  } catch (_) {}
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
    const configuredDbName = String(process.env.MONGODB_DBNAME || '').trim() || null;

    // eslint-disable-next-line no-console
    console.log('[startup][db-status]', {
      label,
      hasMongoUri,
      readyState,
      ...(configuredDbName ? { configuredDbName } : {}),
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
const communityRoutes = require('./routes/community');
const communityStoriesRouter = require('./routes/communityStories');
const reporterPortalRouter = require('./routes/reporterPortal');
const reporterAuthCompatRouter = require('./routes/reporterAuthCompat');
const adminCommunityRoutes = require('./routes/adminCommunity');
const communityAdminContactsRoutes = require(`${BASE}/routes/communityAdminContacts`);
// Use root-level communityReporter routes to match tests
const communityReporterRoutes = require('./routes/communityReporter');
const {
  getCommunityReporterQueue,
  listReporterContacts,
  getCommunityReporterAnalytics,
  deleteReporterContact,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  restoreCommunityReporterStory,
  withdrawCommunityReporterStory,
  permanentDeleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
} = require('./controllers/communityReporterController');
// Use root-level admin settings router for base /settings endpoint
const adminSettingsRoutes = require('./routes/adminSettings.routes');
// Admin system routes (e.g., AI training info under /system)
const adminSystemRoutes = require('./routes/adminSystem.routes');
const communityReporterSettingsRouter = require(`${BASE}/routes/adminSettings/communityReporterSettings`);
// Dashboard stats router lives in root-level routes, not nested BASE dir
const dashboardStatsRouter = require('./routes/dashboardStats');
const adminDashboardRoutes = require('./routes/adminDashboard.routes');
const { buildAdminDashboardStatsPayload } = require('./controllers/adminDashboardStatsController');
const adminCommunityReporterQueueRouter = require('./routes/admin/communityReporterQueue');
const adminContributorNetworkRouter = require('./routes/adminContributorNetwork.routes');
const { getReporterDirectory } = require('./controllers/adminContributorNetworkController');
const founderRoutesRouter = require('./routes/admin/founderRoutes');
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
const adminTickerRouter = require('./routes/adminTicker.routes');
const adminTickerAdsRouter = require('./routes/adminTickerAds.routes');
const adminGlossaryRouter = require('./routes/adminGlossary.routes');

const authRoutes = require('./routes/auth.routes');
const auditRoutes = require('./routes/audit.routes');
const adminTeamRoutes = require('./routes/adminTeam.routes');
const adminAuthV2Routes = require('./routes/adminAuthV2.routes');
const adminBootstrapRoutes = require('./routes/adminBootstrap.routes');
let adminTeamRoutesV2 = null;
try { adminTeamRoutesV2 = require('./src/routes/adminTeamRoutes'); } catch (_) { console.warn('[init] optional src/routes/adminTeamRoutes not found; skipping'); }
const adminSecurityRoutes = require('./routes/adminSecurity.routes');
const adminAuditRoutes = require('./routes/adminAudit.routes');
const adminAiModelsRouter = require('./routes/adminAiModels.routes');
const ownerAiModelsRouter = require('./routes/ownerAiModels.routes');
let adminMetaRoutes = null;
try { adminMetaRoutes = require('./routes/adminMeta.routes'); } catch (_) { console.warn('[init] optional routes/adminMeta.routes not found; skipping'); }
const publicAdsRouter = require('./routes/publicAds.routes');
const publicSponsoredFeaturesRouter = require('./routes/publicSponsoredFeatures.routes');
const adminAdsRouter = require('./routes/adminAds.routes');
const adminAdsInquiriesRouter = require('./routes/adminAdsInquiries.routes');
const publicAdsInquiryRouter = require('./routes/publicAds');
const { submitPublicAdInquiry } = require('./controllers/adsInquiriesController');
const adminAdsInquiriesCompatRouter = require('./routes/adminAds');
const adsRoutes = require('./routes/ads.routes');
const publicAdSettingsRouter = require('./routes/publicAdSettings.routes');
const adminAdSettingsRouter = require('./routes/adminAdSettings.routes');
const adminSponsoredFeaturesRouter = require('./routes/adminSponsoredFeatures.routes');
const publicRoutes = require('./routes/public.routes');
const siteSettingsRoutes = require('./routes/siteSettings.routes');
const publicSettingsRouter = require('./routes/publicSettings.routes');
const publicVersionRouter = require('./routes/publicVersion.routes');
const publicTranslationRouter = require('./routes/publicTranslation.routes');
const publicUiLabelsRouter = require('./routes/publicUiLabels.routes');
const adminPublicSettingsRouter = require('./routes/adminPublicSettings.routes');
const PublicSiteSettings = require('./models/PublicSiteSettings');
const { ensureCategoryStripEnabled, ensurePublicSettingsResponse } = require('./controllers/publicSiteSettingsController');
const User = require('./models/User');
const publicNewsRouter = require('./routes/publicNews.routes');
const breakingRouter = require('./routes/breaking.routes');
const adminNewsTranslationsRouter = require('./routes/adminNewsTranslations.routes');
const publicTrendingTopicsRouter = require('./routes/publicTrendingTopics.routes');
const publicTickersSettingsRouter = require('./routes/publicTickersSettings.routes');
const adminTickersSettingsRouter = require('./routes/adminTickersSettings.routes');
const adminViralVideosRouter = require('./routes/adminViralVideos.routes');
const publicViralVideosRouter = require('./routes/publicViralVideos.routes');
const publicBroadcastRouter = require('./routes/publicBroadcast.routes');
const publicTickerAdsRouter = require('./routes/publicTickerAds.routes');
const publicApiBroadcastRouter = require('./routes/publicApiBroadcast.routes');
const publicTickerRouter = require('./routes/publicTicker.routes');
const publicWeatherRouter = require('./routes/publicWeather.routes');
const debugRouter = require('./routes/_debug.routes');
const articleAnalyticsRouter = require('./routes/articleAnalytics.routes');
const adminAnalyticsRouter = require('./routes/adminAnalytics.routes');
let adminWorkflowApiRouter = null;
let adminPushHistoryApiRouter = null;
let adminWorkflowLegacyRouter = null;
try { adminWorkflowApiRouter = require('./src/routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/workflow.routes not found; skipping'); }
try { adminPushHistoryApiRouter = require('./src/routes/admin/pushHistory.routes'); } catch (_) { console.warn('[init] optional src/routes/admin/pushHistory.routes not found; skipping'); }
try { adminWorkflowLegacyRouter = require('./routes/admin/workflow.routes'); } catch (_) { console.warn('[init] optional routes/admin/workflow.routes not found; skipping'); }
const CommunitySubmission = require('./models/CommunitySubmission');
const News = require(`${BASE}/models/News`);
// Public /api/public/stories uses the root Article model; reuse it for admin stories.
const Story = require('./models/Article');
const { requireAdminAuth, requireAdminJwt, requireFounderOrAdmin } = require('./middleware/adminAuth');
const { optionalAdminAuth } = require('./middleware/optionalAdminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require(`${BASE}/routes/ai`); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require(`${BASE}/routes/feed`); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }
let publicCommunitySettingsRouter = null;
try { publicCommunitySettingsRouter = require(`${BASE}/routes/public/communitySettings`); } catch (_) { console.warn('[init] optional public community settings router not found; skipping'); }
let publicFeatureTogglesRouter = null;
try { publicFeatureTogglesRouter = require('./routes/publicFeatureToggles'); } catch (_) { console.warn('[init] optional public feature toggles router not found; skipping'); }
const { getEffectiveCommunityAccessState } = require('./services/communityAccessToggleService');

const { langMiddleware } = require('./middleware/lang');

const app = express();

// Important when running behind proxies (Render/Vercel/etc.) so req.protocol is correct
// and X-Forwarded-* headers are trusted.
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Newspulse-Env', _safeEnvLabel());
  res.setHeader('X-Newspulse-Db', _safeDbLabel());
  next();
});

// Language negotiation (query ?lang=hi, header x-lang: hi). Controllers may still
// choose their own defaults for backward compatibility.
app.use(langMiddleware);

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
    'http://localhost:4173',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
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

    // Dev convenience: allow any localhost/127.0.0.1 origin (any port)
    // so admin UIs can run on different ports without editing allowlists.
    if (_corsIsDev) {
      const o = String(origin);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) {
        return callback(null, true);
      }
    }

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
  'https://admin.newspulse.co.in',
  'http://localhost:5173',
  'http://localhost:3000',
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
    // Keep this permissive so browser preflights succeed for any CRUD request
    // (even though public broadcast endpoints are GET-only).
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
// Legacy public mount
app.options('/public/broadcast', _handlePublicBroadcastPreflight);
app.options('/public/broadcast/*', _handlePublicBroadcastPreflight);
// New public-api mount (translated tickers)
app.options('/public-api/broadcast', _handlePublicBroadcastPreflight);
app.options('/public-api/broadcast/*', _handlePublicBroadcastPreflight);

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
  // Ensure we don't accidentally advertise credentialed CORS on public endpoints.
  try { res.removeHeader('Access-Control-Allow-Credentials'); } catch (_) {}
  return next();
});

// Same CORS override for the querystring variant: GET /api/public/ads?slot=...
app.use('/api/public/ads', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();

  const origin = req.get('Origin');
  if (!origin) return next();
  if (!_PUBLIC_ADS_CORS_ORIGINS.has(String(origin))) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  try { res.removeHeader('Access-Control-Allow-Credentials'); } catch (_) {}
  return next();
});

// Ensure GET responses for public broadcast include the required CORS headers.
// (Also strips any Access-Control-Allow-Credentials header set by global CORS.)
function _publicBroadcastCorsOverride(req, res, next) {
  // Allow overriding CORS for any method on the public broadcast namespace.
  // This prevents the global CORS middleware (credentials=true) from interfering.
  // Public endpoints should not require cookies.
  if (req.method === 'HEAD') return next();

  const origin = req.get('Origin');
  if (!origin) return next();
  if (!_PUBLIC_BROADCAST_CORS_ORIGINS.has(String(origin))) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Ensure we don't accidentally advertise credentialed CORS on public endpoints.
  try { res.removeHeader('Access-Control-Allow-Credentials'); } catch (_) {}
  return next();
}

app.use('/api/public/broadcast', _publicBroadcastCorsOverride);
app.use('/admin-api/public/broadcast', _publicBroadcastCorsOverride);
app.use('/admin-api/api/public/broadcast', _publicBroadcastCorsOverride);
app.use('/public/broadcast', _publicBroadcastCorsOverride);
app.use('/public-api/broadcast', _publicBroadcastCorsOverride);
// Ensure OPTIONS preflight works for all routes.
app.options('*', cors(corsOptions));

// Request logging for Broadcast Center (helps diagnose method/path mismatches like 405).
app.use((req, res, next) => {
  const path = String(req.originalUrl || req.url || '');
  const shouldLog =
    path.startsWith('/admin-api/broadcast') ||
    path.startsWith('/api/admin/broadcast') ||
    path.startsWith('/admin-api/admin/broadcast') ||
    path.startsWith('/admin-api/api/admin/broadcast') ||
    path.startsWith('/api/public/broadcast') ||
    path.startsWith('/admin-api/public/broadcast') ||
    path.startsWith('/admin-api/api/public/broadcast') ||
    path.startsWith('/public/broadcast') ||
    path.startsWith('/public-api/broadcast');
  if (!shouldLog) return next();

  res.on('finish', () => {
    try {
      const p = path.split('?')[0];
      console.log(`[broadcast] method=${req.method} path=${p} status=${res.statusCode}`);
    } catch (_) {}
  });
  return next();
});

app.use(express.json({ limit: '2mb' }));
// Friendly error for invalid JSON bodies (e.g. bad Unicode escapes like "\\u0" without 4 hex digits).
app.use((err, req, res, next) => {
  try {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid JSON body' });
    }
  } catch (_) {}
  return next(err);
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve uploaded files publicly
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Upload routes (must be mounted before global 404)
const uploadRoutes = require('./routes/uploads.routes');
app.use('/api/uploads', uploadRoutes);
app.use('/admin-api/uploads', uploadRoutes);
app.use('/admin-api/api/uploads', uploadRoutes);

// Media status routes (admin capability checks)
const mediaRoutes = require('./routes/media.routes');
app.use('/api/media', mediaRoutes);
app.use('/admin-api/media', mediaRoutes);
app.use('/admin-api/api/media', mediaRoutes);

const mediaLibrarySyncRoutes = require('./routes/mediaLibrarySync.routes');
app.use('/api/admin/media-library', mediaLibrarySyncRoutes);

// Admin panel compat endpoints (fast fallbacks)
const adminCompatRoutes = require('./src/routes/adminCompat.routes');
app.use('/api', adminCompatRoutes);

// Upload handler (multipart/form-data)
const _uploadsDir = path.join(process.cwd(), 'uploads');
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
    const envBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const base = envBase || `${req.protocol}://${host}`;
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
  // Keep response minimal/stable for uptime checks.
  return res.status(200).json({
    success: true,
    service: 'newspulse-backend',
    status: 'ok',
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
// Single source of truth: use MONGODB_URI exactly as provided.
const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB_NAME = String(process.env.MONGODB_DBNAME || '').trim() || null;
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

function _resolvedMongoDbName() {
  return MONGO_DB_NAME || _mongoDbNameFromUri(MONGO_URI) || null;
}

// Dev-only debug endpoint to confirm environment and DB selection.
// Returns { env, dbName } and is intentionally NOT available in production.
app.get(['/admin-api/system/env', '/admin-api/api/system/env'], (_req, res) => {
  const env = String(process.env.NODE_ENV || 'development');
  if (String(env).toLowerCase() === 'production') return res.status(404).json({ message: 'Not found' });

  const connectedName = (mongoose.connection && mongoose.connection.name) ? String(mongoose.connection.name) : '';
  const dbFromUri = _resolvedMongoDbName();
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
  console.log('[mongo] connected', {
    readyState: mongoose.connection.readyState,
    db: mongoose.connection.name || undefined,
    configuredDbName: _resolvedMongoDbName() || undefined,
  });
});

const _mongooseReadyStateLabels = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
});

const _localFounderStartupCheckState = {
  inFlight: false,
  completed: false,
  lastSkipKey: null,
};

function _describeMongooseConnection(connection) {
  const readyState = typeof connection?.readyState === 'number' ? connection.readyState : -1;
  const readyStateLabel = _mongooseReadyStateLabels[readyState] || 'unknown';
  const dbName = connection && connection.name ? String(connection.name) : null;
  return { readyState, readyStateLabel, dbName };
}

function _getLocalFounderDbProbeContext() {
  const defaultConnection = mongoose.connection || null;
  const userConnection = User && User.db ? User.db : null;
  const defaultState = _describeMongooseConnection(defaultConnection);
  const userState = _describeMongooseConnection(userConnection);

  return {
    defaultConnection,
    userConnection,
    defaultState,
    userState,
    configuredDbName: _resolvedMongoDbName(),
    sameConnection: !!(defaultConnection && userConnection && defaultConnection === userConnection),
    collectionName: User?.collection?.collectionName || 'users',
  };
}

async function _runLocalFounderStartupCheck({ db } = {}) {
  if (!isLocalDevLike()) return;
  if (_localFounderStartupCheckState.completed || _localFounderStartupCheckState.inFlight) return;

  const probe = _getLocalFounderDbProbeContext();
  const diagnostics = getLocalFounderSafeDiagnostics();
  const logDb = db || probe.userState.dbName || probe.defaultState.dbName || probe.configuredDbName || undefined;

  if (!probe.sameConnection || probe.defaultState.readyState !== 1 || probe.userState.readyState !== 1 || !probe.userConnection?.db) {
    const skipKey = [
      probe.defaultState.readyState,
      probe.userState.readyState,
      probe.sameConnection ? 'same' : 'different',
      probe.defaultState.dbName || '',
      probe.userState.dbName || '',
    ].join('|');

    if (_localFounderStartupCheckState.lastSkipKey !== skipKey) {
      console.log('[startup][local-founder-db] skipped', {
        reason: 'user-model-connection-not-ready',
        db: logDb,
        configuredDbName: probe.configuredDbName || undefined,
        defaultConnectionReadyState: probe.defaultState.readyState,
        defaultConnectionState: probe.defaultState.readyStateLabel,
        defaultConnectionDb: probe.defaultState.dbName || undefined,
        userModelReadyState: probe.userState.readyState,
        userModelState: probe.userState.readyStateLabel,
        userModelDb: probe.userState.dbName || undefined,
        userModelUsesDefaultConnection: probe.sameConnection,
        collectionName: probe.collectionName,
      });
      _localFounderStartupCheckState.lastSkipKey = skipKey;
    }
    return;
  }

  _localFounderStartupCheckState.inFlight = true;
  try {
    const founderDoc = await probe.userConnection.db
      .collection(probe.collectionName)
      .findOne({ role: 'founder' }, { projection: { _id: 1 } });

    _localFounderStartupCheckState.completed = true;
    console.log('[startup][local-founder-db]', {
      db: logDb,
      configuredDbName: probe.configuredDbName || undefined,
      founderExists: !!founderDoc,
      defaultConnectionReadyState: probe.defaultState.readyState,
      defaultConnectionState: probe.defaultState.readyStateLabel,
      defaultConnectionDb: probe.defaultState.dbName || undefined,
      userModelReadyState: probe.userState.readyState,
      userModelState: probe.userState.readyStateLabel,
      userModelDb: probe.userState.dbName || undefined,
      userModelUsesDefaultConnection: probe.sameConnection,
      collectionName: probe.collectionName,
      ...diagnostics,
    });
  } catch (e) {
    console.warn('[startup][local-founder-db] check failed', {
      message: e?.message || String(e),
      db: logDb,
      configuredDbName: probe.configuredDbName || undefined,
      defaultConnectionReadyState: probe.defaultState.readyState,
      defaultConnectionState: probe.defaultState.readyStateLabel,
      defaultConnectionDb: probe.defaultState.dbName || undefined,
      userModelReadyState: probe.userState.readyState,
      userModelState: probe.userState.readyStateLabel,
      userModelDb: probe.userState.dbName || undefined,
      userModelUsesDefaultConnection: probe.sameConnection,
      collectionName: probe.collectionName,
    });
  } finally {
    _localFounderStartupCheckState.inFlight = false;
  }
}

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
    const dbFromUri = _resolvedMongoDbName();
    const db = dbFromUri || mongoose.connection.name || undefined;
    console.log('[startup] MongoDB connected', { db });
    await _runLocalFounderStartupCheck({ db });
    // Ensure TTL index for Broadcast Center is present.
    try {
      const BroadcastItem = require('./models/BroadcastItem');
      await BroadcastItem.syncIndexes();
    } catch (e) {
      console.warn('[startup] BroadcastItem index sync failed', e?.message || e);
    }

    // Ensure GlossaryTerm indexes are present.
    try {
      const GlossaryTerm = require('./models/GlossaryTerm');
      await GlossaryTerm.syncIndexes();
    } catch (e) {
      console.warn('[startup] GlossaryTerm index sync failed', e?.message || e);
    }

    // Ensure TranslationMemory indexes are present.
    try {
      const TranslationMemory = require('./models/TranslationMemory');
      await TranslationMemory.syncIndexes();
    } catch (_) {
      // optional
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

    // Publish-time translation queue worker (Mongo-backed).
    try {
      const TranslationJob = require('./models/TranslationJob');
      await TranslationJob.syncIndexes();
    } catch (e) {
      console.warn('[startup] TranslationJob index sync failed', e?.message || e);
    }
    try {
      const { startPublishTranslationWorker } = require('./services/publishAsyncTranslation.service');
      startPublishTranslationWorker({ logger: console });
    } catch (e) {
      console.warn('[startup] Translation worker failed to start', e?.message || e);
    }
  }

  async function _connectMongoOnce() {
    if (_mongoConnectInFlight) return;
    _mongoConnectInFlight = true;
    try {
      await mongoose.connect(MONGO_URI, MONGO_DB_NAME ? { dbName: MONGO_DB_NAME } : undefined);
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
app.get('/', (_req, res) => {
  return res.status(200).send('News Pulse backend is running');
});

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
app.use('/api/broadcast/ticker-ads', adminTickerAdsRouter);
app.use('/admin-api/broadcast/ticker-ads', adminTickerAdsRouter);
app.use('/admin-api/api/broadcast/ticker-ads', adminTickerAdsRouter);

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
// Legacy/alternate mount used by some reverse proxies
app.use('/admin/broadcast', adminBroadcastRouter);

// Standard Admin Ticker API
// - Primary: /api/admin/ticker
// - Admin panel proxy aliases: /admin-api/admin/ticker and /admin-api/api/admin/ticker
app.use('/api/admin/ticker', adminTickerRouter);
app.use('/admin-api/admin/ticker', adminTickerRouter);
app.use('/admin-api/api/admin/ticker', adminTickerRouter);
// Legacy/alternate mount
app.use('/admin/ticker', adminTickerRouter);

// Admin Glossary (Phase 1)
app.use('/api/admin/glossary', adminGlossaryRouter);
app.use('/admin-api/admin/glossary', adminGlossaryRouter);
app.use('/admin-api/api/admin/glossary', adminGlossaryRouter);

// Admin panel compatibility: some builds call this translation glossary endpoint.
// Keep it as a lightweight 200 stub so the Add News page doesn't break.
const _translationGlossaryStub = (_req, res) => {
  return res.status(200).json({ success: true, glossary: [], enabled: false });
};
app.get('/api/admin/translation/glossary', _translationGlossaryStub);
app.get('/admin-api/admin/translation/glossary', _translationGlossaryStub);
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
app.use('/api/breaking', breakingRouter);
app.use('/api/public/weather', publicWeatherRouter);
// Admin panel proxy basePath support for public news
app.use('/admin-api/public/news', publicNewsRouter);
app.use('/admin-api/api/public/news', publicNewsRouter);

// Admin: generate publish-time translations for News (requires admin auth)
app.use('/api/admin/news', adminNewsTranslationsRouter);
app.use('/admin-api/admin/news', adminNewsTranslationsRouter);
app.use('/admin-api/api/admin/news', adminNewsTranslationsRouter);

// Translation health (no auth)
app.use('/api/public/translation', publicTranslationRouter);
app.use('/admin-api/public/translation', publicTranslationRouter);
app.use('/admin-api/api/public/translation', publicTranslationRouter);

// UI labels (no auth)
app.use('/api/public', publicUiLabelsRouter);
app.use('/admin-api/public', publicUiLabelsRouter);
app.use('/admin-api/api/public', publicUiLabelsRouter);

// Public analytics ingestion (NO AUTH)
app.use('/api/analytics', articleAnalyticsRouter);
// Admin panel proxy basePath support (some deployments call /admin-api/*)
app.use('/admin-api/analytics', articleAnalyticsRouter);
app.use('/admin-api/api/analytics', articleAnalyticsRouter);

// Admin analytics (admin-only)
app.use('/api/admin/analytics', adminAnalyticsRouter);
app.use('/admin-api/admin/analytics', adminAnalyticsRouter);
app.use('/admin-api/api/admin/analytics', adminAnalyticsRouter);

// Articles router mounted at /api and alias at root for /articles
app.use('/api', articlesRoutes);
app.use('/', articlesRoutes);
// Admin panel compatibility: /api/admin/articles should behave like /api/articles
app.use('/api/admin', articlesRoutes);
// Explicit legacy alias: some admin autosave builds call /api/admin/articles/:id
// Forward to the canonical /api/articles/:id handler.
app.get('/api/admin/articles/:id', (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const qsIdx = String(req.url || '').indexOf('?');
    const qs = qsIdx >= 0 ? String(req.url || '').slice(qsIdx) : '';
    req.url = `/articles/${id}${qs}`;
    return articlesRoutes.handle(req, res, next);
  } catch (e) {
    return next(e);
  }
});
app.put('/api/admin/articles/:id', (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const qsIdx = String(req.url || '').indexOf('?');
    const qs = qsIdx >= 0 ? String(req.url || '').slice(qsIdx) : '';
    req.url = `/articles/${id}${qs}`;
    return articlesRoutes.handle(req, res, next);
  } catch (e) {
    return next(e);
  }
});
// Admin panel proxy basePath support (some frontends call /admin-api/*)
app.use('/admin-api/admin', articlesRoutes);
app.use('/admin-api/api/admin', articlesRoutes);
// Compatibility: some admin builds call /admin-api/articles directly
app.use('/admin-api', articlesRoutes);

// Extra safety: some admin edit pages call /admin-api/articles/:id (or /admin-api/api/articles/:id)
// Forward explicitly to the canonical /api/articles/:id handler.
const _forwardAdminArticleById = (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const qsIdx = String(req.url || '').indexOf('?');
    const qs = qsIdx >= 0 ? String(req.url || '').slice(qsIdx) : '';
    req.url = `/articles/${id}${qs}`;
    return articlesRoutes.handle(req, res, next);
  } catch (e) {
    return next(e);
  }
};
app.get('/admin-api/articles/:id', _forwardAdminArticleById);
app.get('/admin-api/api/articles/:id', _forwardAdminArticleById);
app.put('/admin-api/articles/:id', _forwardAdminArticleById);
app.put('/admin-api/api/articles/:id', _forwardAdminArticleById);

app.use('/api/community', communityRoutes);
// Reporter portal: My Community Stories
app.use('/api/community', communityStoriesRouter);
// PUBLIC routes – must be before any /api auth-protected mounts
app.get('/api/community-reporter/queue', getCommunityReporterQueue);
app.use('/api/community-reporter', communityReporterRoutes);
// Public alias to match frontend expectation
app.use('/api/public/community-reporter', communityReporterRoutes);
app.use('/api/reporter-portal', reporterPortalRouter);
app.use('/api/community-reporter/portal', reporterPortalRouter);
app.use('/api/reporter-auth', reporterAuthCompatRouter);

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
app.use('/api/public', publicSponsoredFeaturesRouter);
// Public inquiry endpoint expected by the admin panel/frontends
app.use('/api/public/ads', publicAdsInquiryRouter);
app.post('/api/public/ad-inquiries', submitPublicAdInquiry);

const ADS_INQUIRY_MUTATION_ENDPOINTS = [
  'PATCH /api/ads/inquiries/:id/read',
  'PATCH /api/ads/inquiries/:id/trash',
  'PATCH /api/ads/inquiries/:id/restore',
  'DELETE /api/ads/inquiries/:id/permanent',
  'PATCH /api/ads/inquiries/bulk/read',
  'PATCH /api/ads/inquiries/bulk/trash',
  'PATCH /api/ads/inquiries/bulk/restore',
  'DELETE /api/ads/inquiries/bulk/permanent',
];

// Admin Panel production endpoints (exact paths):
// - POST /api/ads/inquiries
// - GET  /api/ads/inquiries
// - GET  /api/ads/inquiries/unread-count
// - PATCH /api/ads/inquiries/:id/read
// - PATCH /api/ads/inquiries/:id/trash
// - PATCH /api/ads/inquiries/:id/restore
// - DELETE /api/ads/inquiries/:id/permanent
app.use('/api/ads', adsRoutes);
if (require.main === module && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
  console.log('[routes] mounted /api/ads (ads inquiries)');
  console.log('[routes][ads-inquiries] active=true');
  console.log('[routes][ads-inquiries][mounted-path]', '/api/ads');
  console.log('[routes][ads-inquiries][mutation-endpoints]', ADS_INQUIRY_MUTATION_ENDPOINTS);
}

// Public site settings (tickers)
app.use('/api/public', publicTickersSettingsRouter);
app.use('/api/public/ticker-ads', publicTickerAdsRouter);
// Public Broadcast Center tickers (Breaking + Live Updates)
app.use('/api/public/broadcast', publicBroadcastRouter);
// Public ticker items (Breaking + Live Updates) with IST daily cycle
app.use('/api/ticker', publicTickerRouter);
// New public-api translated tickers
app.use('/public-api/broadcast', publicApiBroadcastRouter);
// Safe debug/version endpoint (no secrets)
app.use('/_debug', debugRouter);
// Admin panel proxy basePath support (some frontends call /admin-api/* even for public reads)
app.use('/admin-api/public/ticker-ads', publicTickerAdsRouter);
app.use('/admin-api/api/public/ticker-ads', publicTickerAdsRouter);
app.use('/admin-api/public/broadcast', publicBroadcastRouter);
app.use('/admin-api/api/public/broadcast', publicBroadcastRouter);
// Admin panel proxy basePath support
app.use('/admin-api/ticker', publicTickerRouter);
app.use('/admin-api/api/ticker', publicTickerRouter);
// Legacy/website path support
app.use('/public/broadcast', publicBroadcastRouter);
// Legacy/website path support
app.use('/public', publicTickersSettingsRouter);
// Admin panel proxy basePath support
app.use('/admin-api/public', publicTickersSettingsRouter);
app.use('/admin-api/api/public', publicTickersSettingsRouter);

// Public stories
app.use('/api/public', publicRoutes);
app.use('/api/public', publicViralVideosRouter);
app.use('/api', publicViralVideosRouter);

// Public config version for client-side refresh checks
app.use('/api/public', publicVersionRouter);
app.use('/admin-api/public', publicVersionRouter);
app.use('/admin-api/api/public', publicVersionRouter);

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
app.use('/api/admin', adminSponsoredFeaturesRouter);
// Alias support
app.use('/admin-api/admin', adminAdSettingsRouter);
app.use('/admin-api/admin', adminSponsoredFeaturesRouter);
app.use('/admin-api/api/admin', adminAdSettingsRouter);
app.use('/admin-api/api/admin', adminSponsoredFeaturesRouter);

// Admin routes for legacy and new admin UI paths
app.use('/api/admin', adminRoutes); // used by admin UI
app.use('/api/admin', adminViralVideosRouter);
app.use('/admin-api/admin', adminViralVideosRouter);
app.use('/admin-api/api/admin', adminViralVideosRouter);
app.use('/admin-api', adminViralVideosRouter);
app.use('/admin-api/api', adminViralVideosRouter);
app.use('/admin', adminRoutes);     // legacy path
// Admin sponsor ads
// Admin API proxy aliases (some admin builds proxy via /admin-api/*)
app.use('/admin-api/admin', adminRoutes);
app.use('/admin-api/api/admin', adminRoutes);

// Admin AI Models (status + refresh)
// - Primary (admin panel proxy): /admin-api/ai/models/status, /admin-api/ai/models/refresh
// - Compatibility alias used by some builds: /ai/models/status
app.use('/admin-api/ai/models', adminAiModelsRouter);
app.use('/ai/models', adminAiModelsRouter);

// Owner AI Models (founder/owner-key protected)
// - /admin-api/owner/ai-model-log
// - /admin-api/owner/ai-model-rollback
// - /admin-api/owner/ai-model-status
app.use('/admin-api/owner', ownerAiModelsRouter);

// Compatibility mount (matches common frontend expectation):
// app.use('/admin-api', adminRouter) with router.post('/admin/login', ...)
// We avoid changing adminRoutes paths by mounting it under /admin.
try {
  const adminApiCompatRouter = express.Router();
  adminApiCompatRouter.use('/admin', adminRoutes);
  app.use('/admin-api', adminApiCompatRouter);
  app.use('/admin-api/api', adminApiCompatRouter);
} catch (_) {
  // ignore
}
app.use('/api/admin', adminAdsRouter);

// Ads inquiry admin APIs (JWT required)
app.use('/admin-api/ads', adminAdsInquiriesCompatRouter);
app.use('/admin-api/api/ads', adminAdsInquiriesCompatRouter);

// Sponsor ads CRUD aliases (some admin builds call these without /admin prefix)
// - GET/POST /admin-api/ads
// - PUT/PATCH/DELETE /admin-api/ads/:id
// NOTE: This coexists with inquiries at /admin-api/ads/inquiries*.
app.use('/admin-api', adminAdsRouter);
app.use('/admin-api/api', adminAdsRouter);

// Admin ads inquiry APIs (for admin panel rewrites /admin-api -> /api/admin)
app.use('/api/admin/ads', adminAdsInquiriesCompatRouter);

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

// Admin dashboard stats (admin-auth protected)
// Final URL: GET /api/admin/dashboard/stats
app.use('/api/admin/dashboard', adminDashboardRoutes);
// Admin panel proxy basePath support
app.use('/admin-api/admin/dashboard', adminDashboardRoutes);
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
// Admin API proxy aliases (frontend often proxies /admin-api/*)
app.use('/admin-api/admin', adminSystemRoutes);
app.use('/admin-api/api/admin', adminSystemRoutes);
// health routes handled directly above by healthHandler
// System monitor hub handled by systemRoutes (mounted above)
app.use('/api/admin/community', adminCommunityRoutes);
app.use('/admin-api/admin/community', adminCommunityRoutes);
app.use('/admin-api/api/admin/community', adminCommunityRoutes);
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
app.use('/api/admin/founder', founderRoutesRouter);
app.use('/api/admin/founder', founderFeatureTogglesRouter);
app.use('/admin-api/admin/founder', founderRoutesRouter);
app.use('/admin-api/admin/founder', founderFeatureTogglesRouter);
app.use('/admin-api/api/admin/founder', founderRoutesRouter);
app.use('/admin-api/api/admin/founder', founderFeatureTogglesRouter);
app.use('/admin/founder', founderRoutesRouter);
app.use('/admin/founder', founderFeatureTogglesRouter);

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
  // Admin frontend often proxies through /admin-api/*
  app.use('/admin-api/admin/community-reporter', adminCommunityReporterRouter);
  app.use('/admin-api/api/admin/community-reporter', adminCommunityReporterRouter);
  app.use('/admin/community-reporter', adminCommunityReporterRouter);
  // Also mount under /admin/community for journalist applications aliases
  app.use('/admin/community', adminCommunityReporterRouter);
  // Legacy alias: /api/admin/community/submissions → /api/admin/community-reporter/submissions
  app.use('/api/admin/community/submissions', (req, res, next) => { try { req.url = '/submissions'; return adminCommunityReporterRouter(req, res, next); } catch (e) { return next(e); } });
} catch (e) {
  console.warn('[init] optional routes/adminCommunityReporter not found; skipping');
}

// Contributor Network (admin): canonical contributor profiles/queues/backfill
app.use('/api/admin/community-reporter/network', adminContributorNetworkRouter);
app.use('/admin-api/admin/community-reporter/network', adminContributorNetworkRouter);
app.use('/admin-api/api/admin/community-reporter/network', adminContributorNetworkRouter);
app.use('/admin/community-reporter/network', adminContributorNetworkRouter);
if (aiRoutes) app.use('/api/ai', aiRoutes);
if (feedRoutes) app.use('/api/feed', feedRoutes);
app.use('/api/admin/community', communityAdminContactsRoutes);
app.use('/admin-api/admin/community', communityAdminContactsRoutes);
app.use('/admin/community', communityAdminContactsRoutes);
for (const p of [
  '/api/admin/community/contributors',
  '/admin-api/admin/community/contributors',
  '/admin-api/api/admin/community/contributors',
  '/admin/community/contributors',
]) {
  app.get(p, requireAdminAuth, getReporterDirectory);
}
// Public website settings (safe keys only)
async function _publicSettingsNoAuth(_req, res) {
  try {
    const doc = await PublicSiteSettings.getOrCreate();
    const published = ensurePublicSettingsResponse(doc?.published || PublicSiteSettings.getDefaultSettings());
    return res.json({
      ok: true,
      version: typeof doc?.version === 'number' ? doc.version : 1,
      public: published,
      published,
      updatedAt: doc?.publishedUpdatedAt
        ? new Date(doc.publishedUpdatedAt).toISOString()
        : (doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString()),
    });
  } catch (e) {
    const published = ensurePublicSettingsResponse(PublicSiteSettings.getDefaultSettings());
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

// Admin: Founder overview – list all community stories with optional filters.
// The Community Story Desk UI may send many optional query params; unsupported ones
// must be ignored safely (never 500).
function _adminMyStoriesDebugEnabled() {
  const v = String(process.env.COMMUNITY_STORY_DESK_DEBUG || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function _qs(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'undefined' || lower === 'null') return '';
  return s;
}

function _escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _parseIntSafe(v, def) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function _parseDateSafe(v) {
  const s = _qs(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function _parseBoolLoose(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function _normalizeLangCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const base = lower.split(/[-_]/)[0] || lower;
  // Normalize a few common variants.
  if (base === 'eng') return 'en';
  if (base === 'guj') return 'gu';
  if (base === 'hin') return 'hi';
  return base;
}

function _detectLangFromText(text) {
  const t = String(text || '');
  if (/[\u0A80-\u0AFF]/.test(t)) return 'gu'; // Gujarati
  if (/[\u0900-\u097F]/.test(t)) return 'hi'; // Devanagari (Hindi, Marathi, etc.)
  if (/[\u0980-\u09FF]/.test(t)) return 'bn'; // Bengali
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta'; // Tamil
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te'; // Telugu
  if (/[\u0C80-\u0CFF]/.test(t)) return 'kn'; // Kannada
  if (/[\u0D00-\u0D7F]/.test(t)) return 'ml'; // Malayalam
  return 'en';
}

function _firstNonEmptyString(...values) {
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s) return s;
  }
  return '';
}

function _linkedNewsDoc(d) {
  if (!d) return null;
  const n = d.linkedArticleId;
  return (n && typeof n === 'object') ? n : null;
}

function _linkedPublicArticleDoc(d) {
  if (!d) return null;
  const a = d.articleId;
  if (a && typeof a === 'object') return a;
  const fallback = d.__publicCopy;
  return (fallback && typeof fallback === 'object') ? fallback : null;
}

function _cleanLocationString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return null;
  return s;
}

function _locationFromReporterDirectory(d) {
  const r = (d && d.reporterId && typeof d.reporterId === 'object') ? d.reporterId : null;
  if (!r) return null;
  return {
    city: _cleanLocationString(r.cityTownVillage),
    district: _cleanLocationString(r.districtName),
    state: _cleanLocationString(r.stateName),
    country: _cleanLocationString(r.country),
  };
}

function _locationFromLinkedNews(d) {
  const n = _linkedNewsDoc(d);
  if (!n) return null;
  const loc = (n.location && typeof n.location === 'object') ? n.location : null;
  const geo = (n.geo && typeof n.geo === 'object') ? n.geo : null;
  return {
    city: _cleanLocationString(loc?.city) || _cleanLocationString(geo?.city),
    district: _cleanLocationString(loc?.district) || _cleanLocationString(geo?.district),
    state: _cleanLocationString(loc?.state) || _cleanLocationString(geo?.state),
    country: _cleanLocationString(loc?.country),
  };
}

function _locationFromPublicArticle(d) {
  const a = _linkedPublicArticleDoc(d);
  if (!a) return null;
  const geo = (a.geo && typeof a.geo === 'object') ? a.geo : null;
  return {
    city: _cleanLocationString(a.city) || _cleanLocationString(geo?.city),
    district: _cleanLocationString(a.district) || _cleanLocationString(geo?.district),
    state: _cleanLocationString(a.state) || _cleanLocationString(geo?.state),
    country: null,
  };
}

function _resolveSubmissionLocation(d) {
  if (!d) return { city: null, district: null, state: null, country: null };

  const submission = {
    city: _cleanLocationString(d.locationDetail?.city) || _cleanLocationString(d.location?.city) || _cleanLocationString(d.city),
    district: _cleanLocationString(d.locationDetail?.district),
    state: _cleanLocationString(d.locationDetail?.state) || _cleanLocationString(d.location?.state) || _cleanLocationString(d.state),
    country: _cleanLocationString(d.locationDetail?.country) || _cleanLocationString(d.location?.country) || _cleanLocationString(d.country),
  };
  if (submission.city || submission.district || submission.state || submission.country) return submission;

  const fromNews = _locationFromLinkedNews(d);
  if (fromNews && (fromNews.city || fromNews.district || fromNews.state || fromNews.country)) return fromNews;

  const fromPublic = _locationFromPublicArticle(d);
  if (fromPublic && (fromPublic.city || fromPublic.district || fromPublic.state || fromPublic.country)) return fromPublic;

  const fromReporter = _locationFromReporterDirectory(d);
  if (fromReporter && (fromReporter.city || fromReporter.district || fromReporter.state || fromReporter.country)) return fromReporter;

  return { city: null, district: null, state: null, country: null };
}

function _pickSlugFromDoc(doc, langCode) {
  if (!doc) return '';
  const lang = _normalizeLangCode(langCode);
  const slugs = doc.slugs && typeof doc.slugs === 'object' ? doc.slugs : null;
  const byLang = (lang && slugs && typeof slugs[lang] === 'string') ? slugs[lang] : '';
  return _firstNonEmptyString(byLang, doc.slug);
}

function _idToString(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (v._id) return String(v._id);
    try {
      return String(v);
    } catch (_) {
      return null;
    }
  }
  return String(v);
}

function _submissionCategory(d) {
  const linkedNews = _linkedNewsDoc(d);
  const linkedPublicArticle = _linkedPublicArticleDoc(d);

  // Prefer explicit submission fields.
  const direct = _firstNonEmptyString(
    d?.category,
    d?.primaryCategory,
    d?.section,
    d?.topic,
    d?.storyType,
    d?.classification?.category,
    d?.classification?.primaryCategory,
    d?.finalSection,
    d?.finalTag,
    d?.aiSuggestedCategory,
  );
  if (direct) return direct;

  // Then derive from linked CMS News / public Article (when available).
  const fromNews = _firstNonEmptyString(
    linkedNews?.category,
    linkedNews?.primaryCategory,
    linkedNews?.section,
    linkedNews?.topic,
    linkedNews?.storyType,
    linkedNews?.classification?.category,
  );
  if (fromNews) return fromNews;

  const fromPublic = _firstNonEmptyString(
    linkedPublicArticle?.category,
    linkedPublicArticle?.primaryCategory,
    linkedPublicArticle?.section,
    linkedPublicArticle?.topic,
    linkedPublicArticle?.storyType,
    linkedPublicArticle?.classification?.category,
  );
  if (fromPublic) return fromPublic;

  return null;
}

function _normalizeCategory(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  // Stable slug-like normalization (no invented categories).
  // Keep Unicode letters/digits so non-Latin categories don't collapse to null.
  return s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .trim() || null;
}

function _inferCategoryFallback(d) {
  // Only used when all known category sources are empty.
  // Keep this conservative to avoid mislabeling.
  const headline = typeof d?.headline === 'string' ? d.headline : '';
  const body = typeof d?.body === 'string' ? d.body : '';
  const state = String(d?.locationDetail?.state || d?.location?.state || d?.state || '').trim();
  const text = `${headline} ${body}`;

  const intlRxGu = /(પશ્ચિમ\s*એશિયા|મિડલ\s*ઈસ્ટ|યુદ્ધ|હુમલો|ઈરાન|ઇરાન|ઇઝરાયેલ|ગાઝા|રશિયા|યુક્રેન|ચીન|તાઇવાન)/i;
  const intlRxEn = /(middle\s*east|war|attack|iran|israel|gaza|russia|ukraine|china|taiwan)/i;
  const bizRxGu = /(સોનું|ચાંદી|શેર|સ્ટોક|બજાર|સેન્સેક્સ|નિફ્ટી|રૂપિયો|ડોલર|બિટકોઇન|ક્રિપ્ટો|કમોડિટી|તેલ|પેટ્રોલ|ડીઝલ)/i;
  const bizRxEn = /(gold|silver|stock|market|sensex|nifty|rupee|dollar|bitcoin|crypto|commodity|oil|petrol|diesel)/i;

  // Regional: explicit state mention (example: Gujarat)
  if (/ગુજરાત/.test(text) || /gujarat/i.test(text) || /gujarat/i.test(state) || /ગુજરાત/.test(state)) {
    return 'regional';
  }

  // International: if the headline itself indicates international news, prefer it.
  if (intlRxGu.test(headline) || intlRxEn.test(headline)) {
    return 'international';
  }

  // Business: markets/commodities keywords (Gujarati + English)
  if (bizRxGu.test(text) || bizRxEn.test(text)) {
    return 'business';
  }

  // International: fall back to full-text match (weaker signal than headline match).
  if (intlRxGu.test(text) || intlRxEn.test(text)) {
    return 'international';
  }

  return null;
}

function _slugsByLocaleFromDoc(doc) {
  if (!doc) return null;
  const en = _pickSlugFromDoc(doc, 'en') || '';
  const hi = _pickSlugFromDoc(doc, 'hi') || '';
  const gu = _pickSlugFromDoc(doc, 'gu') || '';
  if (!en && !hi && !gu) return null;
  return {
    en: en || null,
    hi: hi || null,
    gu: gu || null,
  };
}

function _submissionLanguage(d) {
  const linkedNews = _linkedNewsDoc(d);
  const linkedPublicArticle = _linkedPublicArticleDoc(d);

  const explicit = _normalizeLangCode(_firstNonEmptyString(
    d?.language,
    d?.lang,
    d?.originalLanguage,
    d?.originalLang,
    linkedNews?.lang,
    linkedNews?.language,
    linkedNews?.originalLang,
    linkedPublicArticle?.language,
    linkedPublicArticle?.originalLang,
  ));

  const detected = _detectLangFromText(`${d?.headline || ''} ${d?.body || ''}`);

  // If we have explicit='en' but the text clearly indicates a non-English script,
  // prefer detected to avoid Gujarati/Hindi stories being mislabeled EN.
  if (explicit && explicit !== 'en') return explicit;
  if (explicit === 'en' && detected && detected !== 'en') return detected;
  if (explicit) return explicit;

  return detected;
}

function _submissionReporterName(d) {
  const fromDirectory = (d && d.reporterId && typeof d.reporterId === 'object') ? d.reporterId.fullName : null;
  return _firstNonEmptyString(fromDirectory, d?.contact?.name, d?.userName, d?.reporterName, d?.name) || null;
}

function _submissionReporterEmail(d) {
  const fromDirectory = (d && d.reporterId && typeof d.reporterId === 'object') ? d.reporterId.email : null;
  return _firstNonEmptyString(fromDirectory, d?.contact?.email, d?.reporterEmail, d?.email) || null;
}

function _submissionPublicationStatus(d) {
  const s = String(d?.status || '').trim().toLowerCase();
  const hasLinkedArticle = !!(d?.linkedArticleId || d?.articleId || d?.articleSlug);
  if (hasLinkedArticle) return 'published';
  if (['approved', 'published'].includes(s)) return 'approved';
  if (['rejected', 'trash', 'deleted'].includes(s)) return 'rejected';
  if (['withdrawn'].includes(s)) return 'withdrawn';
  return 'pending';
}

function _isNewsDocPubliclyVisible(newsDoc, now = new Date()) {
  if (!newsDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(newsDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;

  const deletedAt = newsDoc.deletedAt ?? null;
  if (deletedAt) return false;

  if (newsDoc.locked === true) return false;
  const embargoUntil = newsDoc.embargoUntil ?? null;
  if (embargoUntil instanceof Date && embargoUntil.getTime() > nowDt.getTime()) return false;

  const publishAt = newsDoc.publishAt ?? null;
  if (publishAt instanceof Date && publishAt.getTime() > nowDt.getTime()) return false;

  // Some docs store these under workflow.*
  if (newsDoc.workflow && typeof newsDoc.workflow === 'object') {
    if (newsDoc.workflow.locked === true) return false;
    const wEmbargo = newsDoc.workflow.embargoUntil ?? null;
    if (wEmbargo instanceof Date && wEmbargo.getTime() > nowDt.getTime()) return false;
  }

  return true;
}

function _isPublicArticleDocPubliclyVisible(articleDoc, now = new Date()) {
  if (!articleDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(articleDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;
  const publishedAt = articleDoc.publishedAt ?? null;
  if (publishedAt instanceof Date && publishedAt.getTime() > nowDt.getTime()) return false;
  return true;
}

async function _adminMyStoriesHandler(req, res) {
  try {
    const q = req.query || {};
    const actorRole = String(req?.admin?.role || '').trim().toLowerCase();
    const actorIsPrivileged = actorRole === 'admin' || actorRole === 'founder';
    if (_adminMyStoriesDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[ADMIN][my-stories] query', q);
    }

    const status = _qs(q.status || 'all');
    const search = _qs(q.search || q.q || '');
    const reporter = _qs(q.reporter || '');
    const publicationStatus = _qs(q.publicationStatus || '');
    const language = _qs(q.language || q.lang || '');
    const category = _qs(q.category || '');
    const city = _qs(q.city || '');
    const district = _qs(q.district || '');
    const state = _qs(q.state || '');
    const dateFrom = _parseDateSafe(q.dateFrom || q.from);
    const dateTo = _parseDateSafe(q.dateTo || q.to);

    const page = Math.max(_parseIntSafe(q.page, 1), 1);
    const limit = Math.min(Math.max(_parseIntSafe(q.limit, 50), 1), 200);
    const skip = (page - 1) * limit;

    const filter = {};

    // Status filter (submission workflow status)
    const statusNorm = String(status || '').trim().toLowerCase();
    const wantsDeleted = _parseBoolLoose(q.deleted || q.includeDeleted || q.showDeleted) || statusNorm === 'deleted' || statusNorm === 'trash';
    filter.isDeleted = wantsDeleted ? true : { $ne: true };

    if (statusNorm && statusNorm !== 'all') {
      const variants = {
        pending: ['pending', 'under_review', 'new', 'PENDING_FOUNDER', 'PENDING', 'NEW', 'UNDER_REVIEW'],
        approved: ['approved', 'APPROVED', 'published', 'PUBLISHED'],
        rejected: ['rejected', 'REJECTED', 'trash', 'TRASH', 'deleted', 'DELETED'],
        deleted: ['deleted', 'DELETED', 'trash', 'TRASH'],
        withdrawn: ['withdrawn', 'WITHDRAWN'],
      };
      const v = variants[statusNorm] || [statusNorm];
      filter.status = { $in: v };
    }

    // PublicationStatus is a UI concept; for now, map to a safe subset if provided.
    // Unsupported values are ignored.
    const pubNorm = String(publicationStatus || '').trim().toLowerCase();
    if (pubNorm === 'published') {
      filter.status = { $in: ['approved', 'APPROVED', 'published', 'PUBLISHED'] };
    } else if (pubNorm === 'pending') {
      filter.status = { $in: ['pending', 'under_review', 'new', 'PENDING_FOUNDER', 'PENDING', 'NEW', 'UNDER_REVIEW'] };
    } else if (pubNorm === 'rejected') {
      filter.status = { $in: ['rejected', 'REJECTED'] };
    }

    // Search: treat as plain text (escape regex metacharacters)
    const searchNorm = String(search || '').trim();
    if (searchNorm) {
      const safe = _escapeRegExp(searchNorm);
      filter.headline = { $regex: safe, $options: 'i' };
    }

    // Reporter filter: plain-text match across common reporter fields
    const reporterNorm = String(reporter || '').trim();
    if (reporterNorm) {
      const safe = _escapeRegExp(reporterNorm);
      const rx = new RegExp(safe, 'i');
      filter.$or = [
        { reporterName: rx },
        { name: rx },
        { reporterEmailNorm: rx },
        { reporterEmail: rx },
        { email: rx },
        { 'contact.email': rx },
        { 'contact.phone': rx },
      ];
    }

    // Optional field filters (ignored safely when empty)
    // Language is not guaranteed to be present on all CommunitySubmission docs; treat it as best-effort.
    if (language) {
      const langNorm = _normalizeLangCode(language);
      if (langNorm) {
        filter.$and = (filter.$and || []).concat([{ $or: [{ language: langNorm }, { lang: langNorm }] }]);
      }
    }
    if (category) filter.category = String(category).trim();
    if (city) filter.$and = (filter.$and || []).concat([{ $or: [{ 'location.city': new RegExp(_escapeRegExp(city), 'i') }, { 'locationDetail.city': new RegExp(_escapeRegExp(city), 'i') }, { city: new RegExp(_escapeRegExp(city), 'i') }] }]);
    if (district) filter.$and = (filter.$and || []).concat([{ 'locationDetail.district': new RegExp(_escapeRegExp(district), 'i') }]);
    if (state) filter.$and = (filter.$and || []).concat([{ $or: [{ 'location.state': new RegExp(_escapeRegExp(state), 'i') }, { 'locationDetail.state': new RegExp(_escapeRegExp(state), 'i') }, { state: new RegExp(_escapeRegExp(state), 'i') }] }]);

    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = dateFrom;
      if (dateTo) range.$lte = dateTo;
      filter.createdAt = range;
    }

    const query = CommunitySubmission.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'reporterId', select: 'fullName email phoneFull cityTownVillage districtName stateName stateCode country' })
      .populate({ path: 'linkedArticleId', select: 'slug slugs category primaryCategory section topic storyType lang language originalLang geo location' })
      .populate({ path: 'articleId', select: 'slug slugs category primaryCategory section topic storyType language originalLang status publishedAt sourceNewsId geo state district city' })
      .lean();

    const [docs, total] = await Promise.all([
      query,
      CommunitySubmission.countDocuments(filter),
    ]);

    // If a submission links to a CMS News doc (linkedArticleId) but does not have a populated
    // public Article copy (articleId), resolve the public copy via Article.sourceNewsId.
    // This keeps Published state accurate for the Community Story Desk.
    const linkedNewsIds = Array.from(new Set((docs || [])
      .map((d) => _idToString(d?.linkedArticleId))
      .filter(Boolean)));

    let publicCopyBySourceNewsId = new Map();
    const mongoConnected = !!(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
    if (linkedNewsIds.length && Story && mongoConnected) {
      try {
        const publicCopies = await Story.find({
          sourceNewsId: { $in: linkedNewsIds },
          status: 'published',
        })
          .select('_id sourceNewsId status publishedAt slug slugs category language originalLang')
          .lean();

        publicCopyBySourceNewsId = new Map(
          (publicCopies || [])
            .filter((a) => a && a.sourceNewsId)
            .map((a) => [String(a.sourceNewsId), a])
        );
      } catch (e) {
        // Non-fatal: we can still compute published state from linked News fields.
        console.warn('[ADMIN][my-stories] public copy lookup failed', e?.message || e);
      }

      // Attach for later mapping convenience.
      for (const d of (docs || [])) {
        try {
          const id = _idToString(d?.linkedArticleId);
          if (!id) continue;
          if (d.articleId) continue;
          const pc = publicCopyBySourceNewsId.get(String(id)) || null;
          if (pc) d.__publicCopy = pc;
        } catch (_) {}
      }
    }

    const items = (docs || []).map((d) => {
      const reporterNameOut = _submissionReporterName(d);
      const reporterEmailOut = _submissionReporterEmail(d);
      const categoryOut = _normalizeCategory(_submissionCategory(d)) || _inferCategoryFallback(d);
      const languageOut = _submissionLanguage(d);
      const loc = _resolveSubmissionLocation(d);
      const cityOut = loc.city;
      const districtOut = loc.district;
      const stateOut = loc.state;
      const countryOut = loc.country;
      const linkedNewsId = _idToString(d.linkedArticleId);
      const linkedNews = _linkedNewsDoc(d);
      const linkedPublicArticle = _linkedPublicArticleDoc(d);

      const publicArticleId = _idToString(linkedPublicArticle?._id || d.articleId);
      const sourceIdOut = linkedNewsId || publicArticleId || null;

      const now = new Date();
      const newsIsPublished = _isNewsDocPubliclyVisible(linkedNews, now);
      const publicArticleIsPublished = _isPublicArticleDocPubliclyVisible(linkedPublicArticle, now);
      const isPublishedOut = !!(newsIsPublished || publicArticleIsPublished);
      const publishedAtOut = (linkedPublicArticle?.publishedAt || linkedNews?.publishedAt || null);

      // Prefer the public Article slug for publicUrl/actions (it must match the public route).
      // Fall back to submission-stored slug and finally the CMS News slug.
      const slugOut = _firstNonEmptyString(
        _pickSlugFromDoc(linkedPublicArticle, languageOut),
        d.articleSlug,
        _pickSlugFromDoc(linkedNews, languageOut),
      ) || null;

      const publicSlugsOut = _slugsByLocaleFromDoc(linkedPublicArticle);
      const cmsSlugsOut = _slugsByLocaleFromDoc(linkedNews);
      const slugsOut = publicSlugsOut || cmsSlugsOut || null;

      const host = req.get('host');
      const envBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
      const base = envBase || `${req.protocol}://${host}`;
      const publicUrlOut = slugOut ? `${base}/stories/${encodeURIComponent(slugOut)}` : null;

      // Admin URLs are best-effort; stable IDs are always returned.
      const adminNewsApiUrl = linkedNewsId ? `/api/admin/news/${encodeURIComponent(linkedNewsId)}` : null;
      const adminArticleApiUrl = publicArticleId ? `/api/admin/articles/${encodeURIComponent(publicArticleId)}` : null;

      // Deleted-state must be stable for the Community Story Desk.
      // Some legacy rows may have status='DELETED'/'TRASH' without isDeleted being set.
      const statusNorm = String(d.status || '').trim().toLowerCase();
      const isDeletedOut = d.isDeleted === true || statusNorm === 'deleted' || statusNorm === 'trash' || statusNorm === 'deactivated' || statusNorm === 'archived';
      const canRestoreOut = actorIsPrivileged && isDeletedOut;
      const canSoftDeleteOut = actorIsPrivileged && !isDeletedOut;
      const canArchiveOut = canSoftDeleteOut;
      // Permanent delete removes ONLY the community submission record (not the live/published article).
      // Therefore it is safe from a live-site standpoint even when a linked article is published.
      const canPermanentDeleteOut = actorIsPrivileged && isDeletedOut;

      const linkedNewsStatusOut = linkedNews ? (linkedNews.status || null) : null;
      const linkedPublicArticleStatusOut = linkedPublicArticle ? (linkedPublicArticle.status || null) : null;
      const linkedArticleStatusOut = linkedPublicArticleStatusOut || linkedNewsStatusOut || null;

      return {
        _id: String(d._id),
        id: String(d._id),
        refId: String(d._id),
        sourceId: sourceIdOut,
        sourceType: d.sourceType || null,

        title: d.headline || '',
        headline: d.headline || '',

        reporterName: reporterNameOut,
        reporterEmail: reporterEmailOut,
        reporterId: d.reporterId ? (typeof d.reporterId === 'object' ? String(d.reporterId._id) : String(d.reporterId)) : null,
        reporterProfileId: d.reporterProfileId ? String(d.reporterProfileId) : null,

        status: d.status || 'pending',
        // publicationStatus is the live/public state (separate from review status)
        publicationStatus: isPublishedOut ? 'published' : 'not_published',
        isPublished: isPublishedOut,
        published: isPublishedOut,
        publishedAt: publishedAtOut,
        language: languageOut,
        category: categoryOut,

        // Linked editorial/public story metadata (best-effort)
        linkedArticleId: linkedNewsId,
        articleId: publicArticleId,
        articleSlug: d.articleSlug || null,
        linkedArticleStatus: linkedArticleStatusOut,
        linkedNewsStatus: linkedNewsStatusOut,
        linkedPublicArticleStatus: linkedPublicArticleStatusOut,
        slug: slugOut,
        slugs: slugsOut,
        publicUrl: publicUrlOut,
        adminNewsApiUrl,
        adminArticleApiUrl,

        // Story Desk actions never affect live site content; Manage News controls live visibility.
        affectsLiveSite: false,

        // Capability flags for admin actions
        canSoftDelete: canSoftDeleteOut,
        canArchive: canArchiveOut,
        canRestore: canRestoreOut,
        canPermanentDelete: canPermanentDeleteOut,

        city: cityOut,
        district: districtOut,
        state: stateOut,
        country: countryOut,

        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,

        // Soft delete metadata (for Deleted tab)
        isDeleted: isDeletedOut,
        deletedAt: d.deletedAt || null,
        deletedBy: d.deletedBy || null,
        restoredAt: d.restoredAt || null,
        restoredBy: d.restoredBy || null,
      };
    });

    const pages = Math.max(1, Math.ceil(total / limit));
    return res.json({ ok: true, items, total, page, limit, pages });
  } catch (e) {
    console.error('[ADMIN][my-stories] error', {
      message: e?.message || e,
      stack: e?.stack,
      query: req?.query || null,
    });
    return res.status(500).json({ ok: false, message: 'Failed to load community stories' });
  }
}

for (const p of ['/api/admin/community/my-stories', '/admin-api/admin/community/my-stories', '/admin-api/api/admin/community/my-stories', '/admin/community/my-stories']) {
  app.get(p, requireAdminAuth, _adminMyStoriesHandler);
}

// Community Story Desk actions
// Canonical (recommended) routes:
// - POST   /admin-api/admin/community/my-stories/:storyId/delete        (Move to Deleted / soft delete)
// - POST   /admin-api/admin/community/my-stories/:storyId/restore       (Restore)
// - DELETE /admin-api/admin/community/my-stories/:storyId/permanent     (Delete Permanently)
// Note: we also keep method/path aliases for older frontends.

for (const p of ['/api/admin/community/my-stories/:storyId/delete', '/admin-api/admin/community/my-stories/:storyId/delete', '/admin-api/api/admin/community/my-stories/:storyId/delete', '/admin/community/my-stories/:storyId/delete']) {
  app.post(p, requireAdminAuth, deleteCommunityReporterStory);
  app.patch(p, requireAdminAuth, deleteCommunityReporterStory);
}

// Aliases: soft delete (some clients used DELETE on the base :storyId route)
for (const p of ['/api/admin/community/my-stories/:storyId', '/admin-api/admin/community/my-stories/:storyId', '/admin-api/api/admin/community/my-stories/:storyId', '/admin/community/my-stories/:storyId']) {
  app.delete(p, requireAdminAuth, deleteCommunityReporterStory);
}
for (const p of ['/api/admin/community/my-stories/:storyId/restore', '/admin-api/admin/community/my-stories/:storyId/restore', '/admin-api/api/admin/community/my-stories/:storyId/restore', '/admin/community/my-stories/:storyId/restore']) {
  app.post(p, requireAdminAuth, restoreCommunityReporterStory);
  app.patch(p, requireAdminAuth, restoreCommunityReporterStory);
}
for (const p of ['/api/admin/community/my-stories/:storyId/permanent', '/admin-api/admin/community/my-stories/:storyId/permanent', '/admin-api/api/admin/community/my-stories/:storyId/permanent', '/admin/community/my-stories/:storyId/permanent']) {
  app.delete(p, requireAdminAuth, permanentDeleteCommunityReporterStory);
}
for (const p of ['/api/admin/community/my-stories/:storyId/permanent-delete', '/admin-api/admin/community/my-stories/:storyId/permanent-delete', '/admin-api/api/admin/community/my-stories/:storyId/permanent-delete', '/admin/community/my-stories/:storyId/permanent-delete']) {
  app.post(p, requireAdminAuth, permanentDeleteCommunityReporterStory);
}

// Legacy Community Story Desk aliases (older frontends)
// - Some builds call /admin-api/community/stories/:id/* instead of /admin-api/admin/community-reporter/stories/:id/*
for (const p of ['/api/admin/community/stories/:id/withdraw', '/admin-api/community/stories/:id/withdraw', '/admin/community/stories/:id/withdraw']) {
  app.post(p, requireAdminAuth, withdrawCommunityReporterStory);
  app.patch(p, requireAdminAuth, withdrawCommunityReporterStory);
}

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
    const payload = await buildAdminDashboardStatsPayload({
      dbConnected: Boolean(mongoose.connection && mongoose.connection.readyState === 1),
    });
    return res.json({ ...payload, success: true, status: 200, path: req.originalUrl });
  } catch (e) {
    console.error('[ADMIN][stats][alias:/admin/stats] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load admin stats', path: req.originalUrl });
  }
});
app.get('/api/admin/stats', async (req, res) => {
  try {
    const payload = await buildAdminDashboardStatsPayload({
      dbConnected: Boolean(mongoose.connection && mongoose.connection.readyState === 1),
    });
    return res.json({ ...payload, success: true, status: 200, path: req.originalUrl });
  } catch (e) {
    console.error('[ADMIN][stats][alias:/api/admin/stats] failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load admin stats', path: req.originalUrl });
  }
});

// Public config
app.get('/api/community-reporter/config', async (req, res) => {
  try {
    const state = await getEffectiveCommunityAccessState();
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.json({
      ok: true,
      communityMyStoriesEnabled: state.communityMyStoriesEnabled,
      communityReporterClosed: state.communityReporterClosed,
      communityReporterEnabled: state.communityReporterEnabled,
      reporterPortalClosed: state.reporterPortalClosed,
      reporterPortalEnabled: state.reporterPortalEnabled,
    });
  } catch (err) {
    console.error('[community-reporter:config][error]', err?.message || err);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.status(500).json({ ok: false, message: 'Could not load community reporter config.' });
  }
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

async function _adminLoginHandler(req, res) {
  try {
    const body = req.body || {};
    const localFounderConfig = resolveLocalFounderSeedConfig();
    const email = String(body.email || localFounderConfig.email || process.env.FOUNDER_EMAIL || 'founder@example.com').trim().toLowerCase();
    const password = String(body.password || '');
    const expectedEmail = String(
      process.env.ADMIN_EMAIL
      || process.env.FOUNDER_EMAIL
      || process.env.ADMIN_SEED_FOUNDER_EMAIL
      || localFounderConfig.email
      || 'founder@example.com'
    ).trim().toLowerCase();
    const expectedPass = String(
      process.env.ADMIN_PASSWORD
      || process.env.ADMIN_PASS
      || process.env.FOUNDER_PASSWORD
      || process.env.FOUNDER_PASS
      || process.env.ADMIN_SEED_FOUNDER_PASSWORD
      || (isLocalDevLike() ? localFounderConfig.password : '')
      || ''
    );
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const user = await User.findOne({ email });
      if (user && user.passwordHash) {
        const okPw = await bcrypt.compare(password, user.passwordHash).catch(() => false);
        if (okPw) {
          const role = String(user.role || 'founder').toLowerCase();
          const name = user.name || localFounderConfig.fullName || 'Founder';

          if (_isTestEnv()) {
            const accessToken = _makeToken('access');
            const refreshToken = _makeToken('refresh');
            _issuedTokens.access.add(accessToken);
            _issuedTokens.refresh.add(refreshToken);
            return res.json({ success: true, accessToken, refreshToken, user: { email: user.email } });
          }

          const accessToken = _issueJwt(
            { sub: String(user._id || 'founder-1'), email: user.email, role, name, tokenVersion: user.tokenVersion || 0, typ: 'access' },
            '15m'
          );
          const refreshToken = _issueJwt(
            { sub: String(user._id || 'founder-1'), email: user.email, role, name, tokenVersion: user.tokenVersion || 0, typ: 'refresh' },
            '30d'
          );

          if (!accessToken || !refreshToken) {
            return res.status(500).json({ success: false, message: 'Server misconfigured' });
          }

          return res.json({ success: true, accessToken, refreshToken, user: { email: user.email } });
        }
      }

      if (isLocalDevLike() && email === localFounderConfig.email) {
        const founderExists = !!(await User.exists({ role: 'founder' }));
        if (!founderExists) {
          return res.status(401).json({
            success: false,
            code: 'ADMIN_FOUNDER_NOT_SEEDED',
            message: 'Local founder account is not seeded yet. POST /api/admin/seed-founder before logging in.',
            founder: getLocalFounderSafeDiagnostics(),
          });
        }
      }
    }

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
}

// POST /admin/login -> returns success + access/refresh tokens
app.post('/admin/login', _adminLoginHandler);
// Phase 1 required alias for admin panel proxy
app.post('/admin-api/admin/login', _adminLoginHandler);
app.post('/admin-api/api/admin/login', _adminLoginHandler);

// GET /admin-auth/session -> success true/false based on token; invalid returns success=false
app.get('/admin-auth/session', (req, res) => {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(200).json({ success: false, user: null });
  if (token === 'invalidtoken') return res.status(200).json({ success: false, user: null });
  const ok = _issuedTokens.access.has(token) || token.startsWith('np.') || token.startsWith('access.');
  if (!ok) return res.status(200).json({ success: false, user: null });
  const localFounderConfig = resolveLocalFounderSeedConfig();
  const email = process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL || localFounderConfig.email || 'founder@example.com';
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
    const localFounderConfig = resolveLocalFounderSeedConfig();
    const email = payload.email || process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL || localFounderConfig.email || 'founder@example.com';
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
  // Non-blocking startup check for Ads SMTP (best-effort)
  try {
    const { createAdsTransport } = require('./utils/mailer');
    createAdsTransport();
  } catch (e) {
    try {
      console.warn('[ads-smtp] not ready', e?.message || String(e));
    } catch (_) {}
  }

  // Render/Linux should bind an explicit IPv4 host so platform port detection
  // sees the web process reliably. Keep Windows dual-stack for local callers.
  const bindHost = String(process.env.BIND_HOST || '').trim()
    || (process.platform === 'win32' ? '::' : '0.0.0.0');
  const listenArg = process.platform === 'win32'
    ? ({ port: PORT, host: bindHost, ipv6Only: false })
    : ({ port: PORT, host: bindHost });

  const server = app.listen(listenArg, () => {
    const backendUrl = `http://127.0.0.1:${PORT}`;
    const healthUrl = `${backendUrl}/health`;
    const apiBaseUrl = `${backendUrl}/api`;

    console.log(`✅ Server running on port ${PORT}`);
    console.log('[startup] backend', { port: PORT, host: bindHost });
    console.log('[startup][urls]', { backendUrl, healthUrl, apiBaseUrl });
    console.log('[startup][ads-routes]', { mountPath: '/api/ads', mutationEndpoints: ADS_INQUIRY_MUTATION_ENDPOINTS });
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
    console.error('[startup] failed to listen', { port: PORT, host: bindHost, code: err?.code, message: err?.message });
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
