const { normalizeSlot } = require('./ads');
const { getCanonicalPublicCategoryKey } = require('./categories');
const { getRedisClient, isRedisReady: isRedisConnectionReady } = require('./redis');
const {
  copyRequestTimingIdentity,
  getRequestTimingCacheContext,
  logSlowTiming,
  nowMs,
  setRequestTimingCacheContext,
  setRequestTimingCacheStatus,
} = require('./timingDiagnostics');

const CACHE_PREFIX = 'np:v1';
const DEFAULT_LOCK_TTL_SECONDS = 15;
const DEFAULT_STALE_WINDOW_MULTIPLIER = 1;
const DEFAULT_COLD_CACHE_WAIT_MS = 600;
const LOCK_RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const rebuildLimiters = new Map();

function isRedisReady() {
  return isRedisConnectionReady();
}

function normalizeCacheLang(value, fallback = 'en') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  const primary = raw.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;
  return fallback;
}

function normalizeCategorySlugForCache(value) {
  const canonical = getCanonicalPublicCategoryKey(value);
  if (canonical) return canonical;
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function normalizePageForCache(value) {
  const page = parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function buildPublicSettingsCacheKey() {
  return `${CACHE_PREFIX}:public-settings`;
}

function buildHomeCacheKey(lang) {
  return `${CACHE_PREFIX}:home:${normalizeCacheLang(lang)}`;
}

function buildLatestCacheKey(lang) {
  return `${CACHE_PREFIX}:latest:${normalizeCacheLang(lang)}`;
}

function buildTrendingCacheKey(lang) {
  return `${CACHE_PREFIX}:trending:${normalizeCacheLang(lang)}`;
}

function buildCategoryCacheKey(slug, lang, page) {
  return `${CACHE_PREFIX}:category:${normalizeCategorySlugForCache(slug)}:${normalizeCacheLang(lang)}:page:${normalizePageForCache(page)}`;
}

function buildAdsCacheKey(slot) {
  const normalizedSlot = normalizeSlot(slot);
  if (!normalizedSlot) return null;
  return `${CACHE_PREFIX}:ads:${normalizedSlot}`;
}

function buildBroadcastCacheKey(lang) {
  return `${CACHE_PREFIX}:broadcast:${normalizeCacheLang(lang)}`;
}

function buildArticleCacheKey(lang, slugOrId) {
  const key = String(slugOrId || '').trim();
  if (!key) return null;
  return `${CACHE_PREFIX}:article:${normalizeCacheLang(lang)}:${key}`;
}

function buildStaleCacheKey(key) {
  const normalizedKey = String(key || '').trim();
  return normalizedKey ? `${normalizedKey}:stale` : null;
}

function buildCacheLockKey(key) {
  const normalizedKey = String(key || '').trim();
  return normalizedKey ? `${normalizedKey}:lock` : null;
}

function getJitteredTtlSeconds(ttlSeconds, random = Math.random) {
  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 0));
  const jitter = Math.floor(ttl * 0.1 * Math.max(0, Math.min(1, Number(random()) || 0)));
  return ttl + jitter;
}

function stableHashString(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function getDeterministicSpreadTtlSeconds(ttlSeconds, key, spreadSeconds = 0) {
  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 0));
  const spread = Math.max(0, Math.floor(Number(spreadSeconds) || 0));
  if (!spread) return ttl;
  return ttl + (stableHashString(key) % (spread + 1));
}

function getStaleTtlSeconds(freshTtlSeconds, staleWindowSeconds) {
  const freshTtl = Math.max(1, Math.floor(Number(freshTtlSeconds) || 0));
  const window = Math.max(1, Math.floor(Number(staleWindowSeconds) || 0));
  return freshTtl + window;
}

function cacheLifecycleError(code) {
  return Object.assign(new Error(code), { code });
}

function withCacheDeadline(run, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(cacheLifecycleError('CACHE_ABORTED'));
  if (!timeoutMs && !signal) return Promise.resolve().then(run);
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, cacheLifecycleError('CACHE_ABORTED'));
    const timer = timeoutMs ? setTimeout(() => finish(reject, cacheLifecycleError('CACHE_TIMEOUT')), timeoutMs) : null;
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw cacheLifecycleError('CACHE_ABORTED');
      return run();
    }).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function safeGetCache(key, options = {}) {
  if (!key || !isRedisReady()) return null;
  const client = getRedisClient();
  if (!client) return null;

  try {
    const raw = await withCacheDeadline(() => client.get(key), options.timeoutMs, options.signal);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function safeSetCache(key, data, ttlSeconds, options = {}) {
  if (!key || !ttlSeconds || !isRedisReady()) return false;
  const client = getRedisClient();
  if (!client) return false;

  try {
    await withCacheDeadline(() => client.set(key, JSON.stringify(data), 'EX', ttlSeconds), options.timeoutMs, options.signal);
    return true;
  } catch (_) {
    return false;
  }
}

async function safeSetCacheWithStale(key, data, ttlSeconds, options = {}) {
  const freshTtlSeconds = options.deterministicTtlSpreadSeconds !== undefined
    ? getDeterministicSpreadTtlSeconds(ttlSeconds, key, options.deterministicTtlSpreadSeconds)
    : getJitteredTtlSeconds(ttlSeconds, options.random);
  const staleWindowSeconds = Math.max(
    1,
    Math.floor(Number(options.staleWindowSeconds) || Math.max(1, Math.floor(ttlSeconds * DEFAULT_STALE_WINDOW_MULTIPLIER)))
  );
  const staleKey = buildStaleCacheKey(key);
  if (!staleKey) return false;

  const freshStored = await safeSetCache(key, data, freshTtlSeconds, options);
  if (!freshStored) return false;

  const staleStored = await safeSetCache(staleKey, data, getStaleTtlSeconds(freshTtlSeconds, staleWindowSeconds), options);
  return staleStored;
}

function createLockToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function safeAcquireRebuildLock(key, ttlSeconds = DEFAULT_LOCK_TTL_SECONDS, options = {}) {
  const lockKey = buildCacheLockKey(key);
  if (!lockKey || !isRedisReady()) return null;
  const client = getRedisClient();
  if (!client) return null;

  const token = createLockToken();
  try {
    const result = await withCacheDeadline(() => client.set(lockKey, token, 'EX', Math.max(1, Math.floor(ttlSeconds)), 'NX'), options.timeoutMs, options.signal);
    return result === 'OK' ? { lockKey, token } : null;
  } catch (_) {
    return null;
  }
}

async function safeReleaseRebuildLock(lock, options = {}) {
  if (!lock || !lock.lockKey || !lock.token || !isRedisReady()) return 0;
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await withCacheDeadline(() => client.eval(LOCK_RELEASE_SCRIPT, 1, lock.lockKey, lock.token), options.timeoutMs);
  } catch (_) {
    return 0;
  }
}

function createConcurrencyLimiter(limit) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < max && queue.length) {
      const task = queue.shift();
      task.cleanup();
      if (Date.now() >= task.deadline) {
        task.reject(cacheLifecycleError('CACHE_ADMISSION_TIMEOUT'));
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(() => {
          if (task.signal?.aborted) throw cacheLifecycleError('CACHE_ABORTED');
          return task.fn();
        })
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run(fn, { waitMs, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(cacheLifecycleError('CACHE_ABORTED'));
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const cancel = (code) => {
          const index = queue.indexOf(task);
          if (index < 0) return;
          queue.splice(index, 1);
          cleanup();
          reject(cacheLifecycleError(code));
        };
        const abort = () => cancel('CACHE_ABORTED');
        const task = { fn, resolve, reject, cleanup, signal, deadline: waitMs === undefined ? Infinity : Date.now() + waitMs };
        queue.push(task);
        signal?.addEventListener('abort', abort, { once: true });
        if (waitMs !== undefined) timer = setTimeout(() => cancel('CACHE_ADMISSION_TIMEOUT'), waitMs);
        drain();
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    get limit() {
      return max;
    },
  };
}

function getNamedRebuildLimiter(name, limit) {
  const key = String(name || '').trim();
  if (!key) return null;
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const existing = rebuildLimiters.get(key);
  if (existing && existing.limit === max) return existing;
  const limiter = createConcurrencyLimiter(max);
  rebuildLimiters.set(key, limiter);
  return limiter;
}

function cloneRequestForBackground(req) {
  const cloned = {
    method: req?.method,
    originalUrl: req?.originalUrl,
    url: req?.url,
    baseUrl: req?.baseUrl,
    path: req?.path,
    route: req?.route,
    query: { ...(req?.query || {}) },
    params: { ...(req?.params || {}) },
    headers: { ...(req?.headers || {}) },
    lang: req?.lang,
  };
  const cacheContext = getRequestTimingCacheContext(req);
  copyRequestTimingIdentity(req, cloned);
  if (cacheContext) setRequestTimingCacheContext(cloned, cacheContext);
  return cloned;
}

async function runBackgroundJsonHandler(handler, req) {
  const shadowReq = cloneRequestForBackground(req);
  setRequestTimingCacheStatus(shadowReq, 'rebuild');
  const shadowRes = {
    statusCode: 200,
    headers: {},
    set(name, value) {
      this.headers[String(name || '').toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = Number(code) || this.statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      this.finished = true;
      return this;
    },
  };

  await handler(shadowReq, shadowRes, () => {});
  if (!shadowRes.finished) return null;
  return { status: shadowRes.statusCode, body: shadowRes.body, req: shadowReq, res: shadowRes };
}

async function safeDeleteKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || !isRedisReady()) return 0;
  const client = getRedisClient();
  if (!client) return 0;

  const uniqueKeys = Array.from(new Set(keys
    .map((key) => String(key || '').trim())
    .filter(Boolean)
    .flatMap((key) => key.endsWith(':stale') ? [key] : [key, buildStaleCacheKey(key)])));
  if (!uniqueKeys.length) return 0;

  try {
    const deleted = await client.del(uniqueKeys);
    for (const key of uniqueKeys) {
      console.log(`[cache] invalidate ${key}`);
    }
    return deleted;
  } catch (_) {
    return 0;
  }
}

async function safeDeleteByPrefix(prefix) {
  if (!prefix || !isRedisReady()) return 0;
  const client = getRedisClient();
  if (!client) return 0;

  let deleted = 0;
  let cursor = '0';

  try {
    console.log(`[cache] invalidate-prefix ${prefix}`);
    do {
      const reply = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = Array.isArray(reply) ? String(reply[0] || '0') : '0';
      const batch = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1].filter(Boolean) : [];
      if (batch.length) {
        deleted += await client.del(batch);
      }
    } while (cursor !== '0');
  } catch (_) {
    return deleted;
  }

  return deleted;
}

function shouldCacheSuccessfulJson({ statusCode, body }) {
  return statusCode >= 200 && statusCode < 300 && body !== null && body !== undefined;
}

function createBoundedRebuildMiddleware({ options, buildKey, shouldCache, setHeaders, backgroundRebuild, rebuildLimiter, lockTtlSeconds, coldCacheWaitMs, coldCachePollMs, setCacheValue }) {
  const admissionTimeoutMs = Math.max(1, Number(options.rebuildAdmissionTimeoutMs) || coldCacheWaitMs);
  const commandTimeoutMs = Math.max(1, Number(options.rebuildCommandTimeoutMs) || coldCacheWaitMs);
  const scheduled = new Set();
  const locked = Symbol('locked');
  const commandOptions = (signal) => ({ timeoutMs: commandTimeoutMs, signal });
  const usable = (value) => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'body');
  const read = (key, signal) => safeGetCache(key, commandOptions(signal));
  const send = (req, res, payload, status) => {
    if (res.destroyed || req.aborted) return;
    setRequestTimingCacheStatus(req, status);
    return res.status(payload.status || 200).json(payload.body);
  };
  const unavailable = (req, res) => {
    if (res.destroyed || req.aborted || res.writableEnded) return;
    setRequestTimingCacheStatus(req, 'busy');
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', '1');
    return options.onRebuildUnavailable(req, res);
  };

  const rebuild = async (key, req, signal, foreground) => {
    if (signal?.aborted) throw cacheLifecycleError('CACHE_ABORTED');
    const fresh = await read(key, signal);
    if (usable(fresh)) return { ...fresh, cache: 'hit' };
    if (foreground) {
      const stale = await read(buildStaleCacheKey(key), signal);
      if (usable(stale)) return { ...stale, cache: 'stale-hit' };
    }
    if (signal?.aborted) throw cacheLifecycleError('CACHE_ABORTED');
    const lockStarted = Date.now();
    const lock = await safeAcquireRebuildLock(key, lockTtlSeconds, commandOptions(signal));
    if (!lock && isRedisReady()) return locked;
    try {
      if (lock) console.log(`[cache] rebuild-lock-acquired ${key}`);
      if (signal?.aborted) throw cacheLifecycleError('CACHE_ABORTED');
      if (lock) {
        const refreshed = await read(key, signal);
        if (usable(refreshed)) return { ...refreshed, cache: 'hit' };
      }
      const remainingMs = lockTtlSeconds * 1000 - (Date.now() - lockStarted);
      if (remainingMs <= 0) throw cacheLifecycleError('CACHE_TIMEOUT');
      setRequestTimingCacheStatus(req, 'rebuild');
      const rebuildStart = nowMs();
      const captured = await withCacheDeadline(() => runBackgroundJsonHandler(backgroundRebuild, req), remainingMs, signal);
      if (!captured) throw new Error('Cache rebuild completed without a JSON response');
      logSlowTiming('cache.rebuild', { req, res: captured.res, durationMs: nowMs() - rebuildStart, cache: 'rebuild' });
      const payload = { status: captured.status, body: captured.body, headers: captured.res.headers, cache: 'rebuild' };
      if (lock && !signal?.aborted && Date.now() - lockStarted < lockTtlSeconds * 1000
        && shouldCache({ statusCode: captured.status, body: captured.body, key, req, res: captured.res })) {
        const client = getRedisClient();
        const owner = client && await withCacheDeadline(() => client.get(lock.lockKey), commandTimeoutMs, signal).catch(() => null);
        if (owner === lock.token && !signal?.aborted && Date.now() - lockStarted < lockTtlSeconds * 1000) {
          const stored = await setCacheValue(key, { status: captured.status, body: captured.body }, commandOptions(signal));
          if (stored) console.log(`[cache] set ${key} ttl=${options.ttlSeconds}`);
        }
      }
      return payload;
    } finally {
      await safeReleaseRebuildLock(lock, { timeoutMs: commandTimeoutMs });
    }
  };

  const schedule = (key, req) => {
    if (scheduled.has(key)) return;
    scheduled.add(key);
    rebuildLimiter.run(() => rebuild(key, cloneRequestForBackground(req), undefined, false), { waitMs: admissionTimeoutMs })
      .catch((error) => {
        if (error.code !== 'CACHE_ADMISSION_TIMEOUT') console.warn('[cache] background-rebuild-failed', { key, message: error.message });
      })
      .finally(() => scheduled.delete(key));
  };

  return async function boundedCacheMiddleware(req, res, next) {
    const controller = new AbortController();
    const { signal } = controller;
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      let key;
      try { key = buildKey(req); } catch (_) {}
      if (signal.aborted) return;
      if (!key) return next();
      if (setHeaders) setHeaders(res, req);
      const lookupStart = nowMs();
      const cached = await read(key, signal);
      if (signal.aborted) return;
      logSlowTiming('cache.lookup', { req, res, durationMs: nowMs() - lookupStart, cache: usable(cached) ? 'hit' : 'miss' });
      if (usable(cached)) {
        console.log(`[cache] hit ${key}`);
        return send(req, res, cached, 'hit');
      }
      setRequestTimingCacheStatus(req, 'miss');
      console.log(`[cache] miss ${key}`);
      const stale = await read(buildStaleCacheKey(key), signal);
      if (signal.aborted) return;
      if (usable(stale)) {
        console.log(`[cache] stale-hit ${key}`);
        schedule(key, req);
        return send(req, res, stale, 'stale-hit');
      }
      let payload;
      const admissionStart = nowMs();
      try {
        setRequestTimingCacheStatus(req, 'queued');
        payload = await rebuildLimiter.run(() => {
          logSlowTiming('cache.admission', { req, res, durationMs: nowMs() - admissionStart, cache: 'queued' });
          return rebuild(key, req, signal, true);
        }, { waitMs: admissionTimeoutMs, signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error.code !== 'CACHE_ADMISSION_TIMEOUT' && error.code !== 'CACHE_TIMEOUT') throw error;
        if (error.code === 'CACHE_ADMISSION_TIMEOUT') {
          logSlowTiming('cache.admission', { req, res, durationMs: nowMs() - admissionStart, cache: 'busy', thresholdMs: admissionTimeoutMs });
        }
        const refreshed = await read(key, signal);
        if (signal.aborted) return;
        if (usable(refreshed)) return send(req, res, refreshed, 'hit');
        const fallback = await read(buildStaleCacheKey(key), signal);
        if (signal.aborted) return;
        if (usable(fallback)) return send(req, res, fallback, 'stale-hit');
        return unavailable(req, res);
      }
      if (signal.aborted) return;
      if (payload === locked) {
        setRequestTimingCacheStatus(req, 'miss');
        console.log(`[cache] rebuild-wait ${key}`);
        const deadline = Date.now() + coldCacheWaitMs;
        while (!signal.aborted && Date.now() < deadline) {
          await withCacheDeadline(() => new Promise((resolve) => setTimeout(resolve, coldCachePollMs)), undefined, signal);
          const refreshed = await read(key, signal);
          if (usable(refreshed)) return send(req, res, refreshed, 'hit');
        }
        return unavailable(req, res);
      }
      for (const [name, value] of Object.entries(payload.headers || {})) res.set(name, value);
      if (payload.cache === 'stale-hit') schedule(key, req);
      return send(req, res, payload, payload.cache);
    } catch (error) {
      if (!signal.aborted) return next(error);
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  };
}

function createJsonCacheMiddleware(options = {}) {
  const ttlSeconds = Number(options.ttlSeconds || 0);
  const buildKey = typeof options.buildKey === 'function' ? options.buildKey : () => null;
  const shouldCache = typeof options.shouldCache === 'function' ? options.shouldCache : shouldCacheSuccessfulJson;
  const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;
  const backgroundRebuild = typeof options.backgroundRebuild === 'function' ? options.backgroundRebuild : null;
  const staleWhileRevalidate = Boolean(options.staleWhileRevalidate && backgroundRebuild);
  const deterministicTtlSpreadSeconds = Math.max(0, Math.floor(Number(options.deterministicTtlSpreadSeconds) || 0));
  const rebuildLimiter = options.rebuildConcurrencyGroup
    ? getNamedRebuildLimiter(options.rebuildConcurrencyGroup, options.rebuildConcurrencyLimit || 1)
    : null;
  const lockTtlSeconds = Math.max(1, Math.floor(Number(options.lockTtlSeconds) || DEFAULT_LOCK_TTL_SECONDS));
  const staleWindowSeconds = Math.max(1, Math.floor(Number(options.staleWindowSeconds) || Math.max(1, Math.floor(ttlSeconds * DEFAULT_STALE_WINDOW_MULTIPLIER))));
  const coldCacheWaitMs = Math.max(0, Math.floor(Number(options.coldCacheWaitMs) || DEFAULT_COLD_CACHE_WAIT_MS));
  const coldCachePollMs = Math.max(10, Math.floor(Number(options.coldCachePollMs) || 75));

  const setCacheValue = (key, value, commandOptions = {}) => safeSetCacheWithStale(key, value, ttlSeconds, {
    ...commandOptions,
    staleWindowSeconds,
    ...(deterministicTtlSpreadSeconds ? { deterministicTtlSpreadSeconds } : {}),
  });

  if (rebuildLimiter && staleWhileRevalidate && typeof options.onRebuildUnavailable === 'function') {
    return createBoundedRebuildMiddleware({ options, buildKey, shouldCache, setHeaders, backgroundRebuild, rebuildLimiter, lockTtlSeconds, coldCacheWaitMs, coldCachePollMs, setCacheValue });
  }

  const runWithLimiter = (fn) => (rebuildLimiter ? rebuildLimiter.run(fn) : fn());

  const refreshInBackground = async (key, req) => {
    const lock = await safeAcquireRebuildLock(key, lockTtlSeconds);
    if (!lock) return false;

    runWithLimiter(async () => {
      const rebuildStart = nowMs();
      try {
        const captured = await runBackgroundJsonHandler(backgroundRebuild, req);
        if (!captured) return;
        logSlowTiming('cache.rebuild', { req: captured.req, res: captured.res, durationMs: nowMs() - rebuildStart, cache: 'rebuild' });
        const payload = { statusCode: captured.status, body: captured.body, key, req: captured.req, res: captured.res };
        if (shouldCache(payload)) {
          const stored = await setCacheValue(key, { status: captured.status, body: captured.body });
          if (stored) console.log(`[cache] set ${key} ttl=${ttlSeconds}`);
        }
      } catch (error) {
        console.warn('[cache] background-rebuild-failed', { key, message: error?.message || String(error) });
      } finally {
        await safeReleaseRebuildLock(lock);
      }
    }).catch(() => {});

    return true;
  };

  return async function cacheJsonMiddleware(req, res, next) {
    let key = null;
    try {
      key = buildKey(req);
    } catch (_) {
      key = null;
    }

    if (!key || ttlSeconds <= 0) return next();

    if (setHeaders) {
      try {
        setHeaders(res, req);
      } catch (_) {}
    }

    const lookupStart = nowMs();
    const cached = await safeGetCache(key);
    if (cached && typeof cached === 'object' && Object.prototype.hasOwnProperty.call(cached, 'body')) {
      setRequestTimingCacheStatus(req, 'hit');
      logSlowTiming('cache.lookup', { req, res, durationMs: nowMs() - lookupStart, cache: 'hit' });
      console.log(`[cache] hit ${key}`);
      return res.status(typeof cached.status === 'number' ? cached.status : 200).json(cached.body);
    }

    setRequestTimingCacheStatus(req, 'miss');
    logSlowTiming('cache.lookup', { req, res, durationMs: nowMs() - lookupStart, cache: 'miss' });

    console.log(`[cache] miss ${key}`);

    // Redis failures remain fail-open: a missing lock must never block the route.
    if (!isRedisReady()) return next();

    const staleKey = buildStaleCacheKey(key);
    const stale = await safeGetCache(staleKey);
    if (staleWhileRevalidate && stale && typeof stale === 'object' && Object.prototype.hasOwnProperty.call(stale, 'body')) {
      setRequestTimingCacheStatus(req, 'stale-hit');
      console.log(`[cache] stale-hit ${key}`);
      refreshInBackground(key, req).catch(() => {});
      return res.status(typeof stale.status === 'number' ? stale.status : 200).json(stale.body);
    }

    const lock = await safeAcquireRebuildLock(key, lockTtlSeconds);
    if (!lock) {
      if (stale && typeof stale === 'object' && Object.prototype.hasOwnProperty.call(stale, 'body')) {
        setRequestTimingCacheStatus(req, 'stale-hit');
        console.log(`[cache] stale-hit ${key}`);
        return res.status(typeof stale.status === 'number' ? stale.status : 200).json(stale.body);
      }

      console.log(`[cache] rebuild-wait ${key}`);
      const deadline = Date.now() + coldCacheWaitMs;
      while (Date.now() < deadline) {
        const jitterMs = Math.floor(Math.random() * 20);
        await new Promise((resolve) => setTimeout(resolve, coldCachePollMs + jitterMs));
        const rebuilt = await safeGetCache(key);
        if (rebuilt && typeof rebuilt === 'object' && Object.prototype.hasOwnProperty.call(rebuilt, 'body')) {
          setRequestTimingCacheStatus(req, 'hit');
          console.log(`[cache] hit ${key}`);
          return res.status(typeof rebuilt.status === 'number' ? rebuilt.status : 200).json(rebuilt.body);
        }
        if (!isRedisReady()) break;
      }

      return next();
    }

    console.log(`[cache] rebuild-lock-acquired ${key}`);
    setRequestTimingCacheStatus(req, 'rebuild');
    return runWithLimiter(() => new Promise((resolve, reject) => {
      const rebuildStart = nowMs();
      let released = false;
      let cacheWritePromise = Promise.resolve();
      const releaseLock = () => {
        if (released) return;
        released = true;
        cacheWritePromise
          .finally(() => safeReleaseRebuildLock(lock))
          .catch(() => {})
          .finally(resolve);
      };
      res.once('finish', releaseLock);
      res.once('close', releaseLock);

      const originalJson = res.json.bind(res);
      res.json = function patchedJson(body) {
        const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 200;
        logSlowTiming('cache.rebuild', { req, res, durationMs: nowMs() - rebuildStart, cache: 'rebuild' });
        const payload = { statusCode, body, key, req, res };
        if (shouldCache(payload)) {
          cacheWritePromise = setCacheValue(key, { status: statusCode, body }).then((stored) => {
            if (stored) {
              console.log(`[cache] set ${key} ttl=${ttlSeconds}`);
            }
          }).catch(() => {});
        }

        return originalJson(body);
      };

      try {
        next();
      } catch (error) {
        releaseLock();
        reject(error);
      }
    }));
  };
}

async function invalidateArticleCaches() {
  await safeDeleteByPrefix(`${CACHE_PREFIX}:home:`);
  await safeDeleteByPrefix(`${CACHE_PREFIX}:latest:`);
  await safeDeleteByPrefix(`${CACHE_PREFIX}:trending:`);
  await safeDeleteByPrefix(`${CACHE_PREFIX}:category:`);
  await safeDeleteByPrefix(`${CACHE_PREFIX}:article:`);
}

async function invalidateArticleLanguageCaches(slugOrId) {
  const keys = ['en', 'hi', 'gu']
    .map((lang) => buildArticleCacheKey(lang, slugOrId))
    .filter(Boolean);
  if (keys.length) await safeDeleteKeys(keys);
}

async function invalidatePublicSettingsCaches() {
  await safeDeleteKeys([buildPublicSettingsCacheKey()]);
  await safeDeleteByPrefix(`${CACHE_PREFIX}:home:`);
}

async function invalidateAdsCaches(slot) {
  const normalizedSlot = normalizeSlot(slot);
  if (normalizedSlot) {
    await safeDeleteKeys([buildAdsCacheKey(normalizedSlot)]);
    return;
  }
  await safeDeleteByPrefix(`${CACHE_PREFIX}:ads:`);
}

async function invalidateBroadcastCaches() {
  await safeDeleteByPrefix(`${CACHE_PREFIX}:broadcast:`);
}

module.exports = {
  isRedisReady,
  safeGetCache,
  safeSetCache,
  safeSetCacheWithStale,
  safeDeleteKeys,
  safeDeleteByPrefix,
  safeAcquireRebuildLock,
  safeReleaseRebuildLock,
  createJsonCacheMiddleware,
  normalizeCacheLang,
  normalizeCategorySlugForCache,
  normalizePageForCache,
  buildPublicSettingsCacheKey,
  buildHomeCacheKey,
  buildLatestCacheKey,
  buildTrendingCacheKey,
  buildCategoryCacheKey,
  buildAdsCacheKey,
  buildBroadcastCacheKey,
  buildArticleCacheKey,
  buildStaleCacheKey,
  buildCacheLockKey,
  getDeterministicSpreadTtlSeconds,
  getJitteredTtlSeconds,
  getStaleTtlSeconds,
  invalidateArticleCaches,
  invalidateArticleLanguageCaches,
  invalidatePublicSettingsCaches,
  invalidateAdsCaches,
  invalidateBroadcastCaches,
};