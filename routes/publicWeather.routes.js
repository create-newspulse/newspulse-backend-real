const express = require('express');

const router = express.Router();

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const rateLimit = {
  windowMs: 60 * 1000,
  max: 60,
  hits: new Map(),
};

function getClientIp(req) {
  // Respect express trust proxy; fallback to socket.
  return (
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  const rec = rateLimit.hits.get(ip);
  if (!rec || now - rec.first > rateLimit.windowMs) {
    rateLimit.hits.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  rateLimit.hits.set(ip, rec);
  return rec.count > rateLimit.max;
}

function normalizeCity(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s;
}

function cacheKey(kind, city) {
  return `${kind}:${String(city || '').trim().toLowerCase()}`;
}

function getCached(kind, city) {
  const key = cacheKey(kind, city);
  const rec = cache.get(key);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    cache.delete(key);
    return null;
  }
  return rec.value;
}

function setCached(kind, city, value) {
  const key = cacheKey(kind, city);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _numOrNull(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function _round1(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function mapCurrentToMinimal(payload, fallbackCity) {
  const city = (payload && typeof payload.name === 'string' && payload.name.trim()) ? payload.name.trim() : String(fallbackCity || '').trim();
  const tempC = _round1(_numOrNull(payload?.main?.temp));
  const feelsLikeC = _round1(_numOrNull(payload?.main?.feels_like));

  const weather0 = Array.isArray(payload?.weather) && payload.weather[0] ? payload.weather[0] : null;
  const condition = weather0 && (weather0.main || weather0.description) ? String(weather0.main || weather0.description) : null;
  const icon = weather0 && weather0.icon ? String(weather0.icon) : null;

  const humidity = _numOrNull(payload?.main?.humidity);
  const windMs = _numOrNull(payload?.wind?.speed);
  const windKmph = windMs === null ? null : _round1(windMs * 3.6);

  const dt = _numOrNull(payload?.dt);
  const updatedAt = dt ? new Date(dt * 1000).toISOString() : new Date().toISOString();

  return { city, tempC, feelsLikeC, condition, icon, humidity, windKmph, updatedAt };
}

function mapForecastToMinimal(payload, fallbackCity) {
  const cityName = payload?.city?.name;
  const city = (typeof cityName === 'string' && cityName.trim()) ? cityName.trim() : String(fallbackCity || '').trim();

  const item = Array.isArray(payload?.list) && payload.list.length ? payload.list[0] : null;
  if (!item) {
    return { city, tempC: null, feelsLikeC: null, condition: null, icon: null, humidity: null, windKmph: null, updatedAt: new Date().toISOString() };
  }

  const tempC = _round1(_numOrNull(item?.main?.temp));
  const feelsLikeC = _round1(_numOrNull(item?.main?.feels_like));

  const weather0 = Array.isArray(item?.weather) && item.weather[0] ? item.weather[0] : null;
  const condition = weather0 && (weather0.main || weather0.description) ? String(weather0.main || weather0.description) : null;
  const icon = weather0 && weather0.icon ? String(weather0.icon) : null;

  const humidity = _numOrNull(item?.main?.humidity);
  const windMs = _numOrNull(item?.wind?.speed);
  const windKmph = windMs === null ? null : _round1(windMs * 3.6);

  const dt = _numOrNull(item?.dt);
  const updatedAt = dt ? new Date(dt * 1000).toISOString() : new Date().toISOString();

  return { city, tempC, feelsLikeC, condition, icon, humidity, windKmph, updatedAt };
}

async function fetchJson(url) {
  const f = globalThis.fetch;
  if (typeof f !== 'function') {
    const err = new Error('fetch is not available in this runtime');
    err.code = 'NO_FETCH';
    throw err;
  }

  const res = await f(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json && json.message ? String(json.message) : `HTTP_${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }

  return json;
}

function buildOwmUrl(kind, city) {
  const apiKey = String(process.env.OPENWEATHER_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('Missing OPENWEATHER_API_KEY');
    err.status = 503;
    throw err;
  }

  const base = 'https://api.openweathermap.org/data/2.5';
  const q = encodeURIComponent(city);
  const units = 'metric';

  if (kind === 'current') {
    return `${base}/weather?q=${q}&units=${units}&appid=${encodeURIComponent(apiKey)}`;
  }

  if (kind === 'forecast') {
    return `${base}/forecast?q=${q}&units=${units}&appid=${encodeURIComponent(apiKey)}`;
  }

  const err = new Error('Unknown weather kind');
  err.status = 500;
  throw err;
}

function weatherHandler(kind) {
  return async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (isRateLimited(ip)) {
        return res.status(429).json({
          message: 'Too many requests. Please try again later.',
        });
      }

      const city = normalizeCity(req.query.city);
      if (!city) {
        return res.status(400).json({ message: 'Missing required query param: city' });
      }

      const cached = getCached(kind, city);
      if (cached) {
        return res.status(200).json(cached);
      }

      const url = buildOwmUrl(kind, city);
      const raw = await fetchJson(url);

      const out = kind === 'forecast'
        ? mapForecastToMinimal(raw, city)
        : mapCurrentToMinimal(raw, city);

      setCached(kind, city, out);
      return res.status(200).json(out);
    } catch (e) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      const msg = e?.message ? String(e.message) : 'Weather request failed';

      // OpenWeather uses 404 for unknown city.
      if (status === 404) {
        return res.status(404).json({ message: 'City not found' });
      }

      return res.status(status).json({ message: msg });
    }
  };
}

// GET /api/public/weather/current?city=
router.get('/current', weatherHandler('current'));

// GET /api/public/weather/forecast?city=
router.get('/forecast', weatherHandler('forecast'));

module.exports = router;
module.exports._test = {
  cache,
  rateLimit,
  getCached,
  setCached,
  normalizeCity,
  mapCurrentToMinimal,
  mapForecastToMinimal,
};
