const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const AdSettings = require('../models/AdSettings');
const { buildSlotEnabledDefaults, AD_SLOTS } = require('../src/constants/adSlots');

const DEFAULT_SLOT_ENABLED = buildSlotEnabledDefaults(true, {
  HOME_RIGHT_300x600: false,
  HOME_BILLBOARD_970x250: false,
  BREAKING_SPONSOR: false,
  LIVE_UPDATE_SPONSOR: false,
});

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'ad-settings.json');

function isDbReady() {
  return typeof mongoose?.connection?.readyState === 'number' && mongoose.connection.readyState === 1;
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

  // Safety default for newly-added slots: if the persisted record predates the slot key,
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
  if (typeof raw.BREAKING_SPONSOR !== 'boolean') {
    out.BREAKING_SPONSOR = false;
  }
  if (typeof raw.LIVE_UPDATE_SPONSOR !== 'boolean') {
    out.LIVE_UPDATE_SPONSOR = false;
  }

  // Alias: HOME_RIGHT_RAIL should behave exactly like HOME_RIGHT_300x250.
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

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function readFromFile() {
  ensureDataDir();
  try {
    if (!fs.existsSync(FILE_PATH)) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(DEFAULT_SLOT_ENABLED, null, 2), 'utf8');
      return { ...DEFAULT_SLOT_ENABLED };
    }
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeSlotEnabled(parsed);

    // Self-heal file if invalid shape
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(normalized, null, 2), 'utf8');
    }

    return normalized;
  } catch (e) {
    // Last resort
    try {
      fs.writeFileSync(FILE_PATH, JSON.stringify(DEFAULT_SLOT_ENABLED, null, 2), 'utf8');
    } catch (_) {}
    return { ...DEFAULT_SLOT_ENABLED };
  }
}

function writeToFile(slotEnabled) {
  ensureDataDir();
  const normalized = normalizeSlotEnabled(slotEnabled);
  fs.writeFileSync(FILE_PATH, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

async function readSettings() {
  if (isDbReady()) {
    try {
      const doc = await AdSettings.findByIdAndUpdate(
        'global',
        { $setOnInsert: { _id: 'global' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : null);
    } catch (e) {
      // fall through to file
      console.warn('[ad-settings][store] mongo read failed; falling back to file', e?.message || e);
    }
  }

  return readFromFile();
}

async function saveSettings(slotEnabled) {
  const v = validateSlotEnabled(slotEnabled);
  if (!v.ok) {
    const err = new Error(v.message);
    err.status = 400;
    throw err;
  }

  const normalized = normalizeSlotEnabled(slotEnabled);

  if (isDbReady()) {
    try {
      const doc = await AdSettings.findByIdAndUpdate(
        'global',
        { $set: { slotEnabled: normalized } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return normalizeSlotEnabled(doc && typeof doc === 'object' ? doc.slotEnabled : normalized);
    } catch (e) {
      console.warn('[ad-settings][store] mongo save failed; falling back to file', e?.message || e);
      // fall through
    }
  }

  return writeToFile(normalized);
}

module.exports = {
  DEFAULT_SLOT_ENABLED,
  FILE_PATH,
  readSettings,
  saveSettings,
  validateSlotEnabled,
  normalizeSlotEnabled,
};
