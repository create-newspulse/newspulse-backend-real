// News Pulse Engine — Phase 3A read-only diagnostics.
// DETECT -> EXPLAIN -> PRIORITIZE -> RECOMMEND. No writes, no automatic fixes.
const mongoose = require('mongoose');

const News = require('../models/News');
const CommunitySubmission = require('../models/CommunitySubmission');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const firebaseAdminLib = require('../lib/firebaseAdmin');
const { resolveSiteUrl } = require('./seoAuditService');

const HOMEPAGE_TIMEOUT_MS = 4000;
const SEO_FILE_TIMEOUT_MS = 3000;
const ANALYTICS_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Core systems drive overallStatus escalation to "critical"; optional integrations do not.
const CORE_CHECK_IDS = new Set(['backend-api', 'database', 'public-website']);

const AREA_LABELS = {
  'backend-api': 'Backend API',
  database: 'Database',
  'public-website': 'Public Website',
  publishing: 'Publishing',
  'push-notifications': 'Push Notifications',
  analytics: 'Analytics',
  seo: 'SEO',
  'community-reporter': 'Community Reporter',
  'admin-panel': 'Admin Panel',
};

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function makeCheck({ id, status, message, technicalDetail = null, recommendation = null, latencyMs = null }) {
  return {
    id,
    area: AREA_LABELS[id] || id,
    status,
    message,
    technicalDetail,
    recommendation,
    checkedAt: new Date().toISOString(),
    ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
  };
}

// Test hook mirrors services/seoAuditService.js's fetch override convention.
function getFetcher() {
  return global.__NEWS_PULSE_ENGINE_HEALTH_FETCH__ || global.fetch;
}

async function fetchWithTimeout(url, { method = 'GET', timeoutMs = HOMEPAGE_TIMEOUT_MS } = {}) {
  const fetcher = getFetcher();
  if (typeof fetcher !== 'function') {
    return { reachable: false, status: null, latencyMs: null, error: 'fetch-unavailable' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();
  try {
    const response = await fetcher(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': 'NewsPulse-Engine-Health/1.0' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    return { reachable: true, status: response.status, ok: response.ok, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return { reachable: false, status: null, latencyMs: Date.now() - startedAt, error: timedOut ? 'timeout' : (error && error.message ? error.message : 'fetch-failed') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkBackendApi() {
  const startedAt = Date.now();
  return makeCheck({
    id: 'backend-api',
    status: 'healthy',
    message: 'Backend API is responding normally.',
    technicalDetail: `uptimeSec=${Math.round(process.uptime())}`,
    latencyMs: Date.now() - startedAt,
  });
}

async function checkDatabase() {
  const startedAt = Date.now();
  const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  let status = 'unknown';
  let message = 'Database connection state could not be determined.';
  let recommendation = 'Check MongoDB connection status before publishing new content.';

  if (readyState === 1) {
    status = 'healthy';
    message = 'Database connection is active.';
    recommendation = null;
  } else if (readyState === 2) {
    status = 'attention';
    message = 'Database connection is still being established.';
  } else if (readyState === 0 || readyState === 3) {
    status = 'critical';
    message = 'Database connection is not ready.';
  }

  return makeCheck({
    id: 'database',
    status,
    message,
    technicalDetail: `readyState=${readyState}`,
    recommendation,
    latencyMs: Date.now() - startedAt,
  });
}

async function checkPublicWebsite() {
  const siteUrl = resolveSiteUrl();
  const result = await fetchWithTimeout(siteUrl, { method: 'GET', timeoutMs: HOMEPAGE_TIMEOUT_MS });

  if (!result.reachable) {
    return makeCheck({
      id: 'public-website',
      status: 'critical',
      message: 'Homepage could not be reached.',
      technicalDetail: `route=homepage; error=${result.error}`,
      recommendation: 'Check the frontend deployment and domain availability.',
      latencyMs: result.latencyMs,
    });
  }

  if (result.status >= 200 && result.status < 300) {
    return makeCheck({
      id: 'public-website',
      status: 'healthy',
      message: `Homepage responded with HTTP ${result.status}.`,
      technicalDetail: `route=homepage; httpStatus=${result.status}`,
      latencyMs: result.latencyMs,
    });
  }

  // The public homepage is a core service; any non-2xx (including 4xx/5xx) is critical.
  return makeCheck({
    id: 'public-website',
    status: 'critical',
    message: `Homepage responded with HTTP ${result.status}.`,
    technicalDetail: `route=homepage; httpStatus=${result.status}`,
    recommendation: 'Check the frontend deployment for unexpected response codes.',
    latencyMs: result.latencyMs,
  });
}

async function checkPublishing() {
  const startedAt = Date.now();
  if (!isDbReady()) {
    return makeCheck({
      id: 'publishing',
      status: 'unknown',
      message: 'Cannot verify publishing without an active database connection.',
      recommendation: 'Check MongoDB connection status before publishing new content.',
      latencyMs: Date.now() - startedAt,
    });
  }

  try {
    const latest = await News.findOne({ status: 'published' })
      .select('publishedAt')
      .sort({ publishedAt: -1 })
      .lean();

    if (!latest) {
      return makeCheck({
        id: 'publishing',
        status: 'attention',
        message: 'No published articles were found.',
        latencyMs: Date.now() - startedAt,
      });
    }

    return makeCheck({
      id: 'publishing',
      status: 'healthy',
      message: 'Published news records are accessible.',
      technicalDetail: latest.publishedAt ? `latestPublishedAt=${new Date(latest.publishedAt).toISOString()}` : null,
      latencyMs: Date.now() - startedAt,
    });
  } catch (_e) {
    return makeCheck({
      id: 'publishing',
      status: 'critical',
      message: 'Published article query failed.',
      recommendation: 'Check MongoDB connection status before publishing new content.',
      latencyMs: Date.now() - startedAt,
    });
  }
}

async function checkPush() {
  const startedAt = Date.now();
  const firebase = firebaseAdminLib.getFirebaseAdminStatus();

  if (firebase.configured) {
    return makeCheck({
      id: 'push-notifications',
      status: 'healthy',
      message: 'Push service configuration is available.',
      technicalDetail: firebase.credentialSource ? `credentialSource=${firebase.credentialSource}` : null,
      latencyMs: Date.now() - startedAt,
    });
  }

  if (firebase.status === 'initialization_error') {
    return makeCheck({
      id: 'push-notifications',
      status: 'critical',
      message: 'Push service failed to initialize.',
      recommendation: 'Check Firebase Admin credentials configuration.',
      latencyMs: Date.now() - startedAt,
    });
  }

  return makeCheck({
    id: 'push-notifications',
    status: 'attention',
    message: 'Push service is not fully configured.',
    recommendation: 'Connect Firebase Admin credentials if push notifications are required.',
    latencyMs: Date.now() - startedAt,
  });
}

function isAnalyticsExplicitlyDisabled() {
  return String(process.env.ANALYTICS_ENABLED || '').trim().toLowerCase() === 'false';
}

function toValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function newestDate(...values) {
  return values
    .map(toValidDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

async function getLatestFirstPartyAnalyticsActivityAt() {
  const [latestSummary, latestEvent] = await Promise.all([
    ArticleAnalyticsSummary.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
    ArticleAnalyticsEvent.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);

  return newestDate(latestSummary?.updatedAt, latestEvent?.createdAt);
}

async function checkAnalytics() {
  const startedAt = Date.now();

  if (isAnalyticsExplicitlyDisabled()) {
    return makeCheck({
      id: 'analytics',
      status: 'attention',
      message: 'News Pulse analytics collection is disabled.',
      recommendation: 'Enable News Pulse analytics collection if first-party traffic reporting is appropriate.',
      latencyMs: Date.now() - startedAt,
    });
  }

  if (!isDbReady()) {
    return makeCheck({
      id: 'analytics',
      status: 'attention',
      message: 'News Pulse analytics health could not be confirmed because the database is not ready.',
      recommendation: 'Check MongoDB connection before verifying analytics health.',
      latencyMs: Date.now() - startedAt,
    });
  }

  try {
    const latestActivityAt = await getLatestFirstPartyAnalyticsActivityAt();
    const latestMs = latestActivityAt ? latestActivityAt.getTime() : 0;
    const recentCutoffMs = Date.now() - ANALYTICS_RECENT_WINDOW_MS;

    if (latestActivityAt && latestMs >= recentCutoffMs) {
      return makeCheck({
        id: 'analytics',
        status: 'healthy',
        message: 'News Pulse analytics collection is active.',
        technicalDetail: `latestActivityAt=${latestActivityAt.toISOString()}; recentWindowHours=24`,
        latencyMs: Date.now() - startedAt,
      });
    }

    return makeCheck({
      id: 'analytics',
      status: 'attention',
      message: 'News Pulse analytics is enabled, but recent activity could not be confirmed.',
      technicalDetail: latestActivityAt ? `latestActivityAt=${latestActivityAt.toISOString()}; recentWindowHours=24` : 'latestActivityAt=null; recentWindowHours=24',
      recommendation: 'Verify that consented production article traffic is reaching News Pulse analytics.',
      latencyMs: Date.now() - startedAt,
    });
  } catch (_e) {
    return makeCheck({
      id: 'analytics',
      status: 'attention',
      message: 'News Pulse analytics health could not be confirmed.',
      recommendation: 'Review analytics storage and retry the Engine health check.',
      latencyMs: Date.now() - startedAt,
    });
  }
}

async function checkSeo() {
  const siteUrl = resolveSiteUrl();
  const [robots, sitemap] = await Promise.all([
    fetchWithTimeout(`${siteUrl}/robots.txt`, { method: 'GET', timeoutMs: SEO_FILE_TIMEOUT_MS }),
    fetchWithTimeout(`${siteUrl}/sitemap.xml`, { method: 'GET', timeoutMs: SEO_FILE_TIMEOUT_MS }),
  ]);

  const robotsOk = robots.reachable && robots.status >= 200 && robots.status < 300;
  const sitemapOk = sitemap.reachable && sitemap.status >= 200 && sitemap.status < 300;
  const technicalDetail = `robots=${robots.reachable ? robots.status : 'unreachable'}; sitemap=${sitemap.reachable ? sitemap.status : 'unreachable'}`;

  if (robotsOk && sitemapOk) {
    return makeCheck({
      id: 'seo',
      status: 'healthy',
      message: 'robots.txt and sitemap.xml are reachable.',
      technicalDetail,
    });
  }

  // SEO is an optional integration for Phase 3A; never escalate it to critical.
  const missing = [];
  if (!robotsOk) missing.push('robots.txt');
  if (!sitemapOk) missing.push('sitemap.xml');

  return makeCheck({
    id: 'seo',
    status: 'attention',
    message: `${missing.join(' and ')} could not be reached.`,
    technicalDetail,
    recommendation: 'Check the frontend deployment and sitemap generation.',
  });
}

async function checkCommunityReporter() {
  const startedAt = Date.now();
  if (!isDbReady()) {
    return makeCheck({
      id: 'community-reporter',
      status: 'unknown',
      message: 'Cannot verify Community Reporter without an active database connection.',
      latencyMs: Date.now() - startedAt,
    });
  }

  try {
    await CommunitySubmission.findOne({}).select('_id').lean();
    return makeCheck({
      id: 'community-reporter',
      status: 'healthy',
      message: 'Community Reporter submissions are accessible.',
      latencyMs: Date.now() - startedAt,
    });
  } catch (_e) {
    return makeCheck({
      id: 'community-reporter',
      status: 'critical',
      message: 'Community Reporter query failed.',
      latencyMs: Date.now() - startedAt,
    });
  }
}

async function checkAdminPanel() {
  const adminPanelUrl = String(process.env.ADMIN_PANEL_URL || '').trim();
  if (!adminPanelUrl) {
    return makeCheck({
      id: 'admin-panel',
      status: 'unknown',
      message: 'Admin Panel external availability is not configured for backend diagnostics.',
    });
  }

  const result = await fetchWithTimeout(adminPanelUrl, { method: 'GET', timeoutMs: HOMEPAGE_TIMEOUT_MS });
  if (!result.reachable) {
    return makeCheck({
      id: 'admin-panel',
      status: 'critical',
      message: 'Admin Panel could not be reached.',
      recommendation: 'Check the Admin Panel deployment and domain availability.',
      latencyMs: result.latencyMs,
    });
  }

  const ok = result.status >= 200 && result.status < 300;
  return makeCheck({
    id: 'admin-panel',
    status: ok ? 'healthy' : 'attention',
    message: `Admin Panel responded with HTTP ${result.status}.`,
    latencyMs: result.latencyMs,
  });
}

function computeOverallStatus(checks) {
  let critical = false;
  let attention = false;

  for (const check of checks) {
    const isCore = CORE_CHECK_IDS.has(check.id);
    if (check.status === 'critical') {
      if (isCore) critical = true; else attention = true;
    } else if (check.status === 'attention') {
      attention = true;
    } else if (check.status === 'unknown' && isCore) {
      // A core system we cannot verify is worth Founder attention, but not a false outage.
      attention = true;
    }
  }

  if (critical) return 'critical';
  if (attention) return 'attention';
  return 'healthy';
}

const CHECK_RUNNERS = [
  { id: 'backend-api', run: checkBackendApi },
  { id: 'database', run: checkDatabase },
  { id: 'public-website', run: checkPublicWebsite },
  { id: 'publishing', run: checkPublishing },
  { id: 'push-notifications', run: checkPush },
  { id: 'analytics', run: checkAnalytics },
  { id: 'seo', run: checkSeo },
  { id: 'community-reporter', run: checkCommunityReporter },
  { id: 'admin-panel', run: checkAdminPanel },
];

async function getNewsPulseEngineHealth() {
  const checkedAt = new Date().toISOString();

  const settled = await Promise.allSettled(CHECK_RUNNERS.map((entry) => entry.run()));
  const checks = settled.map((result, index) => {
    if (result.status === 'fulfilled' && result.value) return result.value;
    return makeCheck({
      id: CHECK_RUNNERS[index].id,
      status: 'unknown',
      message: 'This check could not be completed safely.',
    });
  });

  const summary = { healthy: 0, attention: 0, critical: 0 };
  for (const check of checks) {
    if (Object.prototype.hasOwnProperty.call(summary, check.status)) summary[check.status] += 1;
  }

  return {
    ok: true,
    checkedAt,
    overallStatus: computeOverallStatus(checks),
    summary,
    checks,
  };
}

module.exports = { getNewsPulseEngineHealth };
