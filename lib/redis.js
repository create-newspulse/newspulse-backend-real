const Redis = require('ioredis');

const redisUrl = String(process.env.REDIS_URL || '').trim();

let redisClient = null;
let redisReady = false;

function isTestRedisEnabled(env = process.env) {
  const value = String(env.NEWSPULSE_ALLOW_REDIS_IN_TESTS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function shouldConnectRedis(env = process.env) {
  const url = String(env.REDIS_URL || '').trim();
  if (!url) return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'test' && !isTestRedisEnabled(env)) return false;
  return true;
}

if (shouldConnectRedis()) {
  redisClient = new Redis(redisUrl, {
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  });

  redisClient.on('ready', () => {
    redisReady = true;
    console.log('[redis] connected');
  });

  redisClient.on('error', (error) => {
    redisReady = false;
    console.error('[redis] error', error?.message || error);
  });

  redisClient.on('reconnecting', () => {
    redisReady = false;
    console.log('[redis] reconnecting');
  });

  redisClient.on('end', () => {
    redisReady = false;
  });
}

function getRedisClient() {
  return redisClient;
}

function isRedisReady() {
  if (!redisClient) return false;
  if (redisReady) return true;
  return redisClient.status === 'ready';
}

module.exports = {
  getRedisClient,
  isRedisReady,
  isTestRedisEnabled,
  shouldConnectRedis,
};