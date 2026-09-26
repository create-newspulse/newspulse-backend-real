const { isRedisReady, onArticleCachesInvalidated } = require('./cache');

function startCanonicalLatestPrewarm({ refresh, mongo, redis, redisReady = isRedisReady, delayMs = 1000 }) {
  const pending = new Map();
  let timer;
  let running = false;
  let stopped = false;
  const ready = () => mongo.readyState === 1 && redisReady();

  const schedule = (immediate = false) => {
    if (stopped || timer || running || !pending.size || !ready()) return;
    timer = setTimeout(run, immediate ? 0 : delayMs);
    timer.unref?.();
  };

  const run = async () => {
    timer = undefined;
    if (stopped || !ready()) return;
    const [language, attempts] = pending.entries().next().value;
    pending.delete(language);
    running = true;
    try {
      const success = await refresh({
        method: 'GET', originalUrl: '/api/public/news', baseUrl: '/api/public/news', route: { path: '/' },
        query: { lang: language, language, limit: '40' }, headers: {}, params: {},
      });
      if (!success && attempts < 2 && !pending.has(language)) pending.set(language, attempts + 1);
    } catch (_) {
      if (attempts < 2 && !pending.has(language)) pending.set(language, attempts + 1);
    } finally {
      running = false;
      schedule();
    }
  };

  const requestWarm = ({ publicVisibilityRemoved = false } = {}) => {
    if (stopped) return;
    for (const language of ['en', 'hi', 'gu']) pending.set(language, 0);
    if (publicVisibilityRemoved && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    schedule(publicVisibilityRemoved);
  };
  const unsubscribe = onArticleCachesInvalidated(requestWarm);
  mongo.on('connected', requestWarm);
  redis?.on('ready', requestWarm);
  requestWarm();

  return () => {
    stopped = true;
    clearTimeout(timer);
    pending.clear();
    unsubscribe();
    mongo.removeListener('connected', requestWarm);
    redis?.removeListener('ready', requestWarm);
  };
}

module.exports = { startCanonicalLatestPrewarm };