const mongoose = require('mongoose');

const AdSettings = require('../models/AdSettings');
const { buildSlotEnabledDefaults, AD_SLOTS } = require('../src/constants/adSlots');

const DEFAULT_SLOT_ENABLED = buildSlotEnabledDefaults(true);

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function normalizeSlotEnabled(raw) {
  if (raw && typeof raw === 'object' && typeof raw.get === 'function' && typeof raw.entries === 'function') {
    raw = Object.fromEntries(Array.from(raw.entries()));
  }
  const out = { ...DEFAULT_SLOT_ENABLED };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of AD_SLOTS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }

  // Safety default for newly-added slots: if the stored/payload record predates the slot key,
  // treat it as disabled until explicitly enabled.
  if (typeof raw.FOOTER_BANNER_728x90 !== 'boolean') {
    out.FOOTER_BANNER_728x90 = false;
  }

  // Alias: HOME_RIGHT_RAIL should behave exactly like HOME_RIGHT_300x250.
  // If only legacy key exists, treat it as canonical.
  if (typeof raw.HOME_RIGHT_300x250 !== 'boolean' && typeof raw.HOME_RIGHT_RAIL === 'boolean') {
    out.HOME_RIGHT_300x250 = raw.HOME_RIGHT_RAIL;
  }
  out.HOME_RIGHT_RAIL = out.HOME_RIGHT_300x250;

  return out;
}

function validateSlotEnabled(slotEnabled) {
  if (!slotEnabled || typeof slotEnabled !== 'object' || Array.isArray(slotEnabled)) {
    return { ok: false, message: 'slotEnabled must be an object' };
  }
  for (const key of AD_SLOTS) {
    if (typeof slotEnabled[key] !== 'boolean') return { ok: false, message: `slotEnabled.${key} must be boolean` };
  }
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

  const normalized = normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : null);

  // Self-heal: existing docs created before new slots were added won't get schema defaults.
  // Backfill missing keys once so future reads/writes are consistent.
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
    // Best-effort backfill; ignore errors.
  }

  return normalized;
}

function validateSlotEnabledPayload(slotEnabled) {
  if (!slotEnabled || typeof slotEnabled !== 'object' || Array.isArray(slotEnabled)) {
    return { ok: false, code: 'INVALID_BODY', message: 'slotEnabled must be an object' };
  }

  // Backward-compatible: allow missing keys (we backfill defaults), but if a key
  // is provided it must be a boolean.
  for (const key of AD_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(slotEnabled, key) && typeof slotEnabled[key] !== 'boolean') {
      return { ok: false, code: 'INVALID_BODY', message: `slotEnabled.${key} must be boolean` };
    }
  }

  return { ok: true };
}

// ---------------- ADMIN ----------------

async function getAdminAdSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
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
    if (!v.ok) return res.status(400).json({ ok: false, code: v.code, message: v.message });

    const incoming = normalizeSlotEnabled(slotEnabled);

    // After normalization, all keys must be boolean.
    const strict = validateSlotEnabled(incoming);
    if (!strict.ok) return res.status(400).json({ ok: false, code: 'INVALID_BODY', message: strict.message });

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
