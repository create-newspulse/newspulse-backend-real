const mongoose = require('mongoose');
const cheerio = require('cheerio');

const SeoAudit = require('../models/SeoAudit');
const SeoPerformanceTest = require('../models/SeoPerformanceTest');
const SeoRedirect = require('../models/SeoRedirect');
const SeoSitemapCheck = require('../models/SeoSitemapCheck');
const Article = require('../models/Article');
const User = require('../models/User');
const { logAudit } = require('../lib/audit');

const DEFAULT_SITE_URL = 'https://www.newspulse.co.in';
const PAGESPEED_TIMEOUT_MS = 20000;
const DEFAULT_SITEMAP_URL_CHECK_LIMIT = 50;
const FULL_LINK_LIMIT = 1000;
const FULL_OVERALL_TIMEOUT_MS = 300000;
const SEO_AUDIT_DEFAULTS = Object.freeze({
  defaultMode: 'quick',
  quickPageLimit: 100,
  pageConcurrency: 10,
  pageTimeoutMs: 6000,
  overallTimeoutMs: 120000,
  progressBatchSize: 5,
  linkConcurrency: 15,
  quickLinkLimit: 200,
});
const PROGRESS_STAGES = Object.freeze({
  loadingSitemaps: 'Loading sitemaps',
  preparingUrls: 'Preparing URLs',
  scanningPages: 'Scanning pages',
  checkingInternalLinks: 'Checking internal links',
  calculatingScore: 'Calculating score',
  savingResults: 'Saving results',
  completed: 'Completed',
});
const PROTECTED_REDIRECT_PREFIXES = ['/admin', '/api', '/assets', '/uploads', '/_next', '/favicon.ico', '/robots.txt', '/sitemap.xml', '/news-sitemap.xml'];
const CRAWL_EXCLUDED_PREFIXES = ['/admin', '/api', '/assets', '/uploads', '/_next', '/favicon.ico'];
const STATIC_ASSET_RE = /\.(?:avif|bmp|css|csv|docx?|gif|ico|jpeg|jpg|js|json|map|mp3|mp4|pdf|png|svg|txt|webm|webp|woff2?|xml|zip)$/i;
const QUICK_SEED_PATHS = ['/', '/national', '/international', '/business', '/sports', '/lifestyle', '/hi', '/gu'];
const CATEGORY_LABELS = Object.freeze({
  availability: 'Availability',
  metadata: 'Metadata',
  canonical: 'Canonical',
  indexability: 'Indexability',
  open_graph: 'Open Graph',
  structured_data: 'Structured Data',
  images: 'Images',
  internal_links: 'Internal Links',
  redirects: 'Redirects',
  sitemap: 'Sitemap',
  robots: 'Robots',
  performance: 'Performance',
});
const SCORE_WEIGHTS = Object.freeze({
  availability: 12,
  metadata: 18,
  canonical: 10,
  indexability: 12,
  open_graph: 10,
  structured_data: 10,
  images: 8,
  internal_links: 8,
  redirects: 4,
  sitemap: 8,
});

class SeoAuditError extends Error {
  constructor(message, status = 500, code = 'SEO_ERROR') {
    super(message);
    this.name = 'SeoAuditError';
    this.status = status;
    this.code = code;
  }
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isFounder(req) {
  return req?.user?.isFounder || String(req?.user?.role || '').toLowerCase() === 'founder';
}

function actorId(req) {
  return req?.user?.id || req?.user?.sub || null;
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return false;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new SeoAuditError('SEO site URL is invalid. Configure SEO_AUDIT_SITE_URL or PUBLIC_BASE_URL with an absolute http(s) URL.', 400, 'INVALID_SITE_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new SeoAuditError('SEO site URL must use http or https.', 400, 'INVALID_SITE_URL');
  if (isProduction() && isPrivateHost(parsed.hostname)) throw new SeoAuditError('SEO site URL cannot target localhost or private network hosts in production.', 400, 'UNSAFE_SITE_URL');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveSiteUrl() {
  return normalizeBaseUrl(process.env.SEO_AUDIT_SITE_URL || process.env.NEWS_PULSE_PUBLIC_SITE_URL || process.env.PUBLIC_WEBSITE_URL || process.env.SITE_URL || process.env.PUBLIC_BASE_URL || DEFAULT_SITE_URL);
}

function getFetcher() {
  return global.__NEWS_PULSE_SEO_AUDIT_FETCH__ || global.fetch;
}

function getLimit(name, fallback, max) {
  const value = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function getBoundedLimit(name, fallback, min, max) {
  const value = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAuditMode(value) {
  return String(value || '').toLowerCase() === 'full' ? 'full' : SEO_AUDIT_DEFAULTS.defaultMode;
}

function auditConfig(modeValue) {
  const mode = normalizeAuditMode(modeValue);
  const quickMax = Math.min(getLimit('SEO_AUDIT_MAX_PAGES', SEO_AUDIT_DEFAULTS.quickPageLimit, SEO_AUDIT_DEFAULTS.quickPageLimit), SEO_AUDIT_DEFAULTS.quickPageLimit);
  return {
    mode,
    maxPages: mode === 'full' ? getLimit('SEO_AUDIT_FULL_MAX_PAGES', 250, 1000) : quickMax,
    pageConcurrency: getBoundedLimit('SEO_AUDIT_PAGE_CONCURRENCY', SEO_AUDIT_DEFAULTS.pageConcurrency, 5, 15),
    linkConcurrency: getBoundedLimit('SEO_AUDIT_LINK_CONCURRENCY', SEO_AUDIT_DEFAULTS.linkConcurrency, 5, 25),
    pageTimeoutMs: getLimit('SEO_AUDIT_PAGE_TIMEOUT_MS', SEO_AUDIT_DEFAULTS.pageTimeoutMs, 30000),
    overallTimeoutMs: mode === 'full' ? getLimit('SEO_AUDIT_FULL_OVERALL_TIMEOUT_MS', getLimit('SEO_AUDIT_OVERALL_TIMEOUT_MS', FULL_OVERALL_TIMEOUT_MS, 600000), 600000) : getLimit('SEO_AUDIT_OVERALL_TIMEOUT_MS', SEO_AUDIT_DEFAULTS.overallTimeoutMs, 300000),
    progressBatchSize: getBoundedLimit('SEO_AUDIT_PROGRESS_BATCH_SIZE', SEO_AUDIT_DEFAULTS.progressBatchSize, 1, 50),
    linkLimit: mode === 'full' ? getLimit('SEO_AUDIT_FULL_LINK_LIMIT', FULL_LINK_LIMIT, 5000) : getLimit('SEO_AUDIT_QUICK_LINK_LIMIT', SEO_AUDIT_DEFAULTS.quickLinkLimit, 1000),
  };
}

function isAllowedNewsPulseHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'newspulse.co.in' || host === 'www.newspulse.co.in';
}

function isExcludedCrawlPath(pathname) {
  const path = String(pathname || '/').toLowerCase();
  if (CRAWL_EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  return STATIC_ASSET_RE.test(path);
}

function normalizeAuditUrl(value, siteUrl) {
  let parsed;
  try { parsed = new URL(String(value || ''), siteUrl); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!isAllowedNewsPulseHost(parsed.hostname)) return null;
  if (isExcludedCrawlPath(parsed.pathname)) return null;
  parsed.hash = '';
  const out = parsed.toString().replace(/\/+$/, '');
  return out || null;
}

function uniqueOrdered(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let maxActive = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      } finally {
        active -= 1;
      }
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, () => runWorker());
  await Promise.all(workers);
  return { results, maxActive };
}

function createAuditContext(siteUrl, config) {
  return {
    siteUrl,
    config,
    startedAt: Date.now(),
    deadlineAt: Date.now() + config.overallTimeoutMs,
    responseCache: new Map(),
    linkCache: new Map(),
    metrics: { httpRequests: 0, activeRequests: 0, maxConcurrency: 0, pageWorkerMaxConcurrency: 0, linkWorkerMaxConcurrency: 0, pagesTimedOut: [] },
  };
}

function noteRequestStart(context) {
  if (!context) return;
  context.metrics.httpRequests += 1;
  context.metrics.activeRequests += 1;
  context.metrics.maxConcurrency = Math.max(context.metrics.maxConcurrency, context.metrics.activeRequests);
}

function noteRequestEnd(context) {
  if (!context) return;
  context.metrics.activeRequests = Math.max(0, context.metrics.activeRequests - 1);
}

async function fetchUrl(url, options = {}) {
  const fetcher = getFetcher();
  if (typeof fetcher !== 'function') throw new SeoAuditError('Fetch API is unavailable in this runtime.', 500, 'FETCH_UNAVAILABLE');
  const visited = [];
  let current = String(url);
  const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : 5;
  let retried = false;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs || SEO_AUDIT_DEFAULTS.pageTimeoutMs) : null;
    try {
      noteRequestStart(options.context);
      const response = await fetcher(current, {
        method: options.method || 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'NewsPulse-SEO-Audit/1.0',
          Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = response.status;
      const contentType = String(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') || '' : '');
      const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null;
      visited.push({ url: current, status, location: location || null });
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      if (options.retry !== false && !retried && (status === 429 || (status >= 500 && status < 600))) {
        retried = true;
        await sleep(Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 250);
        continue;
      }
      const text = options.readBody === false ? '' : await response.text();
      return { requestedUrl: String(url), url: current, status, ok: status >= 200 && status < 300, contentType, text, redirectChain: visited };
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'Request timed out' : (error?.message || String(error));
      return { requestedUrl: String(url), url: current, status: null, ok: false, contentType: null, text: '', redirectChain: visited, error: message };
    } finally {
      if (timeout) clearTimeout(timeout);
      noteRequestEnd(options.context);
    }
  }
  return { requestedUrl: String(url), url: current, status: null, ok: false, contentType: null, text: '', redirectChain: visited, error: 'Redirect limit exceeded' };
}

function decodeHtml(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractFirst(pattern, html) {
  const match = String(html || '').match(pattern);
  return match ? decodeHtml(String(match[1] || '').trim()) : '';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMeta(name, html) {
  const escaped = escapeRegex(name);
  return extractFirst(new RegExp(`<meta\\b(?=[^>]*(?:name|property)\\s*=\\s*["']${escaped}["'])(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])[^>]*>`, 'i'), html);
}

function getCanonical(html) {
  return extractFirst(/<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])(?=[^>]*\bhref\s*=\s*["']([^"']*)["'])[^>]*>/i, html);
}

function extractStructuredData(html) {
  const scripts = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;
    try { scripts.push(JSON.parse(raw)); } catch (_) { scripts.push({ __invalid: true }); }
  }
  return scripts;
}

function flattenStructuredData(items) {
  const out = [];
  for (const item of items || []) {
    if (Array.isArray(item)) out.push(...flattenStructuredData(item));
    else if (item && typeof item === 'object') {
      out.push(item);
      if (Array.isArray(item['@graph'])) out.push(...flattenStructuredData(item['@graph']));
    }
  }
  return out;
}

function extractLinks(html, siteUrl) {
  const base = new URL(siteUrl);
  const links = [];
  const seen = new Set();
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let match;
  while ((match = hrefRe.exec(String(html || '')))) {
    const href = String(match[1] || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let parsed;
    try { parsed = new URL(href, siteUrl); } catch (_) { continue; }
    if (parsed.origin !== base.origin) continue;
    parsed.hash = '';
    const normalized = parsed.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      links.push(normalized);
    }
  }
  return links;
}

function extractImages(html) {
  const images = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let match;
  while ((match = imgRe.exec(String(html || '')))) {
    const attrs = String(match[1] || '');
    const src = extractFirst(/\bsrc\s*=\s*["']([^"']*)["']/i, attrs);
    const alt = extractFirst(/\balt\s*=\s*["']([^"']*)["']/i, attrs);
    images.push({ src, alt, hasAlt: Boolean(alt) });
  }
  return images;
}

function normalizeFindingCategory(finding) {
  const code = String(finding?.checkCode || '');
  const raw = String(finding?.category || '').toLowerCase();
  if (raw === 'social') return 'open_graph';
  if (raw === 'accessibility') return 'images';
  if (raw === 'indexing') return code.includes('robots') ? 'robots' : 'indexability';
  if (raw === 'technical' && code.startsWith('canonical.')) return 'canonical';
  if (raw === 'technical' && code.startsWith('redirect.')) return 'redirects';
  if (raw === 'technical') return 'indexability';
  if (raw === 'availability') return 'availability';
  if (raw === 'metadata') return 'metadata';
  if (raw === 'structured_data') return 'structured_data';
  if (raw === 'sitemap') return 'sitemap';
  if (raw === 'robots') return 'robots';
  if (raw === 'performance') return 'performance';
  return raw || 'metadata';
}

function categoryList(results) {
  const counts = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const category = normalizeFindingCategory(result);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: CATEGORY_LABELS[value] || value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function addFinding(state, finding) {
  const category = normalizeFindingCategory(finding);
  const full = {
    checkCode: finding.checkCode,
    category,
    severity: finding.severity,
    pageUrl: finding.pageUrl || null,
    title: finding.title || null,
    description: finding.description || null,
    currentValue: finding.currentValue === undefined ? null : finding.currentValue,
    recommendedAction: finding.recommendedAction || null,
  };
  const findingKey = `${full.pageUrl || ''}|${full.checkCode || ''}`;
  if (state.findingKeys && state.findingKeys.has(findingKey)) return;
  if (state.findingKeys) state.findingKeys.add(findingKey);
  state.results.push(full);
  if (full.severity === 'passed') state.passedChecks.push(full.title || full.checkCode);
  else if (full.severity === 'warning') state.warnings.push(full.title || full.checkCode);
  else state.criticalIssues.push(full.title || full.checkCode);
}

function addBooleanFinding(state, condition, base) {
  addFinding(state, { ...base, severity: condition ? 'passed' : (base.failSeverity || 'warning'), title: condition ? base.passTitle : base.failTitle, description: condition ? base.passDescription : base.failDescription, recommendedAction: condition ? null : base.recommendedAction });
}

function extractHeadTitle(html) {
  const $ = cheerio.load(String(html || ''));
  const title = $('head title').first().text().replace(/\s+/g, ' ').trim();
  return title;
}

function canInspectHtml(page) {
  if (!page || !page.ok) return false;
  if (!String(page.contentType || '').toLowerCase().includes('text/html')) return false;
  if (!String(page.text || '').trim()) return false;
  return true;
}

function addHtmlInspectionFailure(state, page) {
  addFinding(state, {
    checkCode: 'html.inspectable',
    category: 'availability',
    severity: page?.ok ? 'warning' : 'critical',
    pageUrl: page?.url || page?.requestedUrl || null,
    title: 'Page HTML could not be inspected',
    description: 'The SEO crawler could not inspect the page HTML, so metadata checks were not evaluated for this URL.',
    currentValue: { status: page?.status || null, contentType: page?.contentType || null, error: page?.error || null, htmlLength: String(page?.text || '').length },
    recommendedAction: 'Confirm the page responds with a successful text/html document before rerunning the audit.',
  });
  if (/timed out/i.test(String(page?.error || ''))) {
    addFinding(state, {
      checkCode: 'page.fetch_timeout',
      category: 'availability',
      severity: 'warning',
      pageUrl: page?.url || page?.requestedUrl || null,
      title: 'Page request timed out',
      description: 'The page exceeded the configured SEO audit timeout and was skipped without blocking the rest of the audit.',
      currentValue: { timeoutMs: null, error: page?.error || null },
      recommendedAction: 'Check page response time or increase SEO_AUDIT_PAGE_TIMEOUT_MS for deeper audits.',
    });
  }
}

function analyzePage(page, siteUrl, state) {
  const html = page.text || '';
  addBooleanFinding(state, page.ok, { checkCode: 'site.availability', category: 'availability', pageUrl: page.url, failSeverity: 'critical', passTitle: 'Page is reachable', failTitle: 'Page is unreachable', currentValue: page.status || page.error, recommendedAction: 'Confirm the public page responds successfully.' });
  addBooleanFinding(state, page.status && page.status < 400, { checkCode: 'http.status', category: 'availability', pageUrl: page.url, failSeverity: 'critical', passTitle: 'HTTP status is healthy', failTitle: 'HTTP status returned an error', currentValue: page.status, recommendedAction: 'Fix server, route, or publishing errors for this URL.' });
  if (!canInspectHtml(page)) {
    state.urlsChecked.push({ url: page.url, status: page.status, ok: page.ok, contentType: page.contentType, checks: { htmlInspectable: false }, error: page.error || null });
    addHtmlInspectionFailure(state, page);
    return;
  }

  const title = extractHeadTitle(html);
  const titlePresent = title.length > 0;
  const description = getMeta('description', html);
  const canonical = getCanonical(html);
  const robots = getMeta('robots', html);
  const ogTitle = getMeta('og:title', html);
  const ogDescription = getMeta('og:description', html);
  const ogImage = getMeta('og:image', html);
  const twitterTitle = getMeta('twitter:title', html);
  const twitterDescription = getMeta('twitter:description', html);
  const twitterImage = getMeta('twitter:image', html);
  const structured = extractStructuredData(html);
  const flattenedStructured = flattenStructuredData(structured);
  const images = extractImages(html);
  const missingAlt = images.filter((img) => !img.hasAlt).length;
  let expectedCanonical = page.url.replace(/\/+$/, '');
  if (expectedCanonical === siteUrl) expectedCanonical = `${siteUrl}/`.replace(/\/+$/, '');
  let canonicalComparable = '';
  try { canonicalComparable = canonical ? new URL(canonical, siteUrl).toString().replace(/\/+$/, '') : ''; } catch (_) {}

  state.pageMeta.push({ url: page.url, title, description, canonical: canonicalComparable, robots });
  state.urlsChecked.push({ url: page.url, status: page.status, ok: page.ok, contentType: page.contentType, checks: { title, metaDescription: description, canonicalUrl: canonical, robotsMeta: robots, ogTitle, ogDescription, ogImage, twitterTitle, twitterDescription, twitterImage, structuredData: structured.length > 0, imageCount: images.length, missingAlt }, error: page.error || null });
  if (Array.isArray(state.internalLinks)) state.internalLinks.push(...extractLinks(html, siteUrl));

  addBooleanFinding(state, page.url.startsWith('https://'), { checkCode: 'https.use', category: 'technical', pageUrl: page.url, passTitle: 'Page uses HTTPS', failTitle: 'Page does not use HTTPS', currentValue: page.url, recommendedAction: 'Serve public pages through HTTPS.' });
  addBooleanFinding(state, titlePresent, { checkCode: 'title.present', category: 'metadata', pageUrl: page.url, passTitle: 'Title is present', failTitle: 'Title is missing', currentValue: title || null, recommendedAction: 'Add a descriptive page title.' });
  if (titlePresent) addBooleanFinding(state, title.length >= 30 && title.length <= 65, { checkCode: 'title.length', category: 'metadata', pageUrl: page.url, passTitle: 'Title length is within target range', failTitle: 'Title length is outside target range', currentValue: `${title.length} characters`, recommendedAction: 'Keep titles roughly 30-65 characters.' });
  addBooleanFinding(state, Boolean(description), { checkCode: 'description.present', category: 'metadata', pageUrl: page.url, passTitle: 'Meta description is present', failTitle: 'Meta description is missing', currentValue: description, recommendedAction: 'Add a concise meta description.' });
  if (description) addBooleanFinding(state, description.length >= 70 && description.length <= 160, { checkCode: 'description.length', category: 'metadata', pageUrl: page.url, passTitle: 'Meta description length is within target range', failTitle: 'Meta description length is outside target range', currentValue: `${description.length} characters`, recommendedAction: 'Keep descriptions roughly 70-160 characters.' });
  addBooleanFinding(state, Boolean(canonical), { checkCode: 'canonical.present', category: 'technical', pageUrl: page.url, passTitle: 'Canonical URL is present', failTitle: 'Canonical URL is missing', currentValue: canonical, recommendedAction: 'Add a canonical link tag.' });
  if (canonical) addBooleanFinding(state, canonicalComparable === expectedCanonical, { checkCode: 'canonical.matches_url', category: 'technical', pageUrl: page.url, passTitle: 'Canonical URL matches page URL', failTitle: 'Canonical URL differs from page URL', currentValue: canonical, recommendedAction: 'Point canonical URL at the public page URL unless an intentional canonical target exists.' });
  addBooleanFinding(state, !(robots && /noindex/i.test(robots)), { checkCode: 'robots.noindex', category: 'indexing', pageUrl: page.url, failSeverity: 'critical', passTitle: 'Robots meta does not block indexing', failTitle: 'Robots meta blocks indexing', currentValue: robots || null, recommendedAction: 'Remove noindex from pages intended for search.' });
  addBooleanFinding(state, Boolean(ogTitle), { checkCode: 'og.title', category: 'social', pageUrl: page.url, passTitle: 'Open Graph title is present', failTitle: 'Open Graph title is missing', currentValue: ogTitle, recommendedAction: 'Add og:title metadata.' });
  addBooleanFinding(state, Boolean(ogDescription), { checkCode: 'og.description', category: 'social', pageUrl: page.url, passTitle: 'Open Graph description is present', failTitle: 'Open Graph description is missing', currentValue: ogDescription, recommendedAction: 'Add og:description metadata.' });
  addBooleanFinding(state, Boolean(ogImage), { checkCode: 'og.image', category: 'social', pageUrl: page.url, passTitle: 'Open Graph image is present', failTitle: 'Open Graph image is missing', currentValue: ogImage, recommendedAction: 'Add og:image metadata.' });
  addBooleanFinding(state, Boolean(twitterTitle || twitterDescription || twitterImage), { checkCode: 'twitter.metadata', category: 'social', pageUrl: page.url, passTitle: 'Twitter/X metadata is present', failTitle: 'Twitter/X metadata is missing', currentValue: { twitterTitle, twitterDescription, twitterImage }, recommendedAction: 'Add Twitter/X card metadata when social cards are used.' });
  addBooleanFinding(state, structured.length > 0 && !structured.some((item) => item.__invalid), { checkCode: 'structured_data.present', category: 'structured_data', pageUrl: page.url, passTitle: 'Structured data is present and parseable', failTitle: structured.length ? 'Structured data is malformed' : 'Structured data is missing', currentValue: structured.length, recommendedAction: 'Add valid JSON-LD structured data.' });
  const articleStructured = flattenedStructured.find((item) => /^(NewsArticle|Article|BlogPosting)$/i.test(String(item?.['@type'] || '')));
  if (/\/news|\/article|\/regional|\/national|\/international|\/business|\/sports|\/lifestyle/i.test(page.url)) addBooleanFinding(state, Boolean(articleStructured && articleStructured.headline), { checkCode: 'article_structured_data.basic', category: 'structured_data', pageUrl: page.url, passTitle: 'Article structured data has a headline', failTitle: 'Article structured data is incomplete', currentValue: articleStructured || null, recommendedAction: 'Include NewsArticle/Article JSON-LD with headline and publication metadata.' });
  if (images.length) addBooleanFinding(state, missingAlt === 0, { checkCode: 'image.alt', category: 'accessibility', pageUrl: page.url, passTitle: 'Images include alt text', failTitle: 'Some images are missing alt text', currentValue: { imageCount: images.length, missingAlt }, recommendedAction: 'Add useful alt text to meaningful images.' });
  if ((page.redirectChain || []).some((hop) => hop.location)) addFinding(state, { checkCode: 'redirect.chain', category: 'technical', severity: 'warning', pageUrl: page.requestedUrl, title: 'Redirect chain detected', currentValue: page.redirectChain, recommendedAction: 'Keep redirect chains short and intentional.' });
}

function addDuplicateFindings(state) {
  const byTitle = new Map();
  const byDescription = new Map();
  for (const meta of state.pageMeta) {
    if (meta.title) byTitle.set(meta.title, [...(byTitle.get(meta.title) || []), meta.url]);
    if (meta.description) byDescription.set(meta.description, [...(byDescription.get(meta.description) || []), meta.url]);
  }
  for (const [title, urls] of byTitle.entries()) if (urls.length > 1) addFinding(state, { checkCode: 'title.duplicate', category: 'metadata', severity: 'warning', pageUrl: urls[0], title: 'Duplicate page title detected', currentValue: { title, urls }, recommendedAction: 'Use unique titles for indexed pages.' });
  for (const [description, urls] of byDescription.entries()) if (urls.length > 1) addFinding(state, { checkCode: 'description.duplicate', category: 'metadata', severity: 'warning', pageUrl: urls[0], title: 'Duplicate meta description detected', currentValue: { description, urls }, recommendedAction: 'Use unique descriptions for indexed pages.' });
}

function extractSitemapUrls(xml) {
  const urls = [];
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = locRe.exec(String(xml || '')))) urls.push(decodeHtml(String(match[1] || '').trim()));
  return urls;
}

async function validateSitemapFile(siteUrl, pathOrUrl, options = {}) {
  const fileUrl = pathOrUrl.startsWith('http') ? pathOrUrl : `${siteUrl}${pathOrUrl}`;
  const type = fileUrl.endsWith('/robots.txt') ? 'robots' : (fileUrl.includes('news-sitemap') ? 'news_sitemap' : 'sitemap');
  const checkedAt = new Date();
  const response = await fetchUrl(fileUrl, { accept: 'application/xml,text/xml,text/plain,*/*' });
  const file = { url: fileUrl, type, httpStatus: response.status, available: response.ok, accessible: response.ok, contentType: response.contentType, checkedAt, urlCount: 0, validCount: 0, invalidCount: 0, duplicateCount: 0, errorCount: 0, invalidEntries: [], duplicateEntries: [], nonCanonicalUrls: [], urlsReturningErrors: [], noindexUrlsIncluded: [], lastModified: null, warnings: [], errorMessage: response.error || null };
  if (!response.ok) {
    file.warnings.push(`${fileUrl} returned ${response.status || response.error || 'no response'}`);
    return file;
  }
  if (fileUrl.endsWith('/robots.txt')) return file;
  const urls = extractSitemapUrls(response.text);
  file.urlCount = urls.length;
  if (!urls.length) file.warnings.push('Sitemap contains no URL entries or is malformed.');
  const seen = new Set();
  const base = new URL(siteUrl);
  for (const item of urls) {
    let parsed;
    try { parsed = new URL(item); } catch (_) { file.invalidEntries.push(item); continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) file.invalidEntries.push(item);
    if (parsed.origin !== base.origin) file.nonCanonicalUrls.push(item);
    const normalized = parsed.toString().replace(/\/+$/, '');
    if (seen.has(normalized)) file.duplicateEntries.push(item);
    seen.add(normalized);
  }
  file.invalidCount = file.invalidEntries.length;
  file.duplicateCount = file.duplicateEntries.length;
  file.validCount = Math.max(0, file.urlCount - file.invalidCount);
  const limit = options.urlCheckLimit || getLimit('SEO_SITEMAP_URL_CHECK_LIMIT', DEFAULT_SITEMAP_URL_CHECK_LIMIT, 250);
  for (const url of urls.slice(0, limit)) {
    const page = await fetchUrl(url, { readBody: true, accept: '*/*' });
    if (!page.ok || (page.status && page.status >= 400)) file.urlsReturningErrors.push({ url, status: page.status, error: page.error || null });
    if (/<meta\b(?=[^>]*\bname\s*=\s*["']robots["'])(?=[^>]*\bcontent\s*=\s*["'][^"']*noindex[^"']*["'])[^>]*>/i.test(page.text || '')) file.noindexUrlsIncluded.push(url);
  }
  file.errorCount = file.urlsReturningErrors.length;
  return file;
}

async function checkSitemaps(req = null) {
  const siteUrl = resolveSiteUrl();
  if (!isDbReady()) throw new SeoAuditError('SEO sitemap storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  await logAudit(req || {}, 'SEO_SITEMAP_CHECK_STARTED', null, { module: 'seo', targetType: 'seo_sitemap', targetId: siteUrl });
  const files = [];
  for (const path of ['/sitemap.xml', '/news-sitemap.xml', '/robots.txt']) files.push(await validateSitemapFile(siteUrl, path));
  const warnings = files.flatMap((file) => file.warnings.map((warning) => `${file.url}: ${warning}`));
  const doc = await SeoSitemapCheck.create({ siteUrl, status: 'completed', checkedAt: new Date(), checkedBy: actorId(req), files, warnings, errorMessage: null });
  await logAudit(req || {}, 'SEO_SITEMAP_CHECK_COMPLETED', String(doc._id || doc.id), { module: 'seo', targetType: 'seo_sitemap_check', targetId: String(doc._id || doc.id), newValue: { fileCount: files.length, warningCount: warnings.length } });
  return sitemapDto(doc);
}

async function getLatestSitemapCheck() {
  if (!isDbReady()) throw new SeoAuditError('SEO sitemap storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  return sitemapDto(await SeoSitemapCheck.findOne({}).sort({ checkedAt: -1, createdAt: -1 }).lean()) || emptySitemapDto();
}

function sitemapFileDto(file) {
  return {
    url: file.url,
    type: file.type || (String(file.url || '').endsWith('/robots.txt') ? 'robots' : (String(file.url || '').includes('news-sitemap') ? 'news_sitemap' : 'sitemap')),
    available: Boolean(file.available !== undefined ? file.available : file.accessible),
    httpStatus: file.httpStatus ?? null,
    contentType: file.contentType || null,
    urlCount: Number(file.urlCount || 0),
    validCount: Number(file.validCount ?? Math.max(0, Number(file.urlCount || 0) - Number((file.invalidEntries || []).length))),
    invalidCount: Number(file.invalidCount ?? (file.invalidEntries || []).length),
    duplicateCount: Number(file.duplicateCount ?? (file.duplicateEntries || []).length),
    errorCount: Number(file.errorCount ?? (file.urlsReturningErrors || []).length),
    invalidEntries: file.invalidEntries || [],
    duplicateEntries: file.duplicateEntries || [],
    nonCanonicalUrls: file.nonCanonicalUrls || [],
    urlsReturningErrors: file.urlsReturningErrors || [],
    noindexUrlsIncluded: file.noindexUrlsIncluded || [],
    lastModified: file.lastModified || null,
    warnings: file.warnings || [],
    checkedAt: file.checkedAt ? new Date(file.checkedAt).toISOString() : null,
    errorMessage: file.errorMessage || null,
  };
}

function emptySitemapDto() {
  const siteUrl = resolveSiteUrl();
  return {
    id: null,
    siteUrl,
    status: 'not_checked',
    checkedAt: null,
    checkedBy: null,
    files: ['/sitemap.xml', '/news-sitemap.xml', '/robots.txt'].map((path) => sitemapFileDto({ url: `${siteUrl}${path}`, type: path === '/robots.txt' ? 'robots' : (path === '/news-sitemap.xml' ? 'news_sitemap' : 'sitemap'), available: false, warnings: ['Sitemap check has not been run yet.'] })),
    warnings: ['Sitemap check has not been run yet.'],
    errorMessage: null,
  };
}

function sitemapDto(doc) {
  const item = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (!item) return null;
  return { id: String(item._id || item.id || ''), siteUrl: item.siteUrl, status: item.status, checkedAt: item.checkedAt ? new Date(item.checkedAt).toISOString() : null, checkedBy: item.checkedBy || null, files: (item.files || []).map(sitemapFileDto), warnings: item.warnings || [], errorMessage: item.errorMessage || null };
}

function createAuditState() {
  return { urlsChecked: [], results: [], passedChecks: [], warnings: [], criticalIssues: [], pageMeta: [], internalLinks: [], findingKeys: new Set() };
}

function mergeAuditState(target, source) {
  target.urlsChecked.push(...(source.urlsChecked || []));
  target.pageMeta.push(...(source.pageMeta || []));
  target.internalLinks.push(...(source.internalLinks || []));
  for (const result of source.results || []) addFinding(target, result);
}

async function fetchCachedUrl(context, url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const cacheKey = `${method} ${url}`;
  if (method === 'GET' && context.responseCache.has(cacheKey)) return context.responseCache.get(cacheKey);
  const result = await fetchUrl(url, { ...options, context });
  if (method === 'GET') context.responseCache.set(cacheKey, result);
  return result;
}

async function fetchSitemapCandidates(context) {
  const out = [];
  const files = [];
  for (const path of ['/sitemap.xml', '/news-sitemap.xml']) {
    const url = `${context.siteUrl}${path}`;
    const response = await fetchCachedUrl(context, url, { accept: 'application/xml,text/xml,text/plain,*/*', timeoutMs: context.config.pageTimeoutMs });
    const urls = response.ok ? extractSitemapUrls(response.text) : [];
    files.push({ url, type: path === '/news-sitemap.xml' ? 'news_sitemap' : 'sitemap', response, urls });
    out.push(...urls);
  }
  return { urls: out, files };
}

function prepareAuditUrls(siteUrl, sitemapUrls, config) {
  const seeds = QUICK_SEED_PATHS.map((path) => normalizeAuditUrl(path, siteUrl)).filter(Boolean);
  const normalizedSitemapUrls = sitemapUrls.map((url) => normalizeAuditUrl(url, siteUrl)).filter(Boolean);
  return uniqueOrdered([normalizeAuditUrl(siteUrl, siteUrl), ...seeds, ...normalizedSitemapUrls]).slice(0, config.maxPages);
}

async function expandAuditUrlsFromSeedPages(context, urls) {
  if (urls.length >= context.config.maxPages) return urls;
  const seedUrls = urls.slice(0, Math.min(urls.length, context.config.pageConcurrency));
  const discovered = [];
  await mapWithConcurrency(seedUrls, context.config.pageConcurrency, async (url) => {
    const page = await fetchCachedUrl(context, url, { timeoutMs: context.config.pageTimeoutMs });
    if (canInspectHtml(page)) discovered.push(...extractLinks(page.text, context.siteUrl));
  });
  return uniqueOrdered([...urls, ...discovered.map((url) => normalizeAuditUrl(url, context.siteUrl)).filter(Boolean)]).slice(0, context.config.maxPages);
}

async function updateProgress(progress, patch) {
  if (typeof progress !== 'function') return;
  await progress({ ...patch, lastProgressAt: new Date() });
}

function progressPercent(pagesChecked, totalPages, floor = 0, ceiling = 95) {
  if (!totalPages) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round((pagesChecked / totalPages) * ceiling)));
}

async function scanPages(context, urls, progress) {
  const state = createAuditState();
  let processed = 0;
  const pageResults = await mapWithConcurrency(urls, context.config.pageConcurrency, async (url) => {
    if (Date.now() > context.deadlineAt) {
      const pageState = createAuditState();
      addFinding(pageState, { checkCode: 'audit.overall_timeout', category: 'availability', severity: 'warning', pageUrl: url, title: 'Page skipped because audit timeout was reached', currentValue: { overallTimeoutMs: context.config.overallTimeoutMs }, recommendedAction: 'Run a Full Audit or increase SEO_AUDIT_OVERALL_TIMEOUT_MS for deeper scans.' });
      return pageState;
    }
    const pageState = createAuditState();
    const page = await fetchCachedUrl(context, url, { timeoutMs: context.config.pageTimeoutMs });
    if (/timed out/i.test(String(page.error || ''))) context.metrics.pagesTimedOut.push(url);
    analyzePage(page, context.siteUrl, pageState);
    processed += 1;
    if (processed % context.config.progressBatchSize === 0 || processed === urls.length) {
      await updateProgress(progress, { pagesChecked: processed, progressPercent: progressPercent(processed, urls.length), currentStage: PROGRESS_STAGES.scanningPages, currentUrl: url });
    }
    return pageState;
  });
  context.metrics.pageWorkerMaxConcurrency = pageResults.maxActive;
  for (const pageState of pageResults.results) mergeAuditState(state, pageState);
  return state;
}

async function checkInternalLinks(context, state, progress) {
  const urls = uniqueOrdered((state.internalLinks || []).map((url) => normalizeAuditUrl(url, context.siteUrl)).filter(Boolean)).slice(0, context.config.linkLimit);
  let checked = 0;
  const linkResults = await mapWithConcurrency(urls, context.config.linkConcurrency, async (url) => {
    if (context.linkCache.has(url)) return context.linkCache.get(url);
    let response = await fetchUrl(url, { method: 'HEAD', readBody: false, accept: '*/*', timeoutMs: context.config.pageTimeoutMs, context, retry: true });
    if (response.status === 405 || response.status === 501) response = await fetchCachedUrl(context, url, { method: 'GET', readBody: false, accept: '*/*', timeoutMs: context.config.pageTimeoutMs });
    const item = { url, status: response.status, ok: response.ok, error: response.error || null };
    context.linkCache.set(url, item);
    checked += 1;
    if (checked % context.config.progressBatchSize === 0 || checked === urls.length) await updateProgress(progress, { currentStage: PROGRESS_STAGES.checkingInternalLinks, currentUrl: url });
    return item;
  });
  context.metrics.linkWorkerMaxConcurrency = linkResults.maxActive;
  for (const link of linkResults.results) {
    if (!link || link.ok) continue;
    addFinding(state, { checkCode: 'internal_link.status', category: 'internal_links', severity: 'warning', pageUrl: link.url, title: 'Internal link returned an error', currentValue: { status: link.status, error: link.error }, recommendedAction: 'Fix or remove internal links that do not resolve successfully.' });
  }
  return { checked: urls.length };
}

async function crawlSite(siteUrl, options = {}) {
  const config = auditConfig(options.mode);
  const context = createAuditContext(siteUrl, config);
  const timings = { sitemapMs: 0, urlPreparationMs: 0, pageScanMs: 0, linkCheckMs: 0, scoreCalculationMs: 0, persistenceMs: 0, totalMs: 0 };
  const started = Date.now();
  await updateProgress(options.progress, { currentStage: PROGRESS_STAGES.loadingSitemaps, progressPercent: 0, pagesChecked: 0 });
  const sitemapStart = Date.now();
  const sitemap = await fetchSitemapCandidates(context);
  timings.sitemapMs = Date.now() - sitemapStart;

  await updateProgress(options.progress, { currentStage: PROGRESS_STAGES.preparingUrls, progressPercent: 1 });
  const prepStart = Date.now();
  let urls = prepareAuditUrls(siteUrl, sitemap.urls, config);
  urls = await expandAuditUrlsFromSeedPages(context, urls);
  timings.urlPreparationMs = Date.now() - prepStart;
  await updateProgress(options.progress, { totalPages: urls.length, currentStage: PROGRESS_STAGES.scanningPages, progressPercent: 2 });

  const scanStart = Date.now();
  const state = await scanPages(context, urls, options.progress);
  timings.pageScanMs = Date.now() - scanStart;

  const linkStart = Date.now();
  const linkStats = await checkInternalLinks(context, state, options.progress);
  timings.linkCheckMs = Date.now() - linkStart;

  for (const file of sitemap.files) {
    addFinding(state, { checkCode: `sitemap.available.${file.type}`, category: 'sitemap', severity: file.response.ok ? 'passed' : 'warning', pageUrl: file.url, title: file.response.ok ? `${file.type} is reachable` : `${file.type} is unavailable`, currentValue: { status: file.response.status, urlCount: file.urls.length }, recommendedAction: file.response.ok ? null : 'Make the file available to crawlers.' });
  }

  if (config.mode === 'full') addDuplicateFindings(state);
  delete state.findingKeys;
  timings.totalMs = Date.now() - started;
  return { ...state, totalPages: urls.length, mode: config.mode, timings, requestMetrics: { ...context.metrics, internalLinksChecked: linkStats.checked, responseCacheEntries: context.responseCache.size, linkCacheEntries: context.linkCache.size } };
}

function calculateScore(results) {
  const items = Array.isArray(results) ? results : [];
  const criticalCount = items.filter((item) => item.severity === 'critical').length;
  const warningCount = items.filter((item) => item.severity === 'warning').length;
  const passedCount = items.filter((item) => item.severity === 'passed').length;
  if (!items.length) {
    return { score: null, scoreUnavailableReason: 'No SEO checks were produced for this audit.', scoreBreakdown: {}, passedCount, warningCount, criticalCount, scoreExplanation: null };
  }

  const seenCategories = new Set(items.map((item) => normalizeFindingCategory(item)).filter((category) => SCORE_WEIGHTS[category]));
  const activeWeightTotal = Array.from(seenCategories).reduce((sum, category) => sum + SCORE_WEIGHTS[category], 0) || 100;
  const scoreBreakdown = {};

  for (const category of seenCategories) {
    const categoryItems = items.filter((item) => normalizeFindingCategory(item) === category);
    const passed = categoryItems.filter((item) => item.severity === 'passed').length;
    const warnings = categoryItems.filter((item) => item.severity === 'warning').length;
    const critical = categoryItems.filter((item) => item.severity === 'critical').length;
    const possible = Math.max(categoryItems.length, 1);
    const healthRatio = Math.max(0, (passed + warnings * 0.5) / possible - (critical * 0.5 / possible));
    const normalizedWeight = SCORE_WEIGHTS[category] / activeWeightTotal * 100;
    scoreBreakdown[category] = Math.round(normalizedWeight * Math.min(1, healthRatio));
  }

  const score = Math.max(0, Math.min(100, Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0)));
  return {
    score,
    scoreBreakdown,
    scoreUnavailableReason: null,
    passedCount,
    warningCount,
    criticalCount,
    scoreExplanation: 'Score is calculated from supported audit categories. Each category receives its configured weight, passed checks earn full credit, warnings earn half credit, and critical issues reduce category credit. Performance is reported separately and does not force the SEO score to zero.',
  };
}

async function getPerformanceScores(siteUrl) {
  const key = process.env.GOOGLE_PAGESPEED_API_KEY || process.env.PAGESPEED_API_KEY || '';
  const checkedAt = new Date();
  const out = { desktopScore: null, mobileScore: null, source: 'Google PageSpeed Insights', checkedAt, unavailableReason: null };
  for (const strategy of ['desktop', 'mobile']) {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', siteUrl);
    endpoint.searchParams.set('strategy', strategy);
    endpoint.searchParams.set('category', 'performance');
    if (key) endpoint.searchParams.set('key', key);
    const response = await fetchUrl(endpoint.toString(), { accept: 'application/json', timeoutMs: getLimit('SEO_PAGESPEED_TIMEOUT_MS', PAGESPEED_TIMEOUT_MS, 60000) });
    if (!response.ok) {
      out.unavailableReason = `PageSpeed ${strategy} request failed with ${response.status || response.error || 'no response'}`;
      continue;
    }
    try {
      const json = JSON.parse(response.text);
      const value = json?.lighthouseResult?.categories?.performance?.score;
      const score = normalizePerformanceScore(value);
      if (typeof score === 'number') out[`${strategy}Score`] = score;
      else out.unavailableReason = `PageSpeed ${strategy} response did not include a valid performance score`;
    } catch (_) {
      out.unavailableReason = `PageSpeed ${strategy} response was malformed`;
    }
  }
  if (out.desktopScore === null && out.mobileScore === null && !out.unavailableReason) out.unavailableReason = 'PageSpeed did not return performance scores';
  return out;
}

function normalizePerformanceScore(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const score = numeric <= 1 ? Math.round(numeric * 100) : Math.round(numeric);
  if (score < 0 || score > 100) return null;
  return score;
}

function calculateDurationMs(startedAt, completedAt) {
  const started = startedAt ? new Date(startedAt) : null;
  const completed = completedAt ? new Date(completedAt) : null;
  if (!started || !completed || Number.isNaN(started.getTime()) || Number.isNaN(completed.getTime())) return null;
  if (completed.getTime() < started.getTime()) return null;
  return completed.getTime() - started.getTime();
}

function safeCompletedAt(startedAt) {
  const completed = new Date();
  const started = startedAt ? new Date(startedAt) : null;
  if (started && !Number.isNaN(started.getTime()) && completed.getTime() < started.getTime()) return started;
  return completed;
}

function performanceDto(performance) {
  const item = performance && typeof performance === 'object' ? performance : {};
  return {
    desktopScore: typeof item.desktopScore === 'number' && item.desktopScore >= 0 && item.desktopScore <= 100 ? item.desktopScore : null,
    mobileScore: typeof item.mobileScore === 'number' && item.mobileScore >= 0 && item.mobileScore <= 100 ? item.mobileScore : null,
    source: item.source || null,
    checkedAt: item.checkedAt ? new Date(item.checkedAt).toISOString() : null,
    unavailableReason: item.unavailableReason || null,
  };
}

function shouldRunPerformance(config, options = {}) {
  return false;
}

function emptyPerformance() {
  return { desktopScore: null, mobileScore: null, source: null, checkedAt: null, unavailableReason: 'Performance testing is not configured' };
}

function performanceNotConfiguredDto() {
  return { desktopScore: null, mobileScore: null, source: null, checkedAt: null, unavailableReason: 'Performance testing is not enabled', status: 'not_configured', message: 'Performance testing is not enabled' };
}

function performanceTestDto(item) {
  const doc = item && typeof item.toObject === 'function' ? item.toObject() : item;
  if (!doc) return performanceNotConfiguredDto();
  return {
    id: doc._id || doc.id ? String(doc._id || doc.id) : null,
    siteUrl: doc.siteUrl || DEFAULT_SITE_URL,
    status: doc.status || 'failed',
    desktopScore: typeof doc.desktopScore === 'number' && doc.desktopScore >= 0 && doc.desktopScore <= 100 ? doc.desktopScore : null,
    mobileScore: typeof doc.mobileScore === 'number' && doc.mobileScore >= 0 && doc.mobileScore <= 100 ? doc.mobileScore : null,
    source: doc.source || null,
    checkedAt: doc.checkedAt ? new Date(doc.checkedAt).toISOString() : null,
    unavailableReason: doc.unavailableReason || null,
    message: doc.message || null,
    durationMs: typeof doc.durationMs === 'number' ? doc.durationMs : null,
  };
}

function hasPerformanceProvider() {
  return Boolean(process.env.GOOGLE_PAGESPEED_API_KEY || process.env.PAGESPEED_API_KEY);
}

function resolvePerformanceSiteUrl(value) {
  let siteUrl;
  try {
    siteUrl = normalizeBaseUrl(value || DEFAULT_SITE_URL);
  } catch (_) {
    throw new SeoAuditError('Performance testing is only allowed for https://www.newspulse.co.in', 400, 'INVALID_PERFORMANCE_URL');
  }
  const parsed = new URL(siteUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.newspulse.co.in' || !['', '/'].includes(parsed.pathname)) {
    throw new SeoAuditError('Performance testing is only allowed for https://www.newspulse.co.in', 400, 'INVALID_PERFORMANCE_URL');
  }
  return DEFAULT_SITE_URL;
}

async function runSeoPerformanceTest(req) {
  const siteUrl = resolvePerformanceSiteUrl(req.body?.url || req.body?.siteUrl || DEFAULT_SITE_URL);
  if (!hasPerformanceProvider()) return performanceNotConfiguredDto();
  if (!isDbReady()) throw new SeoAuditError('SEO performance storage is unavailable. Please check the database connection.', 503, 'SEO_PERFORMANCE_STORAGE_UNAVAILABLE');
  const startedAt = Date.now();
  const performance = await getPerformanceScores(siteUrl);
  const durationMs = Date.now() - startedAt;
  const status = performance.desktopScore === null && performance.mobileScore === null ? 'failed' : 'completed';
  const message = status === 'completed' ? 'Performance testing completed' : (performance.unavailableReason || 'Performance testing failed');
  const doc = await SeoPerformanceTest.create({ siteUrl, status, desktopScore: performance.desktopScore, mobileScore: performance.mobileScore, source: performance.source, checkedAt: performance.checkedAt || new Date(), unavailableReason: performance.unavailableReason || null, message, durationMs, createdBy: actorId(req) });
  await logAudit(req, 'SEO_PERFORMANCE_TEST_COMPLETED', String(doc._id || doc.id), { module: 'seo', targetType: 'seo_performance_test', targetId: String(doc._id || doc.id), newValue: { status, desktopScore: performance.desktopScore, mobileScore: performance.mobileScore } });
  return performanceTestDto(doc);
}

async function getLatestSeoPerformanceTest() {
  if (!hasPerformanceProvider()) return performanceNotConfiguredDto();
  if (!isDbReady()) throw new SeoAuditError('SEO performance storage is unavailable. Please check the database connection.', 503, 'SEO_PERFORMANCE_STORAGE_UNAVAILABLE');
  const latest = await SeoPerformanceTest.findOne({}).sort({ checkedAt: -1, createdAt: -1 }).lean();
  return latest ? performanceTestDto(latest) : { ...performanceNotConfiguredDto(), status: 'not_run', message: 'Performance test has not been run yet' };
}

async function executeAudit(siteUrl, options = {}) {
  const config = auditConfig(options.mode);
  const state = await crawlSite(siteUrl, { ...options, mode: config.mode });
  await updateProgress(options.progress, { currentStage: PROGRESS_STAGES.calculatingScore, progressPercent: 96 });
  const scoreStart = Date.now();
  const scoring = calculateScore(state.results);
  state.timings.scoreCalculationMs = Date.now() - scoreStart;
  state.timings.totalMs += state.timings.scoreCalculationMs;
  const performance = shouldRunPerformance(config, options) ? await getPerformanceScores(siteUrl) : emptyPerformance();
  return { ...state, ...scoring, mode: config.mode, pagesChecked: new Set(state.urlsChecked.map((item) => item.url)).size, performance, errorMessage: null };
}

function auditDto(audit) {
  const doc = audit && typeof audit.toObject === 'function' ? audit.toObject() : audit;
  if (!doc) return null;
  const durationMs = typeof doc.durationMs === 'number' && doc.durationMs >= 0 ? doc.durationMs : calculateDurationMs(doc.startedAt, doc.completedAt);
  const startedAtMs = doc.startedAt ? new Date(doc.startedAt).getTime() : null;
  const elapsedMs = durationMs ?? (startedAtMs && !Number.isNaN(startedAtMs) ? Date.now() - startedAtMs : null);
  return {
    id: String(doc._id || doc.id || ''), siteUrl: doc.siteUrl || null, status: doc.status || 'queued', score: typeof doc.score === 'number' ? doc.score : null,
    mode: normalizeAuditMode(doc.mode), totalPages: doc.totalPages || 0, pagesChecked: doc.pagesChecked || 0, progressPercent: Number(doc.progressPercent || 0), currentStage: doc.currentStage || null, currentUrl: doc.currentUrl || null,
    passedCount: doc.passedCount || 0, warningCount: doc.warningCount || 0, criticalCount: doc.criticalCount || 0,
    startedAt: doc.startedAt ? new Date(doc.startedAt).toISOString() : null, completedAt: doc.completedAt ? new Date(doc.completedAt).toISOString() : null,
    lastProgressAt: doc.lastProgressAt ? new Date(doc.lastProgressAt).toISOString() : null, elapsedMs, durationMs,
    createdBy: doc.createdBy || doc.requestedBy?.id || null, performance: performanceDto(doc.performance),
    timings: doc.timings || {}, requestMetrics: doc.requestMetrics || {},
    scoreBreakdown: doc.scoreBreakdown || {}, scoreExplanation: doc.scoreExplanation || null, scoreUnavailableReason: doc.scoreUnavailableReason || null,
    results: Array.isArray(doc.results) ? doc.results.map((item) => ({ ...item, category: normalizeFindingCategory(item) })) : [], urlsChecked: Array.isArray(doc.urlsChecked) ? doc.urlsChecked : [],
    passedChecks: Array.isArray(doc.passedChecks) ? doc.passedChecks : [], warnings: Array.isArray(doc.warnings) ? doc.warnings : [], criticalIssues: Array.isArray(doc.criticalIssues) ? doc.criticalIssues : [],
    errorMessage: doc.errorMessage || null, createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null, updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

function roleLabel(role) {
  const value = String(role || '').trim();
  if (!value) return null;
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

async function resolveStartedBy(doc) {
  const rawId = doc?.createdBy || doc?.requestedBy?.id || null;
  const fallback = { id: rawId ? String(rawId) : null, name: 'Former or unavailable staff account', staffId: null, role: null };
  if (!rawId) return fallback;
  if (isDbReady() && mongoose.isValidObjectId(String(rawId))) {
    try {
      const query = User.findById(String(rawId));
      const user = typeof query?.select === 'function'
        ? await query.select('fullName name staffId role roleName')
        : await query;
      if (user) {
        return {
          id: String(user._id || rawId),
          name: user.fullName || user.name || 'Former or unavailable staff account',
          staffId: user.staffId || null,
          role: roleLabel(user.roleName || user.role),
        };
      }
    } catch (_) {}
  }
  if (doc?.requestedBy?.name || doc?.requestedBy?.staffId || doc?.requestedBy?.role) {
    return { id: String(rawId), name: doc.requestedBy.name || fallback.name, staffId: doc.requestedBy.staffId || null, role: roleLabel(doc.requestedBy.role) };
  }
  return fallback;
}

async function hydrateAuditDto(audit) {
  const doc = audit && typeof audit.toObject === 'function' ? audit.toObject() : audit;
  const dto = auditDto(doc);
  if (!dto) return null;
  dto.startedBy = await resolveStartedBy(doc);
  dto.requestedBy = dto.startedBy;
  dto.categories = categoryList(dto.results);
  return dto;
}

async function runSeoAudit(auditId, req = null) {
  await SeoAudit.findByIdAndUpdate(auditId, { $set: { status: 'running', errorMessage: null, currentStage: PROGRESS_STAGES.loadingSitemaps, progressPercent: 0, lastProgressAt: new Date() } }, { new: true });
  const current = await SeoAudit.findById(auditId).lean();
  if (!current) throw new SeoAuditError('SEO audit record was not found.', 404, 'AUDIT_NOT_FOUND');
  try {
    const progress = (patch) => SeoAudit.findByIdAndUpdate(auditId, { $set: patch }, { new: false });
    const result = await executeAudit(current.siteUrl, { mode: current.mode || 'quick', includePerformance: current.includePerformance === true, progress });
    if (typeof result.score !== 'number') throw new SeoAuditError(result.scoreUnavailableReason || 'SEO score could not be calculated.', 500, 'SEO_SCORE_UNAVAILABLE');
    const completedAt = safeCompletedAt(current.startedAt);
    const durationMs = calculateDurationMs(current.startedAt, completedAt);
    const persistenceStart = Date.now();
    const timings = { ...(result.timings || {}), persistenceMs: 0 };
    let completed = await SeoAudit.findByIdAndUpdate(auditId, { $set: { ...result, timings, status: 'completed', currentStage: PROGRESS_STAGES.completed, currentUrl: null, progressPercent: 100, completedAt, durationMs, lastProgressAt: completedAt } }, { new: true });
    timings.persistenceMs = Date.now() - persistenceStart;
    timings.totalMs = (timings.totalMs || 0) + timings.persistenceMs;
    completed = await SeoAudit.findByIdAndUpdate(auditId, { $set: { timings } }, { new: true });
    await logAudit(req || {}, 'SEO_AUDIT_COMPLETED', String(auditId), { module: 'seo', targetType: 'seo_audit', targetId: String(auditId), newValue: { score: result.score, pagesChecked: result.pagesChecked, warningCount: result.warningCount, criticalCount: result.criticalCount } });
    return completed;
  } catch (error) {
    const completedAt = safeCompletedAt(current.startedAt);
    const durationMs = calculateDurationMs(current.startedAt, completedAt);
    const failed = await SeoAudit.findByIdAndUpdate(auditId, { $set: { status: 'failed', currentStage: PROGRESS_STAGES.completed, completedAt, durationMs, lastProgressAt: completedAt, errorMessage: error?.message || String(error), score: null } }, { new: true });
    await logAudit(req || {}, 'SEO_AUDIT_FAILED', String(auditId), { module: 'seo', targetType: 'seo_audit', targetId: String(auditId), result: 'failed', severity: 'warning', reason: error?.message || String(error) });
    return failed;
  }
}

async function startSeoAudit(req, options = {}) {
  const siteUrl = resolveSiteUrl();
  const mode = normalizeAuditMode(req.body?.mode || options.mode);
  const includePerformance = req.body?.includePerformance === true || req.body?.performance === true || req.body?.runPerformance === true;
  if (!isDbReady()) throw new SeoAuditError('SEO audit storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  const active = await SeoAudit.findOne({ status: { $in: ['queued', 'running'] } }).sort({ startedAt: -1 }).lean();
  if (active) {
    const error = new SeoAuditError('An SEO audit is already running', 409, 'SEO_AUDIT_ALREADY_RUNNING');
    error.activeAuditId = String(active._id || active.id || '');
    throw error;
  }
  const audit = await SeoAudit.create({
    siteUrl, status: 'queued', mode, includePerformance, totalPages: 0, pagesChecked: 0, progressPercent: 0, currentStage: PROGRESS_STAGES.loadingSitemaps, lastProgressAt: new Date(), startedAt: new Date(), createdBy: actorId(req),
    requestedBy: { id: actorId(req), email: req.user?.email || null, name: req.user?.name || req.user?.fullName || null, role: req.user?.role || null, staffId: req.user?.staffId || null },
    performance: emptyPerformance(),
  });
  await logAudit(req, 'SEO_AUDIT_STARTED', String(audit._id || audit.id), { module: 'seo', targetType: 'seo_audit', targetId: String(audit._id || audit.id), newValue: { siteUrl, mode } });
  const runner = runSeoAudit(audit._id || audit.id, req);
  if (options.runInline) return hydrateAuditDto(await runner);
  runner.catch((error) => { if (String(process.env.NODE_ENV || '').toLowerCase() !== 'test') console.warn('[seo-audit] background audit failed', error?.message || error); });
  return hydrateAuditDto(audit);
}

async function listSeoAudits(limitValue, pageValue) {
  if (!isDbReady()) throw new SeoAuditError('SEO audit storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  const limit = Math.min(Math.max(parseInt(limitValue || '20', 10) || 20, 1), 100);
  const page = Math.max(parseInt(pageValue || '1', 10) || 1, 1);
  const query = SeoAudit.find({}).sort({ startedAt: -1, createdAt: -1 });
  const items = await query.skip((page - 1) * limit).limit(limit).lean();
  return { page, limit, items: await Promise.all(items.map(hydrateAuditDto)) };
}

async function getLatestSeoAudit() {
  if (!isDbReady()) throw new SeoAuditError('SEO audit storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  return hydrateAuditDto(await SeoAudit.findOne({}).sort({ startedAt: -1, createdAt: -1 }).lean());
}

async function getSeoAudit(id) {
  if (!isDbReady()) throw new SeoAuditError('SEO audit storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  if (!id || !mongoose.isValidObjectId(String(id))) throw new SeoAuditError('Valid SEO audit ID is required.', 400, 'INVALID_SEO_AUDIT_ID');
  const audit = await SeoAudit.findById(id).lean();
  if (!audit) throw new SeoAuditError('SEO audit was not found.', 404, 'SEO_AUDIT_NOT_FOUND');
  return hydrateAuditDto(audit);
}

function publicArticleUrl(siteUrl, article) {
  const slug = String(article?.slug || article?.slugs?.[article?.language || 'en'] || '').replace(/^\/+/, '');
  return slug ? `${siteUrl}/${slug}` : siteUrl;
}

function analyzeArticleMeta(article, siteUrl, duplicates) {
  const seo = article?.seo || {};
  const title = seo.metaTitle || article?.title || '';
  const description = seo.metaDescription || article?.summary || '';
  const publicUrl = publicArticleUrl(siteUrl, article);
  const issues = [];
  const addIssue = (severity, code, message) => issues.push({ severity, code, message });
  if (!title) addIssue('critical', 'missing_title', 'Missing SEO title');
  else if (title.length < 30 || title.length > 65) addIssue('warning', 'title_length', 'SEO title length is outside 30-65 characters');
  if (!description) addIssue('critical', 'missing_description', 'Missing meta description');
  else if (description.length < 70 || description.length > 160) addIssue('warning', 'description_length', 'Meta description length is outside 70-160 characters');
  if (title && duplicates.titles.get(title) > 1) addIssue('warning', 'duplicate_title', 'Duplicate SEO title');
  if (description && duplicates.descriptions.get(description) > 1) addIssue('warning', 'duplicate_description', 'Duplicate meta description');
  let canonicalOk = false;
  try { canonicalOk = Boolean(seo.canonicalUrl) && new URL(seo.canonicalUrl).toString().replace(/\/+$/, '') === publicUrl.replace(/\/+$/, ''); } catch (_) {}
  if (!seo.canonicalUrl) addIssue('warning', 'missing_canonical', 'Missing canonical URL');
  else if (!canonicalOk) addIssue('warning', 'canonical_mismatch', 'Canonical URL does not match public URL');
  if (!(article?.coverImage?.url || article?.coverImageUrl || article?.imageURL)) addIssue('warning', 'missing_og_image', 'Missing image for social metadata');
  if (article?.coverImage?.url && !article?.coverImage?.alt) addIssue('warning', 'missing_image_alt', 'Cover image is missing alt text');
  const seoStatus = issues.some((issue) => issue.severity === 'critical') ? 'critical' : (issues.some((issue) => issue.severity === 'warning') ? 'warning' : 'good');
  const recommendations = issues.map((issue) => issue.message);
  return {
    articleId: String(article?._id || article?.id || ''),
    title: article?.title || null,
    slug: article?.slug || null,
    publicUrl,
    language: article?.language || 'en',
    publicationStatus: article?.status || null,
    seoTitle: seo.metaTitle || null,
    seoTitleLength: seo.metaTitle ? String(seo.metaTitle).length : 0,
    metaDescription: seo.metaDescription || null,
    descriptionLength: seo.metaDescription ? String(seo.metaDescription).length : 0,
    canonicalUrl: seo.canonicalUrl || null,
    robots: null,
    openGraphTitle: title || null,
    openGraphDescription: description || null,
    openGraphImage: article?.coverImage?.url || article?.coverImageUrl || article?.imageURL || null,
    twitterMetadata: { title: title || null, description: description || null, image: article?.coverImage?.url || article?.coverImageUrl || article?.imageURL || null },
    structuredDataStatus: 'derived_from_article',
    imageAltStatus: article?.coverImage?.url ? (article?.coverImage?.alt ? 'present' : 'missing') : 'no_image',
    seoStatus,
    detectedIssues: issues,
    issueList: issues,
    recommendations,
  };
}

async function analyzeMetaTags(query = {}) {
  if (!isDbReady()) throw new SeoAuditError('Article storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  const siteUrl = resolveSiteUrl();
  const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const filter = {};
  if (query.language) filter.language = String(query.language);
  if (query.status || query.publicationStatus) filter.status = String(query.status || query.publicationStatus);
  if (query.articleId && mongoose.isValidObjectId(String(query.articleId))) filter._id = query.articleId;
  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ title: regex }, { slug: regex }];
  }
  const allForDupes = await Article.find(filter).sort({ publishedAt: -1, createdAt: -1 }).limit(500).lean();
  const titles = new Map();
  const descriptions = new Map();
  for (const item of allForDupes) {
    const title = item?.seo?.metaTitle || item?.title || '';
    const description = item?.seo?.metaDescription || item?.summary || '';
    if (title) titles.set(title, (titles.get(title) || 0) + 1);
    if (description) descriptions.set(description, (descriptions.get(description) || 0) + 1);
  }
  const allItems = allForDupes.map((article) => analyzeArticleMeta(article, siteUrl, { titles, descriptions }));
  const severity = query.severity || query.issueSeverity;
  const seoStatus = query.seoStatus ? String(query.seoStatus) : null;
  const filteredBySeverity = severity ? allItems.filter((item) => item.detectedIssues.some((issue) => issue.severity === severity)) : allItems;
  const filtered = seoStatus ? filteredBySeverity.filter((item) => item.seoStatus === seoStatus) : filteredBySeverity;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const items = filtered.slice((page - 1) * limit, page * limit);
  return {
    page,
    limit,
    total,
    totalPages,
    items,
    pagination: { page, limit, total, totalPages },
    availableFilters: {
      languages: Article.LANGUAGE_VALUES || ['en', 'hi', 'gu'],
      publicationStatuses: Article.STATUS_VALUES || ['draft', 'scheduled', 'published', 'archived', 'deleted'],
      seoStatuses: ['good', 'warning', 'critical', 'not_analyzed'],
    },
  };
}

async function getMetaTagDetails(articleId) {
  if (!articleId || !mongoose.isValidObjectId(String(articleId))) throw new SeoAuditError('Valid article ID is required.', 400, 'INVALID_ARTICLE_ID');
  const data = await analyzeMetaTags({ articleId, limit: 1, page: 1 });
  const article = data.items[0] || null;
  if (!article) throw new SeoAuditError('Article was not found.', 404, 'ARTICLE_NOT_FOUND');
  return article;
}

function normalizeSourcePath(value) {
  let source = String(value || '').trim();
  if (/^https?:\/\//i.test(source)) throw new SeoAuditError('Redirect source path must not contain a full domain.', 400, 'INVALID_REDIRECT_SOURCE');
  if (!source.startsWith('/')) throw new SeoAuditError('Redirect source path must begin with /.', 400, 'INVALID_REDIRECT_SOURCE');
  source = source.replace(/\/+/g, '/');
  if (source.length > 1) source = source.replace(/\/+$/, '');
  if (PROTECTED_REDIRECT_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}/`))) throw new SeoAuditError('Redirect source path is protected.', 400, 'PROTECTED_REDIRECT_SOURCE');
  return source;
}

function normalizeDestination(value, siteUrl) {
  const raw = String(value || '').trim();
  if (!raw || /^(javascript:|data:)/i.test(raw)) throw new SeoAuditError('Redirect destination URL is unsafe.', 400, 'INVALID_REDIRECT_DESTINATION');
  let parsed;
  try { parsed = raw.startsWith('/') ? new URL(raw, siteUrl) : new URL(raw); } catch (_) { throw new SeoAuditError('Redirect destination URL is invalid.', 400, 'INVALID_REDIRECT_DESTINATION'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new SeoAuditError('Redirect destination URL must use http or https.', 400, 'INVALID_REDIRECT_DESTINATION');
  if (!process.env.SEO_ALLOW_EXTERNAL_REDIRECTS && parsed.origin !== new URL(siteUrl).origin) throw new SeoAuditError('External redirects are not enabled by Founder policy.', 400, 'EXTERNAL_REDIRECT_BLOCKED');
  return parsed.toString();
}

function redirectDto(doc) {
  const item = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (!item) return null;
  return { id: String(item._id || item.id || ''), sourcePath: item.sourcePath, destinationUrl: item.destinationUrl, statusCode: item.statusCode, isActive: item.isActive !== false, reason: item.reason || null, createdBy: item.createdBy || null, updatedBy: item.updatedBy || null, createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null, updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null };
}

async function createRedirect(req) {
  if (!isDbReady()) throw new SeoAuditError('Redirect storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  const siteUrl = resolveSiteUrl();
  const sourcePath = normalizeSourcePath(req.body?.sourcePath);
  const destinationUrl = normalizeDestination(req.body?.destinationUrl, siteUrl);
  const statusCode = req.body?.statusCode === undefined ? 301 : Number(req.body.statusCode);
  if (![301, 302].includes(statusCode)) throw new SeoAuditError('Redirect statusCode must be 301 or 302.', 400, 'INVALID_REDIRECT_STATUS');
  if (new URL(destinationUrl).pathname.replace(/\/+$/, '') === sourcePath.replace(/\/+$/, '')) throw new SeoAuditError('Redirect source and destination cannot be identical.', 400, 'REDIRECT_LOOP_DETECTED');
  const existing = await SeoRedirect.findOne({ sourcePath, isActive: true }).lean();
  if (existing) throw new SeoAuditError('An active redirect already exists for this source path.', 409, 'DUPLICATE_REDIRECT_SOURCE');
  const doc = await SeoRedirect.create({ sourcePath, destinationUrl, statusCode, isActive: req.body?.isActive !== false, createdBy: actorId(req), updatedBy: actorId(req), reason: String(req.body?.reason || '').slice(0, 500) || null });
  await logAudit(req, 'SEO_REDIRECT_CREATED', String(doc._id || doc.id), { module: 'seo', targetType: 'seo_redirect', targetId: String(doc._id || doc.id), newValue: redirectDto(doc) });
  return redirectDto(doc);
}

async function listRedirects(query = {}) {
  if (!isDbReady()) throw new SeoAuditError('Redirect storage is unavailable. Please check the database connection.', 503, 'SEO_STORAGE_UNAVAILABLE');
  const filter = {};
  if (query.active === 'true') filter.isActive = true;
  if (query.active === 'false') filter.isActive = false;
  const limit = Math.min(Math.max(parseInt(query.limit || '50', 10) || 50, 1), 200);
  const items = await SeoRedirect.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean();
  return { limit, items: items.map(redirectDto) };
}

async function updateRedirect(req) {
  const current = await SeoRedirect.findById(req.params.id).lean();
  if (!current) throw new SeoAuditError('Redirect was not found.', 404, 'REDIRECT_NOT_FOUND');
  const siteUrl = resolveSiteUrl();
  const patch = { updatedBy: actorId(req) };
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sourcePath')) patch.sourcePath = normalizeSourcePath(req.body.sourcePath);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'destinationUrl')) patch.destinationUrl = normalizeDestination(req.body.destinationUrl, siteUrl);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'statusCode')) {
    patch.statusCode = Number(req.body.statusCode);
    if (![301, 302].includes(patch.statusCode)) throw new SeoAuditError('Redirect statusCode must be 301 or 302.', 400, 'INVALID_REDIRECT_STATUS');
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isActive')) patch.isActive = Boolean(req.body.isActive);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'reason')) patch.reason = String(req.body.reason || '').slice(0, 500) || null;
  const sourcePath = patch.sourcePath || current.sourcePath;
  const destinationUrl = patch.destinationUrl || current.destinationUrl;
  if (new URL(destinationUrl).pathname.replace(/\/+$/, '') === sourcePath.replace(/\/+$/, '')) throw new SeoAuditError('Redirect source and destination cannot be identical.', 400, 'REDIRECT_LOOP_DETECTED');
  const updated = await SeoRedirect.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
  await logAudit(req, patch.isActive === false ? 'SEO_REDIRECT_DISABLED' : (patch.isActive === true ? 'SEO_REDIRECT_ENABLED' : 'SEO_REDIRECT_UPDATED'), String(req.params.id), { module: 'seo', targetType: 'seo_redirect', targetId: String(req.params.id), oldValue: redirectDto(current), newValue: redirectDto(updated) });
  return redirectDto(updated);
}

async function deleteRedirect(req) {
  const current = await SeoRedirect.findById(req.params.id).lean();
  if (!current) throw new SeoAuditError('Redirect was not found.', 404, 'REDIRECT_NOT_FOUND');
  await SeoRedirect.deleteOne({ _id: req.params.id });
  await logAudit(req, 'SEO_REDIRECT_DELETED', String(req.params.id), { module: 'seo', targetType: 'seo_redirect', targetId: String(req.params.id), oldValue: redirectDto(current) });
  return { deleted: true };
}

async function resolveRedirect(pathValue) {
  let sourcePath;
  try {
    sourcePath = normalizeSourcePath(pathValue);
  } catch (_) {
    return { matched: false };
  }
  const doc = await SeoRedirect.findOne({ sourcePath, isActive: true }).lean();
  if (!doc) return { matched: false };
  const dto = redirectDto(doc);
  return { matched: true, destination: dto.destinationUrl, statusCode: dto.statusCode };
}

module.exports = { SeoAuditError, auditDto, analyzeMetaTags, checkSitemaps, createRedirect, deleteRedirect, executeAudit, getLatestSeoAudit, getLatestSeoPerformanceTest, getLatestSitemapCheck, getMetaTagDetails, getSeoAudit, listRedirects, listSeoAudits, resolveRedirect, resolveSiteUrl, runSeoAudit, runSeoPerformanceTest, startSeoAudit, updateRedirect };