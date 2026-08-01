process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'seo-audit-routes-secret';
process.env.SEO_AUDIT_SITE_URL = 'https://www.newspulse.co.in';
delete process.env.GOOGLE_PAGESPEED_API_KEY;
delete process.env.PAGESPEED_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const app = require('../server');
const seoAuditService = require('../services/seoAuditService');
const User = require('../models/User');
const Role = require('../models/Role');
const SeoAudit = require('../models/SeoAudit');
const SeoPerformanceTest = require('../models/SeoPerformanceTest');
const SeoRedirect = require('../models/SeoRedirect');
const SeoSitemapCheck = require('../models/SeoSitemapCheck');
const Article = require('../models/Article');
const AuditLog = require('../models/AuditLog');

const SEO_RIGHTS = ['seo.run_audit', 'seo.view_audits', 'seo.manage_redirects', 'seo.delete_redirects', 'seo.view_sitemaps', 'seo.check_sitemaps', 'seo.view_meta_analysis'];
const SEO_AUDIT_CONFIG_ENV_KEYS = [
  'SEO_AUDIT_MAX_PAGES',
  'SEO_AUDIT_FULL_MAX_PAGES',
  'SEO_AUDIT_PAGE_CONCURRENCY',
  'SEO_AUDIT_PAGE_TIMEOUT_MS',
  'SEO_AUDIT_OVERALL_TIMEOUT_MS',
  'SEO_AUDIT_FULL_OVERALL_TIMEOUT_MS',
  'SEO_AUDIT_PROGRESS_BATCH_SIZE',
  'SEO_AUDIT_LINK_CONCURRENCY',
  'SEO_AUDIT_QUICK_LINK_LIMIT',
  'SEO_AUDIT_FULL_LINK_LIMIT',
];
const originals = {};
let auditRecords;
let performanceRecords;
let redirectRecords;
let sitemapRecords;
let auditLogs;
let articleRecords;
let currentUser;
let nextAuditId;
let nextRedirectId;
let nextSitemapId;
let auditUpdates;

const GOOD_ARTICLE_ID = '507f1f77bcf86cd799439201';
const BAD_ARTICLE_ID = '507f1f77bcf86cd799439202';

function makeUser(role = 'founder', overrides = {}) {
  return {
    _id: role === 'reporter' ? '507f1f77bcf86cd799439102' : '507f1f77bcf86cd799439101',
    email: `${role.replace(/\s+/g, '.')}@example.com`,
    fullName: `${role} user`,
    name: `${role} user`,
    role,
    status: 'active',
    accountStatus: 'active',
    tokenVersion: 0,
    permissions: [],
    moduleAccessOverride: role === 'reporter' ? [] : ['seo'],
    specialRightsOverride: role === 'founder' ? [] : SEO_RIGHTS,
    ...overrides,
  };
}

function tokenFor(user = currentUser) {
  return jwt.sign({ sub: String(user._id), email: user.email, role: user.role, tokenVersion: 0, type: 'access' }, process.env.JWT_SECRET);
}

function expiredTokenFor(user = currentUser) {
  return jwt.sign({ sub: String(user._id), email: user.email, role: user.role, tokenVersion: 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
}

function queryChain(value) {
  return {
    sort() { return this; },
    skip(n) { if (Array.isArray(value)) value = value.slice(n); return this; },
    limit(n) { if (Array.isArray(value)) value = value.slice(0, n); return this; },
    lean: async () => value,
  };
}

function userFindByIdChain(user) {
  return {
    select: async () => user,
    lean: async () => user,
    then(resolve, reject) { return Promise.resolve(user).then(resolve, reject); },
  };
}

function response(body, status = 200, contentType = 'text/html; charset=utf-8', headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name || '').toLowerCase()] || (String(name || '').toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageSpeedResponse(score) {
  return response(JSON.stringify({ lighthouseResult: { categories: { performance: { score } } } }), 200, 'application/json');
}

function isPageSpeedUrl(url) {
  return String(url).startsWith('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
}

function assertAdminPerformanceContract(performance) {
  assert.deepEqual(Object.keys(performance).sort(), ['checkedAt', 'desktopScore', 'mobileScore', 'source', 'unavailableReason'].sort());
}

function auditObjectId(n) {
  return `507f1f77bcf86cd799439${String(n).padStart(3, '0')}`;
}

function clearSeoAuditConfigEnv() {
  for (const key of SEO_AUDIT_CONFIG_ENV_KEYS) delete process.env[key];
}

function findingFor(audit, checkCode, pageUrl = 'https://www.newspulse.co.in') {
  return (audit.results || []).filter((item) => item.checkCode === checkCode && item.pageUrl === pageUrl);
}

function homepageDocument(head, body = '') {
  return `<!doctype html><html><head>${head}<meta name="description" content="News Pulse publishes verified regional and national news updates for readers."><link rel="canonical" href="https://www.newspulse.co.in"><meta property="og:title" content="News Pulse"><meta property="og:description" content="News Pulse publishes verified regional and national news updates for readers."><meta property="og:image" content="https://www.newspulse.co.in/og.jpg"><meta name="twitter:title" content="News Pulse"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"News Pulse"}</script></head><body>${body}<img src="/logo.jpg" alt="News Pulse"></body></html>`;
}

function useHomepageHtml(html, contentType = 'text/html; charset=utf-8') {
  const normalFetch = global.__NEWS_PULSE_SEO_AUDIT_FETCH__;
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url) => {
    const target = String(url).replace(/\/+$/, '');
    if (target === 'https://www.newspulse.co.in') return response(html, 200, contentType);
    return normalFetch(url);
  };
}

function findAudit(filter = {}) {
  let items = auditRecords.slice();
  if (filter.status && filter.status.$in) items = items.filter((item) => filter.status.$in.includes(item.status));
  return items.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
}

test.beforeEach(() => {
  Object.assign(originals, {
    readyState: mongoose.connection.readyState,
    userFindById: User.findById,
    roleFindById: Role.findById,
    roleFindOne: Role.findOne,
    auditLogCreate: AuditLog.create,
    seoCreate: SeoAudit.create,
    seoFind: SeoAudit.find,
    seoFindOne: SeoAudit.findOne,
    seoFindById: SeoAudit.findById,
    seoFindByIdAndUpdate: SeoAudit.findByIdAndUpdate,
    performanceCreate: SeoPerformanceTest.create,
    performanceFindOne: SeoPerformanceTest.findOne,
    redirectCreate: SeoRedirect.create,
    redirectFind: SeoRedirect.find,
    redirectFindOne: SeoRedirect.findOne,
    redirectFindById: SeoRedirect.findById,
    redirectFindByIdAndUpdate: SeoRedirect.findByIdAndUpdate,
    redirectDeleteOne: SeoRedirect.deleteOne,
    sitemapCreate: SeoSitemapCheck.create,
    sitemapFindOne: SeoSitemapCheck.findOne,
    articleFind: Article.find,
    fetch: global.__NEWS_PULSE_SEO_AUDIT_FETCH__,
    siteUrl: process.env.SEO_AUDIT_SITE_URL,
    env: Object.fromEntries(['GOOGLE_PAGESPEED_API_KEY', 'PAGESPEED_API_KEY', ...SEO_AUDIT_CONFIG_ENV_KEYS].map((key) => [key, process.env[key]])),
  });

  mongoose.connection.readyState = 1;
  auditRecords = [];
  performanceRecords = [];
  redirectRecords = [];
  sitemapRecords = [];
  auditLogs = [];
  auditUpdates = [];
  nextAuditId = 1;
  nextRedirectId = 1;
  nextSitemapId = 1;
  currentUser = makeUser('founder');
  articleRecords = [
    { _id: GOOD_ARTICLE_ID, title: 'A clear public article title for SEO', slug: 'good-article', language: 'en', status: 'published', summary: 'This is a useful public description long enough to be useful in search snippets.', seo: { metaTitle: 'A clear public article title for SEO', metaDescription: 'This is a useful public description long enough to be useful in search snippets.', canonicalUrl: 'https://www.newspulse.co.in/good-article' }, coverImage: { url: 'https://www.newspulse.co.in/image.jpg', alt: 'News image' } },
    { _id: BAD_ARTICLE_ID, title: 'Short', slug: 'bad-article', language: 'en', status: 'published', summary: 'Tiny', seo: { metaTitle: 'Short', metaDescription: 'Tiny', canonicalUrl: 'https://www.newspulse.co.in/wrong' }, coverImage: { url: 'https://www.newspulse.co.in/image2.jpg', alt: null } },
  ];

  User.findById = (id) => userFindByIdChain(String(id) === String(currentUser._id) ? currentUser : null);
  Role.findById = () => ({ lean: async () => null });
  Role.findOne = () => ({ lean: async () => null });
  AuditLog.create = async (doc) => { auditLogs.push(doc); return doc; };

  SeoAudit.create = async (doc) => { const now = new Date(); const record = { _id: auditObjectId(nextAuditId++), ...doc, createdAt: now, updatedAt: now }; auditRecords.push(record); return record; };
  SeoAudit.findOne = (filter = {}) => queryChain(findAudit(filter));
  SeoAudit.find = () => queryChain(auditRecords.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
  SeoAudit.findById = (id) => queryChain(auditRecords.find((record) => String(record._id) === String(id)) || null);
  SeoAudit.findByIdAndUpdate = async (id, update) => { auditUpdates.push({ id, update }); const record = auditRecords.find((item) => String(item._id) === String(id)); if (!record) return null; if (update?.$set) Object.assign(record, update.$set, { updatedAt: new Date() }); return record; };

  SeoPerformanceTest.create = async (doc) => { const now = new Date(); const record = { _id: auditObjectId(700 + performanceRecords.length), ...doc, createdAt: now, updatedAt: now }; performanceRecords.push(record); return record; };
  SeoPerformanceTest.findOne = () => queryChain(performanceRecords.slice().sort((a, b) => new Date(b.checkedAt || b.createdAt) - new Date(a.checkedAt || a.createdAt))[0] || null);

  SeoSitemapCheck.create = async (doc) => { const record = { _id: String(nextSitemapId++), ...doc, createdAt: new Date(), updatedAt: new Date() }; sitemapRecords.push(record); return record; };
  SeoSitemapCheck.findOne = () => queryChain(sitemapRecords.slice().sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0] || null);

  SeoRedirect.create = async (doc) => { const record = { _id: String(nextRedirectId++), ...doc, createdAt: new Date(), updatedAt: new Date() }; redirectRecords.push(record); return record; };
  SeoRedirect.find = (filter = {}) => queryChain(redirectRecords.filter((item) => filter.isActive === undefined || item.isActive === filter.isActive));
  SeoRedirect.findOne = (filter = {}) => queryChain(redirectRecords.find((item) => item.sourcePath === filter.sourcePath && (filter.isActive === undefined || item.isActive === filter.isActive)) || null);
  SeoRedirect.findById = (id) => queryChain(redirectRecords.find((item) => String(item._id) === String(id)) || null);
  SeoRedirect.findByIdAndUpdate = async (id, update) => { const record = redirectRecords.find((item) => String(item._id) === String(id)); if (!record) return null; if (update?.$set) Object.assign(record, update.$set, { updatedAt: new Date() }); return record; };
  SeoRedirect.deleteOne = async (filter) => { const before = redirectRecords.length; redirectRecords = redirectRecords.filter((item) => String(item._id) !== String(filter._id)); return { deletedCount: before - redirectRecords.length }; };

  Article.find = (filter = {}) => {
    let items = articleRecords.slice();
    if (filter.language) items = items.filter((item) => item.language === filter.language);
    if (filter.status) items = items.filter((item) => item.status === filter.status);
    if (filter._id) items = items.filter((item) => String(item._id) === String(filter._id));
    if (filter.$or) items = items.filter((item) => filter.$or.some((clause) => clause.title?.test?.(item.title) || clause.slug?.test?.(item.slug)));
    return queryChain(items);
  };

  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url) => {
    const target = String(url);
    if (isPageSpeedUrl(target)) {
      const strategy = new URL(target).searchParams.get('strategy');
      return pageSpeedResponse(strategy === 'mobile' ? 0.67 : 0.91);
    }
    if (target.endsWith('/sitemap.xml')) return response('<urlset><url><loc>https://www.newspulse.co.in/</loc></url><url><loc>https://www.newspulse.co.in/bad-link</loc></url><url><loc>https://www.newspulse.co.in/noindex</loc></url></urlset>', 200, 'application/xml');
    if (target.endsWith('/news-sitemap.xml')) return response('<urlset><url><loc>https://www.newspulse.co.in/good-article</loc></url></urlset>', 200, 'application/xml');
    if (target.endsWith('/robots.txt')) return response('User-agent: *\nAllow: /', 200, 'text/plain');
    if (target.endsWith('/bad-link')) return response('missing', 404, 'text/plain');
    if (target.endsWith('/noindex')) return response('<html><head><title>Noindex page title that is long enough</title><meta name="description" content="This page is deliberately noindexed but present in the sitemap for testing."><meta name="robots" content="noindex"></head></html>');
    if (target.endsWith('/good-article')) return response('<!doctype html><html><head><title>A clear public article title for SEO</title><meta name="description" content="This is a useful public description long enough to be useful in search snippets."><link rel="canonical" href="https://www.newspulse.co.in/good-article"><meta property="og:title" content="A clear public article title for SEO"><meta property="og:description" content="This is a useful public description long enough to be useful in search snippets."><meta property="og:image" content="https://www.newspulse.co.in/image.jpg"><meta name="twitter:title" content="A clear public article title for SEO"><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"A clear public article title for SEO"}</script></head><body><img src="/image.jpg" alt="News image"></body></html>');
    return response('<!doctype html><html><head><title>News Pulse public homepage title</title><meta name="description" content="News Pulse publishes verified regional and national news updates for readers."><link rel="canonical" href="https://www.newspulse.co.in/"><meta property="og:title" content="News Pulse public homepage title"><meta property="og:description" content="News Pulse publishes verified regional and national news updates for readers."><meta property="og:image" content="https://www.newspulse.co.in/og.jpg"><meta name="twitter:title" content="News Pulse public homepage title"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"News Pulse"}</script></head><body><a href="/good-article">Article</a><img src="/logo.jpg" alt="News Pulse"></body></html>');
  };
});

test.afterEach(() => {
  mongoose.connection.readyState = originals.readyState;
  User.findById = originals.userFindById;
  Role.findById = originals.roleFindById;
  Role.findOne = originals.roleFindOne;
  AuditLog.create = originals.auditLogCreate;
  SeoAudit.create = originals.seoCreate;
  SeoAudit.find = originals.seoFind;
  SeoAudit.findOne = originals.seoFindOne;
  SeoAudit.findById = originals.seoFindById;
  SeoAudit.findByIdAndUpdate = originals.seoFindByIdAndUpdate;
  SeoPerformanceTest.create = originals.performanceCreate;
  SeoPerformanceTest.findOne = originals.performanceFindOne;
  SeoRedirect.create = originals.redirectCreate;
  SeoRedirect.find = originals.redirectFind;
  SeoRedirect.findOne = originals.redirectFindOne;
  SeoRedirect.findById = originals.redirectFindById;
  SeoRedirect.findByIdAndUpdate = originals.redirectFindByIdAndUpdate;
  SeoRedirect.deleteOne = originals.redirectDeleteOne;
  SeoSitemapCheck.create = originals.sitemapCreate;
  SeoSitemapCheck.findOne = originals.sitemapFindOne;
  Article.find = originals.articleFind;
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = originals.fetch;
  process.env.SEO_AUDIT_SITE_URL = originals.siteUrl;
  for (const [key, value] of Object.entries(originals.env || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('authenticated Founder can start an audit and create a numeric scored record', async () => {
  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 202);
  assert.equal(res.body.audit.status, 'completed');
  assert.equal(res.body.audit.mode, 'quick');
  assert.equal(res.body.audit.progressPercent, 100);
  assert.equal(res.body.audit.currentStage, 'Completed');
  assert.equal(typeof res.body.audit.score, 'number');
  assert.ok(res.body.audit.score >= 0 && res.body.audit.score <= 100);
  assert.ok(res.body.audit.pagesChecked >= 3);
  assertAdminPerformanceContract(res.body.audit.performance);
  assert.equal(res.body.audit.performance.desktopScore, null);
  assert.equal(res.body.audit.performance.mobileScore, null);
  assert.equal(res.body.audit.performance.source, null);
  assert.equal(res.body.audit.performance.checkedAt, null);
  assert.equal(res.body.audit.performance.unavailableReason, 'Performance testing is not configured');
  assert.equal(typeof res.body.audit.durationMs, 'number');
  assert.ok(res.body.audit.durationMs >= 0);
  assert.equal(res.body.audit.scoreUnavailableReason, null);
  assert.ok(Object.keys(res.body.audit.scoreBreakdown).length > 0);
  assert.ok(res.body.audit.categories.some((category) => category.value !== 'all'));
  assert.deepEqual(res.body.audit.startedBy, { id: currentUser._id, name: currentUser.fullName, staffId: null, role: 'Founder' });
  assert.equal(auditRecords.length, 1);
  assert.equal(typeof auditRecords[0].score, 'number');
  assert.equal(auditRecords[0].performance.desktopScore, null);
  assert.equal(auditRecords[0].performance.mobileScore, null);
  assert.equal(typeof auditRecords[0].durationMs, 'number');
  assert.ok(auditRecords[0].totalPages > 0);
  assert.ok(auditRecords[0].timings.pageScanMs >= 0);
  assert.ok(auditRecords[0].requestMetrics.httpRequests > 0);
  assert.ok(auditUpdates.some((entry) => entry.update?.$set?.currentStage === 'Scanning pages'));
  assert.ok(auditUpdates.some((entry) => entry.update?.$set?.progressPercent === 100));
});

test('Full Audit remains SEO-only and does not run configured performance testing', async () => {
  process.env.PAGESPEED_API_KEY = 'test-key';
  let pageSpeedCalls = 0;
  const normalFetch = global.__NEWS_PULSE_SEO_AUDIT_FETCH__;
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url, init) => {
    if (isPageSpeedUrl(url)) {
      pageSpeedCalls += 1;
      return pageSpeedResponse(0.5);
    }
    return normalFetch(url, init);
  };
  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({ mode: 'full', includePerformance: true });
  assert.equal(res.status, 202);
  assert.equal(res.body.audit.mode, 'full');
  assertAdminPerformanceContract(res.body.audit.performance);
  assert.equal(res.body.audit.performance.desktopScore, null);
  assert.equal(res.body.audit.performance.mobileScore, null);
  assert.equal(res.body.audit.performance.source, null);
  assert.equal(pageSpeedCalls, 0);
});

test('Quick Audit uses safe code defaults when SEO_AUDIT config env vars are absent', async () => {
  clearSeoAuditConfigEnv();
  const sitemapUrls = Array.from({ length: 120 }, (_, index) => `<url><loc>https://www.newspulse.co.in/default-page-${index + 1}</loc></url>`).join('');
  const linkAnchors = Array.from({ length: 220 }, (_, index) => `<a href="/default-link-${index + 1}">Link ${index + 1}</a>`).join('');
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url, init = {}) => {
    const target = String(url).replace(/\/+$/, '');
    const method = String(init.method || 'GET').toUpperCase();
    if (target.endsWith('/sitemap.xml')) return response(`<urlset>${sitemapUrls}</urlset>`, 200, 'application/xml');
    if (target.endsWith('/news-sitemap.xml')) return response('<urlset></urlset>', 200, 'application/xml');
    if (method === 'HEAD') return response('', 200, 'text/html');
    return response(homepageDocument('<title>Default Quick Audit Page</title>', linkAnchors));
  };

  const result = await seoAuditService.executeAudit('https://www.newspulse.co.in');
  assert.equal(result.mode, 'quick');
  assert.equal(result.totalPages, 100);
  assert.ok(result.requestMetrics.pageWorkerMaxConcurrency <= 10);
  assert.ok(result.requestMetrics.linkWorkerMaxConcurrency <= 15);
  assert.equal(result.requestMetrics.linkCacheEntries, 200);
  assert.equal(result.performance.desktopScore, null);
  assert.equal(result.performance.mobileScore, null);
  assert.equal(result.performance.unavailableReason, 'Performance testing is not configured');
});

test('Quick Audit uses bounded concurrency, caches page fetches, and dedupes link checks', async () => {
  process.env.SEO_AUDIT_MAX_PAGES = '12';
  process.env.SEO_AUDIT_PAGE_CONCURRENCY = '5';
  process.env.SEO_AUDIT_LINK_CONCURRENCY = '5';
  process.env.SEO_AUDIT_QUICK_LINK_LIMIT = '20';
  const pageGets = new Map();
  const linkHeads = new Map();
  let activePageGets = 0;
  let maxActivePageGets = 0;
  let pageSpeedCalls = 0;
  const sitemapUrls = Array.from({ length: 12 }, (_, index) => `<url><loc>https://www.newspulse.co.in/page-${index + 1}</loc></url>`).join('');
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url, init = {}) => {
    const target = String(url).replace(/\/+$/, '');
    const method = String(init.method || 'GET').toUpperCase();
    if (isPageSpeedUrl(target)) { pageSpeedCalls += 1; return pageSpeedResponse(0.5); }
    if (target.endsWith('/sitemap.xml')) return response(`<urlset>${sitemapUrls}<url><loc>https://www.newspulse.co.in/page-1</loc></url></urlset>`, 200, 'application/xml');
    if (target.endsWith('/news-sitemap.xml')) return response('<urlset><url><loc>https://www.newspulse.co.in/page-2</loc></url></urlset>', 200, 'application/xml');
    if (method === 'HEAD') {
      linkHeads.set(target, (linkHeads.get(target) || 0) + 1);
      return response('', 200, 'text/html');
    }
    pageGets.set(target, (pageGets.get(target) || 0) + 1);
    activePageGets += 1;
    maxActivePageGets = Math.max(maxActivePageGets, activePageGets);
    await delay(10);
    activePageGets -= 1;
    return response(homepageDocument(`<title>${target}</title>`, '<a href="/shared-link">Shared</a>'));
  };

  const result = await seoAuditService.executeAudit('https://www.newspulse.co.in', { mode: 'quick' });
  assert.equal(result.mode, 'quick');
  assert.ok(result.totalPages <= 12);
  assert.ok(maxActivePageGets > 1);
  assert.ok(maxActivePageGets <= 5);
  assert.ok(result.requestMetrics.pageWorkerMaxConcurrency <= 5);
  assert.equal(pageSpeedCalls, 0);
  assert.equal(pageGets.get('https://www.newspulse.co.in/page-1'), 1);
  assert.equal(linkHeads.get('https://www.newspulse.co.in/shared-link'), 1);
  assert.equal(result.requestMetrics.linkCacheEntries, 1);
});

test('page timeout records a warning and does not block other pages', async () => {
  process.env.SEO_AUDIT_MAX_PAGES = '10';
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url, init = {}) => {
    const target = String(url).replace(/\/+$/, '');
    if (target.endsWith('/sitemap.xml')) return response('<urlset><url><loc>https://www.newspulse.co.in/timeout-page</loc></url><url><loc>https://www.newspulse.co.in/healthy-page</loc></url></urlset>', 200, 'application/xml');
    if (target.endsWith('/news-sitemap.xml')) return response('<urlset></urlset>', 200, 'application/xml');
    if (target.endsWith('/timeout-page')) throw new Error('Request timed out');
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') return response('', 200, 'text/html');
    return response(homepageDocument('<title>Healthy News Pulse Page</title>', '<a href="/healthy-page">Healthy</a>'));
  };

  const result = await seoAuditService.executeAudit('https://www.newspulse.co.in', { mode: 'quick' });
  assert.ok(result.pagesChecked >= 2);
  assert.ok(result.requestMetrics.pagesTimedOut.some((url) => url.endsWith('/timeout-page')));
  assert.ok(result.results.some((item) => item.checkCode === 'page.fetch_timeout' && item.pageUrl.endsWith('/timeout-page') && item.severity === 'warning'));
  assert.ok(result.results.some((item) => item.pageUrl.endsWith('/healthy-page')));
});

test('unauthenticated audit request is rejected', async () => {
  const res = await request(app).post('/api/seo/audit').send({});
  assert.equal(res.status, 401);
});

test('missing or expired tokens return 401 on SEO read endpoints', async () => {
  const missing = await request(app).get('/api/seo/audit/latest');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'UNAUTHORIZED');

  const expired = await request(app).get('/api/seo/audit/history').set('Authorization', `Bearer ${expiredTokenFor()}`);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'UNAUTHORIZED');
});

test('user without SEO rights receives 403', async () => {
  currentUser = makeUser('reporter');
  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 403);
});

test('authenticated user without SEO access receives 403 on SEO read endpoints', async () => {
  currentUser = makeUser('reporter');
  const res = await request(app).get('/api/seo/audit/history').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('audit latest survives a new request and history pagination works', async () => {
  await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
  const auditId = auditObjectId(1);
  const latest = await request(app).get('/api/seo/audit/latest').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.audit.id, auditId);
  assertAdminPerformanceContract(latest.body.audit.performance);
  assert.equal(latest.body.audit.performance.desktopScore, null);
  assert.equal(latest.body.audit.performance.mobileScore, null);
  assert.equal(latest.body.audit.mode, 'quick');
  assert.equal(typeof latest.body.audit.durationMs, 'number');
  const fixedStatus = await request(app).get('/api/seo/audit/status').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(fixedStatus.status, 200);
  assert.equal(fixedStatus.body.audit.id, auditId);
  assert.equal(fixedStatus.body.audit.progressPercent, 100);
  const detail = await request(app).get(`/api/seo/audit/${auditId}`).set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(detail.status, 200);
  assertAdminPerformanceContract(detail.body.audit.performance);
  assert.equal(detail.body.audit.performance.desktopScore, null);
  assert.equal(detail.body.audit.performance.mobileScore, null);
  assert.equal(typeof detail.body.audit.durationMs, 'number');
  const status = await request(app).get(`/api/seo/audit/${auditId}/status`).set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(status.status, 200);
  assertAdminPerformanceContract(status.body.audit.performance);
  assert.equal(typeof status.body.audit.durationMs, 'number');
  assert.equal(status.body.audit.progressPercent, 100);
  const history = await request(app).get('/api/seo/audit/history?limit=1&page=1').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.items.length, 1);
});

test('invalid audit IDs return 400 instead of reaching Mongo ObjectId casting', async () => {
  const detail = await request(app).get('/api/seo/audit/not-an-object-id').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(detail.status, 400);
  assert.equal(detail.body.code, 'INVALID_SEO_AUDIT_ID');

  const status = await request(app).get('/api/seo/audit/not-an-object-id/status').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(status.status, 400);
  assert.equal(status.body.code, 'INVALID_SEO_AUDIT_ID');
});

test('performance provider failure does not affect SEO audit score or run inside audit', async () => {
  process.env.PAGESPEED_API_KEY = 'test-key';
  let pageSpeedCalls = 0;
  const normalFetch = global.__NEWS_PULSE_SEO_AUDIT_FETCH__;
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url, init) => {
    if (isPageSpeedUrl(url)) {
      pageSpeedCalls += 1;
      return response(JSON.stringify({ error: { message: 'quota exceeded' } }), 503, 'application/json');
    }
    return normalFetch(url, init);
  };
  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({ mode: 'full', includePerformance: true });
  assert.equal(res.status, 202);
  assert.equal(res.body.audit.status, 'completed');
  assert.equal(res.body.audit.mode, 'full');
  assert.equal(typeof res.body.audit.score, 'number');
  assertAdminPerformanceContract(res.body.audit.performance);
  assert.equal(res.body.audit.performance.desktopScore, null);
  assert.equal(res.body.audit.performance.mobileScore, null);
  assert.equal(res.body.audit.performance.source, null);
  assert.equal(res.body.audit.performance.unavailableReason, 'Performance testing is not configured');
  assert.notEqual(res.body.audit.performance.desktopScore, 0);
  assert.notEqual(res.body.audit.performance.mobileScore, 0);
  assert.equal(pageSpeedCalls, 0);
  assert.equal(auditRecords[0].status, 'completed');
});

test('separate performance endpoint returns null scores when provider is not configured', async () => {
  const res = await request(app).post('/api/seo/performance').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.performance.status, 'not_configured');
  assert.equal(res.body.performance.desktopScore, null);
  assert.equal(res.body.performance.mobileScore, null);
  assert.equal(res.body.performance.source, null);
  assert.equal(res.body.performance.message, 'Performance testing is not enabled');
  assert.equal(performanceRecords.length, 0);

  const latest = await request(app).get('/api/seo/performance/latest').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.performance.status, 'not_configured');
});

test('separate performance endpoint runs PageSpeed and stores latest result only when configured', async () => {
  process.env.PAGESPEED_API_KEY = 'test-key';
  const res = await request(app).post('/api/seo/performance').set('Authorization', `Bearer ${tokenFor()}`).send({ siteUrl: 'https://www.newspulse.co.in/' });
  assert.equal(res.status, 200);
  assert.equal(res.body.performance.status, 'completed');
  assert.equal(res.body.performance.desktopScore, 91);
  assert.equal(res.body.performance.mobileScore, 67);
  assert.equal(res.body.performance.source, 'Google PageSpeed Insights');
  assert.equal(res.body.performance.siteUrl, 'https://www.newspulse.co.in');
  assert.equal(performanceRecords.length, 1);

  const latest = await request(app).get('/api/seo/performance/latest').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.performance.status, 'completed');
  assert.equal(latest.body.performance.desktopScore, 91);
  assert.equal(latest.body.performance.mobileScore, 67);
});

test('performance endpoint rejects non-News Pulse URLs', async () => {
  const res = await request(app).post('/api/seo/performance').set('Authorization', `Bearer ${tokenFor()}`).send({ siteUrl: 'https://example.com' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PERFORMANCE_URL');
});

test('title.present uses head title text and records the detected value', async () => {
  const cases = [
    { name: 'valid title', head: '<title>News Pulse | Latest News</title>', expectedSeverity: 'passed', expectedValue: 'News Pulse | Latest News' },
    { name: 'empty title', head: '<title>   </title>', expectedSeverity: 'warning', expectedValue: null },
    { name: 'missing title', head: '', expectedSeverity: 'warning', expectedValue: null },
    { name: 'title with line breaks', head: '<title>\n  News Pulse\n</title>', expectedSeverity: 'passed', expectedValue: 'News Pulse' },
    { name: 'visible h1 only', head: '', body: '<h1>News Pulse</h1>', expectedSeverity: 'warning', expectedValue: null },
  ];

  for (const item of cases) {
    useHomepageHtml(homepageDocument(item.head, item.body || ''));
    const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
    assert.equal(res.status, 202, item.name);
    const findings = findingFor(res.body.audit, 'title.present');
    assert.equal(findings.length, 1, item.name);
    assert.equal(findings[0].severity, item.expectedSeverity, item.name);
    assert.equal(findings[0].currentValue, item.expectedValue, item.name);
  }
});

test('fetch failure reports HTML inspection failure instead of false missing title', async () => {
  const normalFetch = global.__NEWS_PULSE_SEO_AUDIT_FETCH__;
  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url) => {
    const target = String(url).replace(/\/+$/, '');
    if (target === 'https://www.newspulse.co.in') throw new Error('network timeout');
    return normalFetch(url);
  };

  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 202);
  assert.equal(res.body.audit.status, 'completed');
  assert.equal(findingFor(res.body.audit, 'title.present').length, 0);
  const inspectionFailures = findingFor(res.body.audit, 'html.inspectable');
  assert.equal(inspectionFailures.length, 1);
  assert.equal(inspectionFailures[0].title, 'Page HTML could not be inspected');
  assert.match(String(inspectionFailures[0].currentValue.error), /network timeout/);
});

test('old audit records calculate duration from timestamps when durationMs is missing', async () => {
  const startedAt = new Date('2026-08-02T10:00:00.000Z');
  const completedAt = new Date('2026-08-02T10:00:03.500Z');
  const auditId = auditObjectId(901);
  auditRecords.push({ _id: auditId, siteUrl: 'https://www.newspulse.co.in', status: 'completed', score: 80, startedAt, completedAt, createdAt: startedAt, results: [], performance: { desktopScore: 90, mobileScore: 70, source: 'Google PageSpeed Insights', checkedAt: completedAt, unavailableReason: null } });
  const res = await request(app).get(`/api/seo/audit/${auditId}`).set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.audit.durationMs, 3500);
  assert.equal(res.body.audit.startedAt, startedAt.toISOString());
  assert.equal(res.body.audit.completedAt, completedAt.toISOString());
  assertAdminPerformanceContract(res.body.audit.performance);
});

test('audit startedBy falls back safely when staff account no longer exists', async () => {
  const auditId = auditObjectId(902);
  auditRecords.push({ _id: auditId, siteUrl: 'https://www.newspulse.co.in', status: 'completed', score: 80, startedAt: new Date(), createdAt: new Date(), createdBy: '507f1f77bcf86cd799439199', results: [] });
  const res = await request(app).get(`/api/seo/audit/${auditId}`).set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.audit.startedBy.name, 'Former or unavailable staff account');
  assert.equal(res.body.audit.startedBy.staffId, null);
});

test('active audit duplicate prevention works', async () => {
  auditRecords.push({ _id: 'active', siteUrl: 'https://www.newspulse.co.in', status: 'running', startedAt: new Date(), createdAt: new Date() });
  const res = await request(app).post('/api/seo/audit').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SEO_AUDIT_ALREADY_RUNNING');
});

test('sitemap check returns actual status and malformed sitemap warnings', async () => {
  const res = await request(app).post('/api/seo/sitemaps/check').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.sitemap.files.length, 3);
  assert.equal(res.body.sitemap.files[0].urlCount, 3);
  assert.ok(res.body.sitemap.files[0].urlsReturningErrors.some((item) => item.url.endsWith('/bad-link')));
  assert.ok(res.body.sitemap.files[0].noindexUrlsIncluded.some((url) => url.endsWith('/noindex')));

  global.__NEWS_PULSE_SEO_AUDIT_FETCH__ = async (url) => String(url).endsWith('/robots.txt') ? response('User-agent: *', 200, 'text/plain') : response('<notxml>', 200, 'application/xml');
  const malformed = await request(app).post('/api/seo/sitemaps/check').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.ok(malformed.body.sitemap.files.some((file) => file.warnings.some((warning) => /malformed|no URL entries/i.test(warning))));
});

test('singular sitemap endpoint returns a useful empty state before first check', async () => {
  const latest = await request(app).get('/api/seo/sitemap').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.sitemap.status, 'not_checked');
  assert.equal(latest.body.sitemap.files.length, 3);
  assert.equal(latest.body.sitemap.files[0].available, false);

  const checked = await request(app).post('/api/seo/sitemap/check').set('Authorization', `Bearer ${tokenFor()}`).send({});
  assert.equal(checked.status, 200);
  assert.equal(checked.body.sitemap.status, 'completed');
});

test('meta analysis loads real articles and reports issues', async () => {
  const res = await request(app).get('/api/seo/meta-tags?status=published').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 2);
  assert.deepEqual(res.body.data.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });
  assert.ok(res.body.data.availableFilters.seoStatuses.includes('warning'));
  const bad = res.body.data.items.find((item) => item.slug === 'bad-article');
  assert.equal(bad.seoStatus, 'warning');
  assert.equal(bad.seoTitleLength, 5);
  assert.equal(bad.descriptionLength, 4);
  assert.ok(bad.detectedIssues.some((issue) => issue.code === 'title_length'));
  assert.ok(bad.detectedIssues.some((issue) => issue.code === 'canonical_mismatch'));
});

test('meta analysis supports combined filters and details endpoint', async () => {
  articleRecords.push({ _id: '507f1f77bcf86cd799439203', title: 'Hindi story with missing SEO data', slug: 'hindi-story', language: 'hi', status: 'draft', summary: '', seo: {}, coverImage: null });
  const filtered = await request(app).get('/api/seo/meta-tags?language=hi&publicationStatus=draft&seoStatus=critical&search=hindi').set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.data.items.length, 1);
  assert.equal(filtered.body.data.items[0].seoStatus, 'critical');

  const details = await request(app).get(`/api/seo/meta-tags/${BAD_ARTICLE_ID}`).set('Authorization', `Bearer ${tokenFor()}`);
  assert.equal(details.status, 200);
  assert.equal(details.body.item.articleId, BAD_ARTICLE_ID);
  assert.equal(details.body.item.publicUrl, 'https://www.newspulse.co.in/bad-article');
  assert.ok(Array.isArray(details.body.item.recommendations));
});

test('redirect creation works and creates audit-log entries', async () => {
  const res = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/old-story', destinationUrl: '/good-article', statusCode: 301, reason: 'moved' });
  assert.equal(res.status, 201);
  assert.equal(res.body.redirect.sourcePath, '/old-story');
  assert.equal(redirectRecords.length, 1);
  assert.ok(auditLogs.some((entry) => entry.action === 'SEO_REDIRECT_CREATED'));
});

test('redirect creation accepts 302 and rejects unsupported status codes', async () => {
  const temporary = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/temporary-story', destinationUrl: '/good-article', statusCode: 302 });
  assert.equal(temporary.status, 201);
  assert.equal(temporary.body.redirect.statusCode, 302);

  const invalid = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/bad-status', destinationUrl: '/good-article', statusCode: 307 });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_REDIRECT_STATUS');
});

test('duplicate source, redirect loop, and protected route redirects are rejected', async () => {
  await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/old-story', destinationUrl: '/good-article' });
  const duplicate = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/old-story', destinationUrl: '/good-article' });
  assert.equal(duplicate.status, 409);
  const loop = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/same', destinationUrl: '/same' });
  assert.equal(loop.status, 400);
  assert.equal(loop.body.code, 'REDIRECT_LOOP_DETECTED');
  const protectedRoute = await request(app).post('/api/seo/redirects').set('Authorization', `Bearer ${tokenFor()}`).send({ sourcePath: '/api/news', destinationUrl: '/good-article' });
  assert.equal(protectedRoute.status, 400);
  assert.equal(protectedRoute.body.code, 'PROTECTED_REDIRECT_SOURCE');
});

test('public redirect resolve returns safe public redirect information', async () => {
  redirectRecords.push({ _id: 'r1', sourcePath: '/old-story', destinationUrl: 'https://www.newspulse.co.in/good-article', statusCode: 302, isActive: true, createdAt: new Date(), updatedAt: new Date() });
  const res = await request(app).get('/api/seo/redirects/resolve?path=/old-story');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.redirect, { matched: true, destination: 'https://www.newspulse.co.in/good-article', statusCode: 302 });
  assert.equal(res.body.statusCode, 302);

  const publicAlias = await request(app).get('/api/public/seo/redirects/resolve?path=/old-story');
  assert.equal(publicAlias.status, 200);
  assert.deepEqual(publicAlias.body.redirect, { matched: true, destination: 'https://www.newspulse.co.in/good-article', statusCode: 302 });

  const miss = await request(app).get('/api/public/seo/redirects/resolve?path=/missing-story');
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body.redirect, { matched: false });
});