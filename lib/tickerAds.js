const sanitizeHtml = require('sanitize-html');

const { parseDateMaybe } = require('../src/utils/parseDateMaybe');

const TICKER_AD_LANGS = ['en', 'hi', 'gu', 'all'];
const TICKER_AD_CHANNELS = ['breaking', 'live', 'both'];
const TICKER_AD_DAY_PARTS = ['morning', 'noon', 'evening', 'night'];
const TICKER_AD_LANG_ALIASES = {
  english: 'en',
  hindi: 'hi',
  gujarati: 'gu',
  all: 'all',
  'all languages': 'all',
};

const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

function parseIsoLikeWithoutTimezoneAsIst(s) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*$/.exec(String(s || ''));
  if (!m) return null;

  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const HH = m[4] != null ? Number(m[4]) : 0;
  const MM = m[5] != null ? Number(m[5]) : 0;
  const SS = m[6] != null ? Number(m[6]) : 0;
  const rawMs = m[7] != null ? String(m[7]) : '0';
  const ms = Number(rawMs.padEnd(3, '0'));

  if (!Number.isInteger(dd) || dd < 1 || dd > 31) return null;
  if (!Number.isInteger(mm) || mm < 1 || mm > 12) return null;
  if (!Number.isInteger(yyyy) || yyyy < 1970 || yyyy > 9999) return null;
  if (!Number.isInteger(HH) || HH < 0 || HH > 23) return null;
  if (!Number.isInteger(MM) || MM < 0 || MM > 59) return null;
  if (!Number.isInteger(SS) || SS < 0 || SS > 59) return null;
  if (!Number.isInteger(ms) || ms < 0 || ms > 999) return null;

  // Interpret provided components as Asia/Kolkata wall-clock.
  const utcMs = Date.UTC(yyyy, mm - 1, dd, HH, MM, SS, ms) - IST_OFFSET_MS;
  const d = new Date(utcMs);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

function parseLegacyDmyHmAsIst(s) {
  const m = /^\s*(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(String(s || ''));
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const HH = m[4] != null ? Number(m[4]) : 0;
  const MM = m[5] != null ? Number(m[5]) : 0;
  const SS = m[6] != null ? Number(m[6]) : 0;

  if (!Number.isInteger(dd) || dd < 1 || dd > 31) return null;
  if (!Number.isInteger(mm) || mm < 1 || mm > 12) return null;
  if (!Number.isInteger(yyyy) || yyyy < 1970 || yyyy > 9999) return null;
  if (!Number.isInteger(HH) || HH < 0 || HH > 23) return null;
  if (!Number.isInteger(MM) || MM < 0 || MM > 59) return null;
  if (!Number.isInteger(SS) || SS < 0 || SS > 59) return null;

  const utcMs = Date.UTC(yyyy, mm - 1, dd, HH, MM, SS, 0) - IST_OFFSET_MS;
  const d = new Date(utcMs);
  // Guard against overflows like 32-01-2026
  const check = new Date(utcMs + IST_OFFSET_MS);
  if (check.getUTCFullYear() !== yyyy || check.getUTCMonth() !== (mm - 1) || check.getUTCDate() !== dd) return null;
  return d;
}

function sanitizeTickerAdMessage(value) {
  const raw = typeof value === 'string' ? value : '';
  const stripped = sanitizeHtml(raw, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return stripped.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalTickerAdMessage(value) {
  const sanitized = sanitizeTickerAdMessage(value);
  return sanitized ? sanitized : null;
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
  if (TICKER_AD_LANG_ALIASES[raw]) return TICKER_AD_LANG_ALIASES[raw];
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

  // Treat empty/blank input as "all day".
  return normalized.length > 0 ? normalized : TICKER_AD_DAY_PARTS.slice();
}

function clampTickerAdFrequency(value, fallback = 3) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(10, Math.max(1, Math.round(numeric)));
}

function parseTickerAdDate(value, fieldName) {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (raw) {
      // If timezone is provided (Z / ±HH:mm), let parseDateMaybe handle it.
      const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})\s*$/.test(raw);
      if (!hasTimezone) {
        const istIso = parseIsoLikeWithoutTimezoneAsIst(raw);
        if (istIso) return { ok: true, value: istIso };
        const istLegacy = parseLegacyDmyHmAsIst(raw);
        if (istLegacy) return { ok: true, value: istLegacy };
      }
    }
  }

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
  normalizeOptionalTickerAdMessage,
  normalizeOptionalTickerAdUrl,
  isValidTickerAdHttpUrl,
  normalizeTickerAdLang,
  normalizeTickerAdChannel,
  normalizeTickerAdDayParts,
  clampTickerAdFrequency,
  parseTickerAdDate,
  getIstDayPart,
};