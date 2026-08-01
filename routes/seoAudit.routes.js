const express = require('express');

const { requireAuth, requireModuleAccess } = require('../middleware/requireAuth');
const {
  analyzeMetaTags,
  checkSitemaps,
  createRedirect,
  deleteRedirect,
  getLatestSeoAudit,
  getLatestSeoPerformanceTest,
  getLatestSitemapCheck,
  getMetaTagDetails,
  getSeoAudit,
  listRedirects,
  listSeoAudits,
  resolveRedirect,
  runSeoPerformanceTest,
  startSeoAudit,
  updateRedirect,
} = require('../services/seoAuditService');

const router = express.Router();
let lastPerformanceRunAt = 0;

function ok(res, status, message, data) {
  return res.status(status).json({ ok: true, success: true, status, message, ...data });
}

function fail(res, error) {
  const status = Number(error?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({ ok: false, success: false, status: safeStatus, code: error?.code || 'SEO_ERROR', message: error?.message || 'Unable to process SEO request.', ...(error?.activeAuditId ? { activeAuditId: error.activeAuditId } : {}) });
}

function hasSeoRight(req, right) {
  if (req.user?.isFounder || String(req.user?.role || '').toLowerCase() === 'founder') return true;
  const rights = Array.isArray(req.user?.specialRights) ? req.user.specialRights : [];
  return rights.includes(right);
}

function requireSeoRight(right) {
  return (req, res, next) => {
    if (hasSeoRight(req, right)) return next();
    return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: `SEO permission required: ${right}` });
  };
}

function performanceRateLimit(req, res, next) {
  if (!(process.env.GOOGLE_PAGESPEED_API_KEY || process.env.PAGESPEED_API_KEY)) return next();
  const windowMs = Math.max(Number.parseInt(process.env.SEO_PERFORMANCE_RATE_LIMIT_MS || '60000', 10) || 60000, 1000);
  const now = Date.now();
  if (lastPerformanceRunAt && now - lastPerformanceRunAt < windowMs) {
    return res.status(429).json({ ok: false, success: false, status: 429, code: 'SEO_PERFORMANCE_RATE_LIMITED', message: 'Please wait before running another SEO performance test.' });
  }
  lastPerformanceRunAt = now;
  return next();
}

function auditStatusPayload(audit) {
  if (!audit) return { status: 'idle', audit: null };
  return {
    status: audit.status,
    audit: { id: audit.id, status: audit.status, mode: audit.mode, totalPages: audit.totalPages, pagesChecked: audit.pagesChecked, progressPercent: audit.progressPercent, currentStage: audit.currentStage, currentUrl: audit.currentUrl, startedAt: audit.startedAt, lastProgressAt: audit.lastProgressAt, elapsedMs: audit.elapsedMs, score: audit.score, completedAt: audit.completedAt, durationMs: audit.durationMs, performance: audit.performance, errorMessage: audit.errorMessage },
  };
}

router.get('/redirects/resolve', async (req, res) => {
  try {
    const redirect = await resolveRedirect(req.query.path || '/');
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return ok(res, 200, 'SEO redirect resolved', { ...redirect, redirect, data: { redirect } });
  } catch (error) {
    return fail(res, error);
  }
});

router.use(requireAuth, requireModuleAccess('seo'));

router.post('/audit', requireSeoRight('seo.run_audit'), async (req, res) => {
  try {
    const audit = await startSeoAudit(req, { runInline: String(process.env.NODE_ENV || '').toLowerCase() === 'test' });
    return ok(res, 202, 'SEO audit started', { audit, data: { audit } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/audit/history', requireSeoRight('seo.view_audits'), async (req, res) => {
  try {
    const data = await listSeoAudits(req.query.limit, req.query.page);
    return ok(res, 200, 'SEO audit history fetched', { data, items: data.items });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/audit/latest', requireSeoRight('seo.view_audits'), async (_req, res) => {
  try {
    const audit = await getLatestSeoAudit();
    return ok(res, 200, 'Latest SEO audit fetched', { audit, data: { audit } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/audit/status', requireSeoRight('seo.view_audits'), async (_req, res) => {
  try {
    const audit = await getLatestSeoAudit();
    return ok(res, 200, 'SEO audit status fetched', { ...auditStatusPayload(audit), data: { audit } });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/performance', requireSeoRight('seo.run_audit'), performanceRateLimit, async (req, res) => {
  try {
    const performance = await runSeoPerformanceTest(req);
    return ok(res, 200, 'SEO performance test processed', { performance, data: { performance } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/performance/latest', requireSeoRight('seo.view_audits'), async (_req, res) => {
  try {
    const performance = await getLatestSeoPerformanceTest();
    return ok(res, 200, 'Latest SEO performance test fetched', { performance, data: { performance } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/audit/:id/status', requireSeoRight('seo.view_audits'), async (req, res) => {
  try {
    const audit = await getSeoAudit(req.params.id);
    return ok(res, 200, 'SEO audit status fetched', { ...auditStatusPayload(audit), data: { audit } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/audit/:id', requireSeoRight('seo.view_audits'), async (req, res) => {
  try {
    const audit = await getSeoAudit(req.params.id);
    return ok(res, 200, 'SEO audit fetched', { audit, data: { audit } });
  } catch (error) {
    return fail(res, error);
  }
});

async function latestSitemapHandler(_req, res) {
  try {
    const sitemap = await getLatestSitemapCheck();
    return ok(res, 200, 'SEO sitemap status fetched', { sitemap, data: { sitemap } });
  } catch (error) {
    return fail(res, error);
  }
}

async function checkSitemapHandler(req, res) {
  try {
    const sitemap = await checkSitemaps(req);
    return ok(res, 200, 'SEO sitemap check completed', { sitemap, data: { sitemap } });
  } catch (error) {
    return fail(res, error);
  }
}

router.get('/sitemaps', requireSeoRight('seo.view_sitemaps'), latestSitemapHandler);
router.get('/sitemap', requireSeoRight('seo.view_sitemaps'), latestSitemapHandler);
router.post('/sitemaps/check', requireSeoRight('seo.check_sitemaps'), checkSitemapHandler);
router.post('/sitemap/check', requireSeoRight('seo.check_sitemaps'), checkSitemapHandler);

router.get('/meta-tags', requireSeoRight('seo.view_meta_analysis'), async (req, res) => {
  try {
    const data = await analyzeMetaTags(req.query);
    return ok(res, 200, 'SEO meta tag analysis fetched', { data, items: data.items });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/meta-tags/:id', requireSeoRight('seo.view_meta_analysis'), async (req, res) => {
  try {
    const item = await getMetaTagDetails(req.params.id);
    return ok(res, 200, 'SEO meta tag details fetched', { item, data: { item } });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/redirects', requireSeoRight('seo.manage_redirects'), async (req, res) => {
  try {
    const data = await listRedirects(req.query);
    return ok(res, 200, 'SEO redirects fetched', { data, items: data.items });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/redirects', requireSeoRight('seo.manage_redirects'), async (req, res) => {
  try {
    const redirect = await createRedirect(req);
    return ok(res, 201, 'SEO redirect created', { redirect, data: { redirect } });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/redirects/:id', requireSeoRight('seo.manage_redirects'), async (req, res) => {
  try {
    const redirect = await updateRedirect(req);
    return ok(res, 200, 'SEO redirect updated', { redirect, data: { redirect } });
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/redirects/:id', requireSeoRight('seo.delete_redirects'), async (req, res) => {
  try {
    const data = await deleteRedirect(req);
    return ok(res, 200, 'SEO redirect deleted', { data });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;