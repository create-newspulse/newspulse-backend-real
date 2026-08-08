const { normalizeSlot } = require('./ads');
const { getCanonicalPublicCategoryKey } = require('./categories');
const { getRedisClient, isRedisReady: isRedisConnectionReady } = require('./redis');

const CACHE_PREFIX = 'np:v1';
const DEFAULT_LOCK_TTL_SECONDS = 15;
const DEFAULT_STALE_WINDOW_MULTIPLIER = 1;
const DEFAULT_COLD_CACHE_WAIT_MS = 600;
const LOCK_RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

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

function getStaleTtlSeconds(freshTtlSeconds, staleWindowSeconds) {
  const freshTtl = Math.max(1, Math.floor(Number(freshTtlSeconds) || 0));
  const window = Math.max(1, Math.floor(Number(staleWindowSeconds) || 0));
  return freshTtl + window;
}

async function safeGetCache(key) {
  if (!key || !isRedisReady()) return null;
  const client = getRedisClient();
  if (!client) return null;

  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function safeSetCache(key, data, ttlSeconds) {
  if (!key || !ttlSeconds || !isRedisReady()) return false;
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    return true;
  } catch (_) {
    return false;
  }
}

async function safeSetCacheWithStale(key, data, ttlSeconds, options = {}) {
  const freshTtlSeconds = getJitteredTtlSeconds(ttlSeconds, options.random);
  const staleWindowSeconds = Math.max(
    1,
    Math.floor(Number(options.staleWindowSeconds) || Math.max(1, Math.floor(ttlSeconds * DEFAULT_STALE_WINDOW_MULTIPLIER)))
  );
  const staleKey = buildStaleCacheKey(key);
  if (!staleKey) return false;

  const freshStored = await safeSetCache(key, data, freshTtlSeconds);
  if (!freshStored) return false;

  const staleStored = await safeSetCache(staleKey, data, getStaleTtlSeconds(freshTtlSeconds, staleWindowSeconds));
  return staleStored;
}

function createLockToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function safeAcquireRebuildLock(key, ttlSeconds = DEFAULT_LOCK_TTL_SECONDS) {
  const lockKey = buildCacheLockKey(key);
  if (!lockKey || !isRedisReady()) return null;
  const client = getRedisClient();
  if (!client) return null;

  const token = createLockToken();
  try {
    const result = await client.set(lockKey, token, 'EX', Math.max(1, Math.floor(ttlSeconds)), 'NX');
    return result === 'OK' ? { lockKey, token } : null;
  } catch (_) {
    return null;
  }
}

async function safeReleaseRebuildLock(lock) {
  if (!lock || !lock.lockKey || !lock.token || !isRedisReady()) return 0;
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.eval(LOCK_RELEASE_SCRIPT, 1, lock.lockKey, lock.token);
  } catch (_) {
    return 0;
  }
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

function createJsonCacheMiddleware(options = {}) {
  const ttlSeconds = Number(options.ttlSeconds || 0);
  const buildKey = typeof options.buildKey === 'function' ? options.buildKey : () => null;
  const shouldCache = typeof options.shouldCache === 'function' ? options.shouldCache : shouldCacheSuccessfulJson;
  const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;
  const lockTtlSeconds = Math.max(1, Math.floor(Number(options.lockTtlSeconds) || DEFAULT_LOCK_TTL_SECONDS));
  const staleWindowSeconds = Math.max(1, Math.floor(Number(options.staleWindowSeconds) || Math.max(1, Math.floor(ttlSeconds * DEFAULT_STALE_WINDOW_MULTIPLIER))));
  const coldCacheWaitMs = Math.max(0, Math.floor(Number(options.coldCacheWaitMs) || DEFAULT_COLD_CACHE_WAIT_MS));
  const coldCachePollMs = Math.max(10, Math.floor(Number(options.coldCachePollMs) || 75));

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

    const cached = await safeGetCache(key);
    if (cached && typeof cached === 'object' && Object.prototype.hasOwnProperty.call(cached, 'body')) {
      console.log(`[cache] hit ${key}`);
      return res.status(typeof cached.status === 'number' ? cached.status : 200).json(cached.body);
    }

    console.log(`[cache] miss ${key}`);

    // Redis failures remain fail-open: a missing lock must never block the route.
    if (!isRedisReady()) return next();

    const lock = await safeAcquireRebuildLock(key, lockTtlSeconds);
    if (!lock) {
      const stale = await safeGetCache(buildStaleCacheKey(key));
      if (stale && typeof stale === 'object' && Object.prototype.hasOwnProperty.call(stale, 'body')) {
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
          console.log(`[cache] hit ${key}`);
          return res.status(typeof rebuilt.status === 'number' ? rebuilt.status : 200).json(rebuilt.body);
        }
        if (!isRedisReady()) break;
      }

      return next();
    }

    console.log(`[cache] rebuild-lock-acquired ${key}`);
    let released = false;
    let cacheWritePromise = Promise.resolve();
    const releaseLock = () => {
      if (released) return;
      released = true;
      cacheWritePromise.finally(() => safeReleaseRebuildLock(lock)).catch(() => {});
    };
    res.once('finish', releaseLock);
    res.once('close', releaseLock);

    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 200;
      const payload = { statusCode, body, key, req, res };
      if (shouldCache(payload)) {
        cacheWritePromise = safeSetCacheWithStale(key, { status: statusCode, body }, ttlSeconds, { staleWindowSeconds }).then((stored) => {
          if (stored) {
            console.log(`[cache] set ${key} ttl=${ttlSeconds}`);
          }
        }).catch(() => {});
      }

      return originalJson(body);
    };

    return next();
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
  getJitteredTtlSeconds,
  getStaleTtlSeconds,
  invalidateArticleCaches,
  invalidateArticleLanguageCaches,
  invalidatePublicSettingsCaches,
  invalidateAdsCaches,
  invalidateBroadcastCaches,
};