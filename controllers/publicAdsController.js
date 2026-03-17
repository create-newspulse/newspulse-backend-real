const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const AdSettings = require('../models/AdSettings');
const { normalizeSlot, isValidObjectId, parseDateMaybe } = require('../lib/ads');
const { buildSlotEnabledDefaults, AD_SLOTS } = require('../src/constants/adSlots');

const DEBUG_PUBLIC_AD_SLOTS = new Set(['HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250']);

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const DEFAULT_SLOT_ENABLED = {
  ...buildSlotEnabledDefaults(true, {
    HOME_RIGHT_300x600: false,
    HOME_BILLBOARD_970x250: false,
  }),
};

function normalizeSlotEnabled(raw) {
  if (raw && typeof raw === 'object' && typeof raw.get === 'function' && typeof raw.entries === 'function') {
    raw = Object.fromEntries(Array.from(raw.entries()));
  }
  const out = { ...DEFAULT_SLOT_ENABLED };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of AD_SLOTS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }

  // Safety default for newly-added slots: if the DB record predates the slot key,
  // treat it as disabled until explicitly enabled.
  if (typeof raw.FOOTER_BANNER_728x90 !== 'boolean') {
    out.FOOTER_BANNER_728x90 = false;
  }
  if (typeof raw.HOME_RIGHT_300x600 !== 'boolean') {
    out.HOME_RIGHT_300x600 = false;
  }
  if (typeof raw.HOME_BILLBOARD_970x250 !== 'boolean') {
    out.HOME_BILLBOARD_970x250 = false;
  }

  // Alias: HOME_RIGHT_RAIL should behave exactly like HOME_RIGHT_300x250.
  // If only legacy key exists, treat it as canonical.
  if (typeof raw.HOME_RIGHT_300x250 !== 'boolean' && typeof raw.HOME_RIGHT_RAIL === 'boolean') {
    out.HOME_RIGHT_300x250 = raw.HOME_RIGHT_RAIL;
  }
  out.HOME_RIGHT_RAIL = out.HOME_RIGHT_300x250;

  return out;
}

async function getSlotEnabled() {
  // If DB is offline, default to enabled so public pages don't break.
  if (!isDbReady()) return { ...DEFAULT_SLOT_ENABLED };
  const q = AdSettings.findByIdAndUpdate(
    'global',
    { $setOnInsert: { _id: 'global' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const doc = q && typeof q.lean === 'function' ? await q.lean() : await q;

  const normalized = normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : null);

  // Best-effort backfill for older docs missing newer slot keys.
  try {
    const raw = doc && typeof doc === 'object' ? (doc.slotEnabled || null) : null;
    let needsBackfill = false;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      needsBackfill = true;
    } else {
      for (const key of AD_SLOTS) {
        if (typeof raw[key] !== 'boolean') {
          needsBackfill = true;
          break;
        }
      }
    }
    if (needsBackfill) {
      await AdSettings.updateOne(
        { _id: 'global' },
        { $set: { slotEnabled: normalized } },
      );
    }
  } catch (_) {
    // ignore
  }

  return normalized;
}

function _isDevLogEnabled() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return env === '' || env === 'development' || env === 'dev';
}

function toPublicAdDto(doc) {
  if (!doc) return null;
  const startParsed = parseDateMaybe(doc.startAt);
  const endParsed = parseDateMaybe(doc.endAt);
  return {
    id: String(doc._id),
    slot: normalizeSlot(doc.slot) || doc.slot,
    title: doc.title || '',
    imageUrl: doc.imageUrl,
    isClickable: doc.isClickable !== false,
    targetUrl: doc.targetUrl,
    startAt: startParsed.ok ? (startParsed.date || null) : null,
    endAt: endParsed.ok ? (endParsed.date || null) : null,
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    updatedAt: doc.updatedAt || null,
  };
}

function _isInSchedule(ad, now) {
  const startParsed = parseDateMaybe(ad.startAt);
  const endParsed = parseDateMaybe(ad.endAt);

  if (!startParsed.ok || !endParsed.ok) {
    return { ok: true, inSchedule: false, reason: 'invalid_schedule' };
  }

  const startAt = startParsed.date;
  const endAt = endParsed.date;

  if (startAt && now.getTime() < startAt.getTime()) {
    return { ok: true, inSchedule: false, reason: 'not_started' };
  }

  if (endAt && now.getTime() > endAt.getTime()) {
    return { ok: true, inSchedule: false, reason: 'ended' };
  }

  return { ok: true, inSchedule: true, reason: 'in_window' };
}

// GET /api/public/ads?slot=HOME_728x90
async function getActiveAd(req, res) {
  const slot = normalizeSlot(req.query && req.query.slot);
  // Ads should never be cached (admin updates must reflect immediately).
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const devLog = _isDevLogEnabled();
  const shouldDebugSlot = DEBUG_PUBLIC_AD_SLOTS.has(slot);

  if (devLog && shouldDebugSlot) {
    // eslint-disable-next-line no-console
    console.log('[public-ads][debug][incoming]', {
      slot,
      rawSlot: req.query && req.query.slot,
    });
  }

  if (!slot) {
    // Never 400 for public callers; keep console noise down.
    return res.status(200).json({ ok: false, enabled: false, ad: null });
  }

  const querySlots = slot === 'HOME_RIGHT_300x250'
    ? ['HOME_RIGHT_300x250', 'HOME_RIGHT_RAIL']
    : [slot];

  // In test/local-no-db mode, keep a stable shape (avoid buffering timeouts)
  if (!isDbReady()) {
    return res.status(200).json({ ok: false, enabled: true, ad: null });
  }

  // Respect global ad slot disable switches
  const slotEnabled = await getSlotEnabled();
  if (devLog && shouldDebugSlot) {
    // eslint-disable-next-line no-console
    console.log('[public-ads][debug][slot-enabled]', {
      slot,
      slotKeys: Object.keys(slotEnabled || {}),
      enabledValue: slotEnabled ? slotEnabled[slot] : undefined,
    });
  }
  if (devLog) {
    const enabledVal = Object.prototype.hasOwnProperty.call(slotEnabled, slot) ? slotEnabled[slot] : undefined;
    // eslint-disable-next-line no-console
    console.log('[public-ads]', {
      slot,
      slotEnabled: enabledVal,
    });
  }
  if (Object.prototype.hasOwnProperty.call(slotEnabled, slot) && slotEnabled[slot] === false) {
    return res.status(200).json({ ok: false, enabled: false, ad: null });
  }

  const now = new Date();

  // Important: legacy data may store startAt/endAt as strings (e.g. "DD-MM-YYYY HH:mm").
  // Comparing those in Mongo will not behave correctly. Fetch then filter in JS using parseDateMaybe.
  const candidates = await Ad.find({ slot: { $in: querySlots }, isActive: true })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(100)
    .lean();

  const inSchedule = [];
  for (const a of candidates) {
    const sched = _isInSchedule(a, now);
    if (sched.ok && sched.inSchedule) inSchedule.push(a);
  }

  const ad = inSchedule.length > 0 ? inSchedule[0] : null;

  if (devLog && shouldDebugSlot) {
    // eslint-disable-next-line no-console
    console.log('[public-ads][debug][selected]', {
      slot,
      activeAdFound: !!ad,
      candidates: candidates.length,
      inSchedule: inSchedule.length,
    });
  }

  if (devLog) {
    // eslint-disable-next-line no-console
    console.log('[public-ads][select]', {
      slot,
      candidates: candidates.length,
      inSchedule: inSchedule.length,
      selected: ad
        ? {
          id: String(ad._id),
          title: ad.title || '',
          priority: typeof ad.priority === 'number' ? ad.priority : 0,
        }
        : null,
    });
  }

  if (!ad) {
    return res.status(200).json({ ok: false, enabled: true, ad: null });
  }

  // Best-effort: if legacy string dates were parsed successfully, normalize stored types.
  try {
    const startParsed = parseDateMaybe(ad.startAt);
    const endParsed = parseDateMaybe(ad.endAt);
    const needsStart = startParsed.ok && startParsed.date instanceof Date && !(ad.startAt instanceof Date);
    const needsEnd = endParsed.ok && endParsed.date instanceof Date && !(ad.endAt instanceof Date);
    if (needsStart || needsEnd) {
      const $set = {};
      if (needsStart) $set.startAt = startParsed.date;
      if (needsEnd) $set.endAt = endParsed.date;
      await Ad.updateOne({ _id: ad._id }, { $set });
    }
  } catch (_) {
    // ignore
  }

  return res.status(200).json({ ok: true, enabled: true, ad: toPublicAdDto(ad) });
}

async function postImpression(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ ok: false, message: 'Invalid id' });
  }
  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  const updated = await Ad.findByIdAndUpdate(
    id,
    { $inc: { 'stats.impressions': 1 } },
    { new: true, projection: { _id: 1 } },
  );

  if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });
  return res.status(200).json({ ok: true });
}

async function postClick(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ ok: false, message: 'Invalid id' });
  }
  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  const doc = await Ad.findById(id).select({ isClickable: 1 }).lean();
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  if (doc.isClickable === false) {
    return res.status(200).json({ ok: true, message: 'not clickable' });
  }

  await Ad.updateOne({ _id: id }, { $inc: { 'stats.clicks': 1 } });
  return res.status(200).json({ ok: true });
}

module.exports = {
  getActiveAd,
  postImpression,
  postClick,
};
