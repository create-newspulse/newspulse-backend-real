const sanitizeHtml = require('sanitize-html');

const { parseDateMaybe } = require('../src/utils/parseDateMaybe');

const TICKER_AD_LANGS = ['en', 'hi', 'gu'];
const TICKER_AD_CHANNELS = ['breaking', 'live', 'both'];
const TICKER_AD_DAY_PARTS = ['morning', 'noon', 'evening', 'night'];

function sanitizeTickerAdMessage(value) {
  const raw = typeof value === 'string' ? value : '';
  const stripped = sanitizeHtml(raw, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return stripped.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalTickerAdUrl(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  return raw || null;
}

function isValidTickerAdHttpUrl(value) {
  if (value === undefined || value === null || value === '') return true;
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeTickerAdLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  return TICKER_AD_LANGS.includes(raw) ? raw : null;
}

function normalizeTickerAdChannel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return TICKER_AD_CHANNELS.includes(raw) ? raw : null;
}

function normalizeTickerAdDayParts(value) {
  if (value === undefined || value === null || value === '') {
    return TICKER_AD_DAY_PARTS.slice();
  }

  const input = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [];

  for (const item of input) {
    const part = String(item || '').trim().toLowerCase();
    if (!part) continue;
    if (!TICKER_AD_DAY_PARTS.includes(part)) return null;
    if (!normalized.includes(part)) normalized.push(part);
  }

  return normalized.length > 0 ? normalized : null;
}

function clampTickerAdFrequency(value, fallback = 3) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(10, Math.max(1, Math.round(numeric)));
}

function parseTickerAdDate(value, fieldName) {
  const parsed = parseDateMaybe(value);
  if (!parsed.ok || !parsed.date) {
    return { ok: false, message: `${fieldName} must be a valid date` };
  }
  return { ok: true, value: parsed.date };
}

function getIstHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);

  const hourPart = parts.find((part) => part && part.type === 'hour');
  const hour = Number(hourPart && hourPart.value);
  return Number.isFinite(hour) ? hour : 0;
}

function getIstDayPart(date = new Date()) {
  const hour = getIstHour(date);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'noon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

module.exports = {
  TICKER_AD_LANGS,
  TICKER_AD_CHANNELS,
  TICKER_AD_DAY_PARTS,
  sanitizeTickerAdMessage,
  normalizeOptionalTickerAdUrl,
  isValidTickerAdHttpUrl,
  normalizeTickerAdLang,
  normalizeTickerAdChannel,
  normalizeTickerAdDayParts,
  clampTickerAdFrequency,
  parseTickerAdDate,
  getIstDayPart,
};