const mongoose = require('mongoose');

const AdSettings = require('../models/AdSettings');

const DEFAULT_SLOT_ENABLED = {
  HOME_728x90: true,
  HOME_RIGHT_300x250: true,
};

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function normalizeSlotEnabled(raw) {
  const out = { ...DEFAULT_SLOT_ENABLED };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.HOME_728x90 === 'boolean') out.HOME_728x90 = raw.HOME_728x90;
  if (typeof raw.HOME_RIGHT_300x250 === 'boolean') out.HOME_RIGHT_300x250 = raw.HOME_RIGHT_300x250;
  return out;
}

function validateSlotEnabled(slotEnabled) {
  if (!slotEnabled || typeof slotEnabled !== 'object' || Array.isArray(slotEnabled)) {
    return { ok: false, message: 'slotEnabled must be an object' };
  }
  if (typeof slotEnabled.HOME_728x90 !== 'boolean') return { ok: false, message: 'slotEnabled.HOME_728x90 must be boolean' };
  if (typeof slotEnabled.HOME_RIGHT_300x250 !== 'boolean') return { ok: false, message: 'slotEnabled.HOME_RIGHT_300x250 must be boolean' };
  return { ok: true };
}

async function getOrCreateSlotEnabled() {
  if (!isDbReady()) {
    // If DB is down, keep API stable.
    return { ...DEFAULT_SLOT_ENABLED };
  }

  const doc = await AdSettings.findByIdAndUpdate(
    'global',
    { $setOnInsert: { _id: 'global' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : null);
}

function validateSlotEnabledPayload(slotEnabled) {
  const v = validateSlotEnabled(slotEnabled);
  if (!v.ok) return { ok: false, code: 'INVALID_BODY', message: v.message };
  return { ok: true };
}

// ---------------- ADMIN ----------------

async function getAdminAdSettings(req, res) {
  try {
    const slotEnabled = await getOrCreateSlotEnabled();
    return res.status(200).json({ ok: true, slotEnabled });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to load ad settings' });
  }
}

async function updateAdminAdSettings(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const slotEnabled = body.slotEnabled;

    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }

    const v = validateSlotEnabledPayload(slotEnabled);
    if (!v.ok) {
      return res.status(400).json({ ok: false, code: v.code, message: v.message });
    }

    const incoming = {
      HOME_728x90: slotEnabled.HOME_728x90,
      HOME_RIGHT_300x250: slotEnabled.HOME_RIGHT_300x250,
    };

    const doc = await AdSettings.findByIdAndUpdate(
      'global',
      { $set: { slotEnabled: incoming } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    const saved = normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : incoming);
    return res.status(200).json({ ok: true, slotEnabled: saved });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to update ad settings' });
  }
}

// ---------------- PUBLIC ----------------

async function getPublicAdSettings(req, res) {
  try {
    const slotEnabled = await getOrCreateSlotEnabled();
    return res.status(200).json({ ok: true, slotEnabled });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to load ad settings' });
  }
}

module.exports = {
  getAdminAdSettings,
  updateAdminAdSettings,
  getPublicAdSettings,
};
