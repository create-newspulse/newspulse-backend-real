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
      value: { cache: null },
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

function getRequestTimingCacheStatus(req) {
  return getRequestTimingState(req)?.cache || null;
}

function buildTimingPayload({ req, res, durationMs, cache }) {
  const resolvedCache = cache !== undefined ? cache : getRequestTimingCacheStatus(req);
  const payload = {
    method: String(req?.method || '').toUpperCase() || 'UNKNOWN',
    route: getRouteLabel(req),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    statusCode: typeof res?.statusCode === 'number' ? res.statusCode : 0,
  };

  if (resolvedCache) payload.cache = String(resolvedCache);
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
  try {
    return await fn();
  } finally {
    logSlowTiming(label, {
      ...(context || {}),
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
  setRequestTimingCacheStatus,
  getRequestTimingCacheStatus,
  buildTimingPayload,
  logSlowTiming,
  timeAsync,
  createRequestTimingMiddleware,
};