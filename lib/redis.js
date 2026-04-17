const Redis = require('ioredis');

const redisUrl = String(process.env.REDIS_URL || '').trim();

let redisClient = null;
let redisReady = false;

if (redisUrl) {
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
};