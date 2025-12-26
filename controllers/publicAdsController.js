const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const AdSettings = require('../models/AdSettings');
const { normalizeSlot, isValidObjectId } = require('../lib/ads');

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const DEFAULT_SLOT_ENABLED = {
  HOME_728x90: true,
  HOME_RIGHT_300x250: true,
};

function normalizeSlotEnabled(raw) {
  const out = { ...DEFAULT_SLOT_ENABLED };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.HOME_728x90 === 'boolean') out.HOME_728x90 = raw.HOME_728x90;
  if (typeof raw.HOME_RIGHT_300x250 === 'boolean') out.HOME_RIGHT_300x250 = raw.HOME_RIGHT_300x250;
  return out;
}

async function getSlotEnabled() {
  // If DB is offline, default to enabled so public pages don't break.
  if (!isDbReady()) return { ...DEFAULT_SLOT_ENABLED };
  const doc = await AdSettings.findByIdAndUpdate(
    'global',
    { $setOnInsert: { _id: 'global' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : null);
}

function toPublicAdDto(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    slot: doc.slot,
    title: doc.title || '',
    imageUrl: doc.imageUrl,
    isClickable: doc.isClickable !== false,
    targetUrl: doc.targetUrl,
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    updatedAt: doc.updatedAt || null,
  };
}

// GET /api/public/ads?slot=HOME_728x90
async function getActiveAd(req, res) {
  const slot = normalizeSlot(req.query && req.query.slot);
  res.set('Cache-Control', 'no-store');

  if (!slot) {
    return res.status(400).json({ ok: false, message: 'Invalid or missing slot' });
  }

  // In test/local-no-db mode, keep a stable shape (avoid buffering timeouts)
  if (!isDbReady()) {
    return res.status(200).json({ ok: true, ad: null });
  }

  // Respect global ad slot disable switches
  const slotEnabled = await getSlotEnabled();
  if (Object.prototype.hasOwnProperty.call(slotEnabled, slot) && slotEnabled[slot] === false) {
    return res.status(200).json({ ok: true, ad: null });
  }

  const now = new Date();

  const ad = await Ad.findOne({
    slot,
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] },
    ],
  })
    .sort({ priority: -1, updatedAt: -1 })
    .lean();

  return res.status(200).json({ ok: true, ad: toPublicAdDto(ad) });
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
