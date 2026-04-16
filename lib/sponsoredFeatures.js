const { parseDateMaybe } = require('../src/utils/parseDateMaybe');

const SPONSORED_FEATURE_PLACEMENT_KEYS = ['HOMEPAGE_SPONSORED_FEATURE'];

function normalizePlacementKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (SPONSORED_FEATURE_PLACEMENT_KEYS.includes(raw)) return raw;

  const key = raw.replace(/[\s-]+/g, '_').toUpperCase();
  return SPONSORED_FEATURE_PLACEMENT_KEYS.includes(key) ? key : null;
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normalizeOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const parsed = parseDateMaybe(value);
  if (!parsed.ok) return { ok: false, message: `${fieldName} must be a valid date` };
  return { ok: true, value: parsed.date };
}

function parseOptionalNumber(value, fieldName, fallback) {
  if (value === undefined) {
    return fallback === undefined ? { ok: true, value: undefined } : { ok: true, value: fallback };
  }
  if (value === null || value === '') return { ok: true, value: fallback === undefined ? null : fallback };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, message: `${fieldName} must be a number` };
  return { ok: true, value: n };
}

function validateOptionalUrlLike(value, fieldName, { allowRelative = true } = {}) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };

  const normalized = String(value).trim();
  const isHttp = normalized.startsWith('http://') || normalized.startsWith('https://');
  const isRelative = allowRelative && normalized.startsWith('/');
  if (!isHttp && !isRelative) {
    return { ok: false, message: `${fieldName} must start with https://, http://, or /` };
  }

  return { ok: true, value: normalized };
}

function normalizeCoverImageInput(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };

  if (typeof value === 'string') {
    const url = value.trim();
    if (!url) return { ok: true, value: null };
    return { ok: true, value: { url, publicId: null, alt: null } };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'coverImage must be a string or object' };
  }

  const url = normalizeOptionalString(value.url);
  const publicId = normalizeOptionalString(value.publicId);
  const alt = normalizeOptionalString(value.alt);

  if (!url) return { ok: false, message: 'coverImage.url is required' };

  return {
    ok: true,
    value: {
      url,
      publicId: publicId || null,
      alt: alt || null,
    },
  };
}

function isItemInSchedule(item, now = new Date()) {
  const startParsed = parseDateMaybe(item && item.startAt);
  const endParsed = parseDateMaybe(item && item.endAt);

  if (!startParsed.ok || !endParsed.ok) return false;
  const startAt = startParsed.date;
  const endAt = endParsed.date;

  if (startAt && now.getTime() < startAt.getTime()) return false;
  if (endAt && now.getTime() > endAt.getTime()) return false;
  return true;
}

module.exports = {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  normalizePlacementKey,
  normalizeOptionalString,
  normalizeOptionalBoolean,
  parseOptionalDate,
  parseOptionalNumber,
  validateOptionalUrlLike,
  normalizeCoverImageInput,
  isItemInSchedule,
};