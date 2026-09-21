const session = require('express-session');

const { getRedisClient } = require('./redis');

const DEFAULT_SESSION_KEY_PREFIX = 'np:session:';
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function isProductionLike(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production'
    || !!(env.RENDER || env.RENDER_SERVICE_ID || env.RENDER_EXTERNAL_URL);
}

function normalizeSessionKeyPrefix(prefix) {
  const value = String(prefix || '').trim();
  return value || DEFAULT_SESSION_KEY_PREFIX;
}

function getSessionTtlSeconds(sess, fallbackMs = DEFAULT_SESSION_TTL_MS) {
  const cookieMaxAge = Number(sess?.cookie?.maxAge);
  const ttlMs = Number.isFinite(cookieMaxAge) && cookieMaxAge > 0 ? cookieMaxAge : Number(fallbackMs);
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function callbackOnce(callback, error, value) {
  if (typeof callback === 'function') callback(error, value);
}

class RedisSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    if (!options.client) {
      throw new Error('[session] Redis/Valkey client is required for RedisSessionStore');
    }
    this.client = options.client;
    this.prefix = normalizeSessionKeyPrefix(options.prefix || process.env.SESSION_REDIS_PREFIX);
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_SESSION_TTL_MS;
  }

  key(sid) {
    return `${this.prefix}${sid}`;
  }

  get(sid, callback) {
    this.client.get(this.key(sid))
      .then((value) => {
        if (!value) return callbackOnce(callback, null, null);
        return callbackOnce(callback, null, JSON.parse(value));
      })
      .catch((error) => callbackOnce(callback, error));
  }

  set(sid, sess, callback) {
    const ttlSeconds = getSessionTtlSeconds(sess, this.ttlMs);
    this.client.set(this.key(sid), JSON.stringify(sess), 'EX', ttlSeconds)
      .then(() => callbackOnce(callback, null))
      .catch((error) => callbackOnce(callback, error));
  }

  destroy(sid, callback) {
    this.client.del(this.key(sid))
      .then(() => callbackOnce(callback, null))
      .catch((error) => callbackOnce(callback, error));
  }

  touch(sid, sess, callback) {
    const ttlSeconds = getSessionTtlSeconds(sess, this.ttlMs);
    this.client.expire(this.key(sid), ttlSeconds)
      .then(() => callbackOnce(callback, null))
      .catch((error) => callbackOnce(callback, error));
  }
}

function createExpressSessionStore(options = {}) {
  const productionLike = options.productionLike === undefined ? isProductionLike() : !!options.productionLike;
  const client = Object.prototype.hasOwnProperty.call(options, 'client') ? options.client : getRedisClient();

  if (client) {
    return new RedisSessionStore({
      client,
      prefix: options.prefix,
      ttlMs: options.ttlMs,
    });
  }

  if (productionLike) {
    throw new Error('[session] Redis/Valkey session store is required in production but no Redis client is configured');
  }

  return undefined;
}

module.exports = {
  DEFAULT_SESSION_KEY_PREFIX,
  DEFAULT_SESSION_TTL_MS,
  RedisSessionStore,
  createExpressSessionStore,
  getSessionTtlSeconds,
  isProductionLike,
};