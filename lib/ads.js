const mongoose = require('mongoose');

// Publicly supported ad slots
const AD_SLOTS = Object.freeze([
  'HOME_728x90',
  'HOME_RIGHT_300x250',
  'HOME_RIGHT_RAIL',
  'ARTICLE_INLINE',
]);

function normalizeSlot(value) {
  const slot = String(value || '').trim();
  return AD_SLOTS.includes(slot) ? slot : null;
}

function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ''));
}

function validateImageUrl(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: false, message: 'imageUrl is required' };
  if (!(v.startsWith('https://') || v.startsWith('http://'))) {
    return { ok: false, message: 'imageUrl must start with https:// or http://' };
  }
  return { ok: true, value: v };
}

function validateTargetUrl(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: false, message: 'targetUrl is required' };
  if (!(v.startsWith('https://') || v.startsWith('http://'))) {
    return { ok: false, message: 'targetUrl must start with https:// or http://' };
  }
  return { ok: true, value: v };
}

function validateOptionalTargetUrl(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: true, value: null };
  if (!(v.startsWith('https://') || v.startsWith('http://'))) {
    return { ok: false, message: 'targetUrl must start with https:// or http://' };
  }
  return { ok: true, value: v };
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, message: `${fieldName} must be a valid date` };
  }
  return { ok: true, value: d };
}

function parseOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, message: `${fieldName} must be a number` };
  return { ok: true, value: n };
}

module.exports = {
  AD_SLOTS,
  normalizeSlot,
  isValidObjectId,
  validateImageUrl,
  validateTargetUrl,
  validateOptionalTargetUrl,
  parseOptionalDate,
  parseOptionalNumber,
};
