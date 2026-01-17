const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');

const CHANNELS = new Set(['breaking', 'live']);
const MODES = new Set(['auto', 'force_on', 'force_off', 'off']);

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function nowMinus24h() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function defaultSettingsDocShape() {
  return {
    breaking: { enabled: false, mode: 'auto', speedSec: 8 },
    live: { enabled: false, mode: 'auto', speedSec: 8 },
    // Keep legacy fields initialized for older callers
    breakingEnabled: false,
    liveEnabled: false,
    breakingMode: 'manual',
    liveMode: 'auto',
    updatedAt: new Date(),
  };
}

function normalizeChannel(v) {
  const s = String(v || '').trim().toLowerCase();
  return CHANNELS.has(s) ? s : null;
}

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!MODES.has(s)) return null;
  // Compatibility alias from tickers settings UI.
  if (s === 'off') return 'force_off';
  return s;
}

function normalizeModeForDoc(rawMode, explicitEnabled) {
  const s = String(rawMode || '').trim().toLowerCase();

  // Historical values seen in older deployments.
  if (s === 'off') return 'force_off';
  if (s === 'manual') return explicitEnabled ? 'force_on' : 'force_off';

  return normalizeMode(s) || 'auto';
}

function normalizeSpeedSec(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  // Tickers settings UI supports up to 120s.
  if (rounded < 2 || rounded > 120) return null;
  return rounded;
}

function normalizeText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (s.length > 160) return null;
  return s;
}

function applyLegacyMirrors(doc) {
  // Keep legacy fields aligned for existing endpoints/UI.
  // Legacy "manual" roughly maps to force_off/force_on depending on enabled.
  // We preserve existing legacy fields but update the basic enabled mirrors.
  if (!doc) return;

  const breakingEnabled = Boolean(doc.breaking?.enabled);
  const liveEnabled = Boolean(doc.live?.enabled);

  doc.breakingEnabled = breakingEnabled;
  doc.liveEnabled = liveEnabled;

  // Preserve existing legacy mode semantics if already set; otherwise choose a safe mapping.
  if (!doc.breakingMode) doc.breakingMode = breakingEnabled ? 'auto' : 'manual';
  if (!doc.liveMode) doc.liveMode = liveEnabled ? 'auto' : 'manual';
}

async function getOrCreateSettings() {
  if (!isDbReady()) return null;

  let doc = await BroadcastSettings.findOne({});
  if (!doc) {
    try {
      doc = await BroadcastSettings.create(defaultSettingsDocShape());
    } catch (_) {
      doc = await BroadcastSettings.findOne({});
    }
  }

  // If the doc exists but doesn't have new fields (older DB), backfill defaults.
  const changed =
    !doc.breaking || typeof doc.breaking !== 'object' ||
    !doc.live || typeof doc.live !== 'object';

  if (changed) {
    doc.breaking = doc.breaking && typeof doc.breaking === 'object' ? doc.breaking : { enabled: Boolean(doc.breakingEnabled), mode: 'auto', speedSec: 8 };
    doc.live = doc.live && typeof doc.live === 'object' ? doc.live : { enabled: Boolean(doc.liveEnabled), mode: 'auto', speedSec: 8 };
  }

  // Normalize to schema-valid values to avoid enum validation errors on future saves.
  // Note: existing DBs may contain legacy values like "off" or "manual".
  const normalizedBreakingMode = normalizeModeForDoc(doc.breaking?.mode, Boolean(doc.breaking?.enabled));
  const normalizedLiveMode = normalizeModeForDoc(doc.live?.mode, Boolean(doc.live?.enabled));
  if (doc.breaking?.mode !== normalizedBreakingMode) {
    doc.breaking.mode = normalizedBreakingMode;
  }
  if (doc.live?.mode !== normalizedLiveMode) {
    doc.live.mode = normalizedLiveMode;
  }

  applyLegacyMirrors(doc);

  if (changed) {
    try { await doc.save(); } catch (_) {}
  }

  return doc;
}

function computeEffectiveEnabled(explicitEnabled, mode, itemsCount) {
  // If explicitly disabled, always stay off.
  if (explicitEnabled === false) return false;

  const m = normalizeMode(mode) || 'auto';
  if (m === 'force_off') return false;
  if (m === 'force_on') return true;
  // auto
  return itemsCount > 0;
}

async function listItemsLast24hByChannel() {
  if (!isDbReady()) {
    return { breaking: [], live: [] };
  }

  const since = nowMinus24h();
  const now = new Date();
  const notExpired = {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gte: now } },
    ],
  };
  const [breaking, live] = await Promise.all([
    BroadcastItem.find({ type: 'breaking', createdAt: { $gte: since }, ...notExpired }).sort({ createdAt: -1 }).lean(),
    BroadcastItem.find({ type: 'live', createdAt: { $gte: since }, ...notExpired }).sort({ createdAt: -1 }).lean(),
  ]);

  return { breaking, live };
}

async function createItem(channel, text) {
  if (!isDbReady()) {
    return { ok: false, status: 503, message: 'Database unavailable' };
  }

  const ch = normalizeChannel(channel);
  if (!ch) return { ok: false, status: 400, message: 'Invalid channel. Expected breaking|live' };

  const t = normalizeText(text);
  if (!t) return { ok: false, status: 400, message: 'Invalid text. Must be non-empty and <= 160 chars' };

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const created = await BroadcastItem.create({ type: ch, text: t, expiresAt });
  return { ok: true, status: 201, item: created };
}

async function deleteItemById(id) {
  if (!isDbReady()) {
    return { ok: false, status: 503, message: 'Database unavailable' };
  }

  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, status: 404, message: 'Not found' };
  }

  const deleted = await BroadcastItem.findByIdAndDelete(id).lean();
  if (!deleted) return { ok: false, status: 404, message: 'Not found' };

  return { ok: true, status: 200 };
}

async function patchSettings(payload) {
  if (!isDbReady()) {
    return { ok: false, status: 503, message: 'Database unavailable' };
  }

  const doc = await getOrCreateSettings();
  if (!doc) return { ok: false, status: 503, message: 'Database unavailable' };

  const body = payload && typeof payload === 'object' ? payload : {};

  for (const channel of ['breaking', 'live']) {
    const next = body[channel];
    if (!next || typeof next !== 'object') continue;

    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) {
      doc[channel].enabled = Boolean(next.enabled);
    }

    if (Object.prototype.hasOwnProperty.call(next, 'mode')) {
      const m = normalizeMode(next.mode);
      if (!m) return { ok: false, status: 400, message: `Invalid ${channel}.mode. Expected auto|force_on|force_off` };
      doc[channel].mode = m;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speedSec')) {
      const s = normalizeSpeedSec(next.speedSec);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.speedSec. Expected 2..30` };
      doc[channel].speedSec = s;
    }
  }

  applyLegacyMirrors(doc);
  await doc.save();

  return { ok: true, status: 200, settings: doc.toObject({ virtuals: true }) };
}

function adminSettingsResponse(doc) {
  const d = doc && typeof doc === 'object' ? doc : defaultSettingsDocShape();
  const breaking = d.breaking && typeof d.breaking === 'object' ? d.breaking : { enabled: false, mode: 'auto', speedSec: 8 };
  const live = d.live && typeof d.live === 'object' ? d.live : { enabled: false, mode: 'auto', speedSec: 8 };

  return {
    breaking: {
      enabled: Boolean(breaking.enabled),
      mode: normalizeMode(breaking.mode) || 'auto',
      speedSec: normalizeSpeedSec(breaking.speedSec) ?? 8,
    },
    live: {
      enabled: Boolean(live.enabled),
      mode: normalizeMode(live.mode) || 'auto',
      speedSec: normalizeSpeedSec(live.speedSec) ?? 8,
    },
    updatedAt: d.updatedAt || null,
  };
}

async function computePublicPayload() {
  const settingsDoc = await getOrCreateSettings();
  const settings = adminSettingsResponse(settingsDoc || defaultSettingsDocShape());

  const itemsByChannel = await listItemsLast24hByChannel();

  const breakingItems = Array.isArray(itemsByChannel.breaking) ? itemsByChannel.breaking : [];
  const liveItems = Array.isArray(itemsByChannel.live) ? itemsByChannel.live : [];

  const breakingEnabled = computeEffectiveEnabled(settings.breaking.enabled, settings.breaking.mode, breakingItems.length);
  const liveEnabled = computeEffectiveEnabled(settings.live.enabled, settings.live.mode, liveItems.length);

  const mapPublicItem = (doc) => {
    const d = doc && typeof doc === 'object' ? doc : {};
    const id = d._id ? String(d._id) : undefined;
    return {
      id,
      _id: id,
      type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
      text: typeof d.text === 'string' ? d.text : '',
      createdAt: d.createdAt || null,
      expiresAt: d.expiresAt || null,
    };
  };

  return {
    ok: true,
    _meta: {
      hasSettings: true,
    },
    settings,
    items: {
      breaking: breakingItems.map(mapPublicItem),
      live: liveItems.map(mapPublicItem),
    },
    data: {
      settings,
      items: {
        breaking: breakingItems.map(mapPublicItem),
        live: liveItems.map(mapPublicItem),
      },
    },
    breaking: {
      enabled: breakingEnabled,
      speedSec: settings.breaking.speedSec,
      items: breakingItems.map(i => String(i.text || '')).filter(Boolean),
    },
    live: {
      enabled: liveEnabled,
      speedSec: settings.live.speedSec,
      items: liveItems.map(i => String(i.text || '')).filter(Boolean),
    },
  };
}

module.exports = {
  normalizeChannel,
  getOrCreateSettings,
  adminSettingsResponse,
  listItemsLast24hByChannel,
  createItem,
  deleteItemById,
  patchSettings,
  computePublicPayload,
  computeEffectiveEnabled,
};
