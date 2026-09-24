const { randomUUID } = require('node:crypto');

const DEFAULT_SLOW_OPERATION_MS = 1000;

function nowMs() {
  if (typeof process.hrtime.bigint === 'function') {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

function getThresholdMs(value) {
  if (value === 0) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOW_OPERATION_MS;
}

function getRouteLabel(req) {
  const baseUrl = String(req?.baseUrl || '');
  const routePath = req?.route && req.route.path !== undefined ? req.route.path : null;
  if (routePath !== null && routePath !== undefined) {
    const path = Array.isArray(routePath) ? routePath[0] : routePath;
    const label = `${baseUrl}${String(path || '')}`;
    return label || '/';
  }

  const original = String(req?.originalUrl || req?.url || '').split('?')[0];
  return original || '/';
}

function getRequestTimingState(req) {
  if (!req || typeof req !== 'object') return null;
  if (!req.__npTimingDiagnostics) {
    Object.defineProperty(req, '__npTimingDiagnostics', {
      value: { requestId: randomUUID(), cache: null, cacheContext: null },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return req.__npTimingDiagnostics;
}

function setRequestTimingCacheStatus(req, cache) {
  const state = getRequestTimingState(req);
  if (!state) return null;
  state.cache = cache ? String(cache) : null;
  return state.cache;
}

function copyRequestTimingIdentity(source, target) {
  const sourceState = getRequestTimingState(source);
  const targetState = getRequestTimingState(target);
  if (sourceState && targetState) targetState.requestId = sourceState.requestId;
}

function getRequestTimingCacheStatus(req) {
  return getRequestTimingState(req)?.cache || null;
}

function sanitizeDiagnosticString(value, { maxLength = 120, pattern = /^[a-zA-Z0-9:_-]+$/ } = {}) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) return null;
  if (!pattern.test(text)) return null;
  return text;
}

function sanitizeCacheContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;

  const cacheFamily = sanitizeDiagnosticString(context.cacheFamily, { maxLength: 40 });
  const cacheKey = sanitizeDiagnosticString(context.cacheKey, { maxLength: 200 });
  const language = sanitizeDiagnosticString(context.language, { maxLength: 12, pattern: /^[a-zA-Z0-9_-]+$/ });
  const category = sanitizeDiagnosticString(context.category, { maxLength: 80 });
  const pageRaw = Number(context.page);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : null;

  const safe = {};
  if (cacheFamily === 'latest' || cacheFamily === 'category') safe.cacheFamily = cacheFamily;
  if (cacheKey) safe.cacheKey = cacheKey;
  if (language) safe.language = language;
  if (category) safe.category = category;
  if (page !== null) safe.page = page;

  return Object.keys(safe).length ? safe : null;
}

function setRequestTimingCacheContext(req, context) {
  const state = getRequestTimingState(req);
  if (!state) return null;
  state.cacheContext = sanitizeCacheContext(context);
  return state.cacheContext;
}

function getRequestTimingCacheContext(req) {
  return getRequestTimingState(req)?.cacheContext || null;
}

function buildTimingPayload({ req, res, durationMs, cache, resultCount, countResult }) {
  const resolvedCache = cache !== undefined ? cache : getRequestTimingCacheStatus(req);
  const cacheContext = getRequestTimingCacheContext(req);
  const payload = {
    method: String(req?.method || '').toUpperCase() || 'UNKNOWN',
    route: getRouteLabel(req),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    statusCode: typeof res?.statusCode === 'number' ? res.statusCode : 0,
  };

  const requestId = getRequestTimingState(req)?.requestId;
  if (requestId) payload.requestId = requestId;
  if (resolvedCache) payload.cache = String(resolvedCache);
  if (cacheContext) Object.assign(payload, cacheContext);
  if (Number.isInteger(Number(resultCount)) && Number(resultCount) >= 0) {
    payload.resultCount = Number(resultCount);
  }
  if (Number.isInteger(Number(countResult)) && Number(countResult) >= 0) {
    payload.countResult = Number(countResult);
  }
  return payload;
}

function logSlowTiming(label, context = {}) {
  const thresholdMs = getThresholdMs(context.thresholdMs);
  const durationMs = Number(context.durationMs) || 0;
  if (durationMs < thresholdMs) return false;

  const logger = context.logger || console;
  const safeLabel = String(label || 'operation').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'operation';
  const payload = buildTimingPayload(context);
  try {
    logger.log(`[perf][${safeLabel}]`, payload);
    return true;
  } catch (_) {
    return false;
  }
}

async function timeAsync(label, context, fn) {
  const start = nowMs();
  let resultMetadata = null;
  try {
    const result = await fn();
    if (context && typeof context.getResultMetadata === 'function') {
      resultMetadata = context.getResultMetadata(result) || null;
    }
    return result;
  } finally {
    logSlowTiming(label, {
      ...(context || {}),
      ...(resultMetadata || {}),
      durationMs: nowMs() - start,
    });
  }
}

function createRequestTimingMiddleware(options = {}) {
  const thresholdMs = getThresholdMs(options.thresholdMs);
  const logger = options.logger || console;

  return function requestTimingMiddleware(req, res, next) {
    getRequestTimingState(req);
    const start = nowMs();
    let logged = false;

    const finish = () => {
      if (logged) return;
      logged = true;
      logSlowTiming('http.request', {
        req,
        res,
        durationMs: nowMs() - start,
        thresholdMs,
        logger,
      });
    };

    res.once('finish', finish);
    res.once('close', finish);
    return next();
  };
}

module.exports = {
  DEFAULT_SLOW_OPERATION_MS,
  nowMs,
  getRouteLabel,
  getRequestTimingState,
  copyRequestTimingIdentity,
  setRequestTimingCacheStatus,
  getRequestTimingCacheStatus,
  setRequestTimingCacheContext,
  getRequestTimingCacheContext,
  buildTimingPayload,
  logSlowTiming,
  timeAsync,
  createRequestTimingMiddleware,
};