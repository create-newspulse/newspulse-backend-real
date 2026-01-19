const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');

const CHANNELS = new Set(['breaking', 'live']);
const MODES = new Set(['auto', 'force_on', 'force_off', 'off']);

// Broadcast Center UI presets should not accidentally disable tickers.
// Clamp scroll duration (seconds) to a safe, readable range.
function clampScrollDurationSeconds(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  // Spec: 12–30 seconds recommended.
  return Math.min(30, Math.max(12, rounded));
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function nowMinus24h() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function defaultSettingsDocShape() {
  return {
    breaking: { enabled: false, mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 },
    live: { enabled: false, mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 },
    // Keep legacy fields initialized for older callers
    breakingEnabled: false,
    liveEnabled: false,
    breakingDurationSeconds: 12,
    liveDurationSeconds: 12,
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

function normalizeModeForPatch(v) {
  const s = String(v || '').trim().toLowerCase();
  // Historical values from older UIs.
  if (s === 'off') return 'force_off';
  if (s === 'manual') return 'force_on';
  return normalizeMode(s);
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

function clampTickerSpeedSeconds(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  // Broadcast Center requirement: 12..45 seconds.
  return Math.min(45, Math.max(12, rounded));
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

  // Phase 1: durationSeconds is the UI-facing field name; mirror from tickerSpeedSeconds.
  try {
    const b = doc.breaking && typeof doc.breaking === 'object' ? doc.breaking : {};
    const l = doc.live && typeof doc.live === 'object' ? doc.live : {};
    const bd = clampTickerSpeedSeconds(b.tickerSpeedSeconds ?? b.speedSec) ?? 12;
    const ld = clampTickerSpeedSeconds(l.tickerSpeedSeconds ?? l.speedSec) ?? 12;
    doc.breakingDurationSeconds = bd;
    doc.liveDurationSeconds = ld;
  } catch (_) {}

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
    doc.breaking = doc.breaking && typeof doc.breaking === 'object' ? doc.breaking : { enabled: Boolean(doc.breakingEnabled), mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 };
    doc.live = doc.live && typeof doc.live === 'object' ? doc.live : { enabled: Boolean(doc.liveEnabled), mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 };
  }

  // Backfill tickerSpeedSeconds from legacy speedSec if missing.
  if (doc.breaking && typeof doc.breaking === 'object') {
    if (typeof doc.breaking.tickerSpeedSeconds !== 'number' || !Number.isFinite(doc.breaking.tickerSpeedSeconds)) {
      const legacy = normalizeSpeedSec(doc.breaking.speedSec) ?? 12;
      doc.breaking.tickerSpeedSeconds = clampTickerSpeedSeconds(legacy) ?? 12;
    }
    // Keep speedSec mirrored for older callers.
    doc.breaking.speedSec = normalizeSpeedSec(doc.breaking.speedSec) ?? doc.breaking.tickerSpeedSeconds;
  }
  if (doc.live && typeof doc.live === 'object') {
    if (typeof doc.live.tickerSpeedSeconds !== 'number' || !Number.isFinite(doc.live.tickerSpeedSeconds)) {
      const legacy = normalizeSpeedSec(doc.live.speedSec) ?? 12;
      doc.live.tickerSpeedSeconds = clampTickerSpeedSeconds(legacy) ?? 12;
    }
    doc.live.speedSec = normalizeSpeedSec(doc.live.speedSec) ?? doc.live.tickerSpeedSeconds;
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

function computePublicEnabled(explicitEnabled, mode) {
  // Public site should not flip enabled off just because items are temporarily empty.
  // Only explicit disable or force_off disables.
  if (explicitEnabled === false) return false;
  const m = normalizeMode(mode) || 'auto';
  if (m === 'force_off') return false;
  if (m === 'force_on') return true;
  // auto: honor explicit flag only (no dependency on items).
  return Boolean(explicitEnabled);
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
    BroadcastItem.find({ type: 'breaking', isLive: true, createdAt: { $gte: since }, ...notExpired }).sort({ createdAt: -1 }).limit(50).lean(),
    BroadcastItem.find({ type: 'live', isLive: true, createdAt: { $gte: since }, ...notExpired }).sort({ createdAt: -1 }).limit(50).lean(),
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

  // Soft-delete (treat isLive as isActive) so admin UI stops showing it immediately.
  const updated = await BroadcastItem.findByIdAndUpdate(id, { $set: { isLive: false } }, { new: true }).lean();
  if (!updated) return { ok: false, status: 404, message: 'Not found' };

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
      const m = normalizeModeForPatch(next.mode);
      if (!m) return { ok: false, status: 400, message: `Invalid ${channel}.mode. Expected auto|force_on|force_off` };
      doc[channel].mode = m;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speedSec')) {
      const s = clampScrollDurationSeconds(next.speedSec);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.tickerSpeedSeconds. Expected number` };
      doc[channel].tickerSpeedSeconds = s;
      doc[channel].speedSec = s;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'tickerSpeedSeconds')) {
      const s = clampScrollDurationSeconds(next.tickerSpeedSeconds);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.tickerSpeedSeconds. Expected number` };
      doc[channel].tickerSpeedSeconds = s;
      doc[channel].speedSec = s;
    }

    // Phase 1 UI alias
    if (Object.prototype.hasOwnProperty.call(next, 'durationSeconds')) {
      const s = clampScrollDurationSeconds(next.durationSeconds);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.durationSeconds. Expected number` };
      doc[channel].tickerSpeedSeconds = s;
      doc[channel].speedSec = s;
    }

    // Requested field name from admin panel: scrollDurationSeconds
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSeconds')) {
      const s = clampScrollDurationSeconds(next.scrollDurationSeconds);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.scrollDurationSeconds. Expected number` };
      doc[channel].tickerSpeedSeconds = s;
      doc[channel].speedSec = s;
    }

    // Also accept scrollDurationSec
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSec')) {
      const s = clampScrollDurationSeconds(next.scrollDurationSec);
      if (s === null) return { ok: false, status: 400, message: `Invalid ${channel}.scrollDurationSec. Expected number` };
      doc[channel].tickerSpeedSeconds = s;
      doc[channel].speedSec = s;
    }
  }

  applyLegacyMirrors(doc);
  await doc.save();

  return { ok: true, status: 200, settings: doc.toObject({ virtuals: true }) };
}

function adminSettingsResponse(doc) {
  const d = doc && typeof doc === 'object' ? doc : defaultSettingsDocShape();
  const breaking = d.breaking && typeof d.breaking === 'object' ? d.breaking : { enabled: false, mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 };
  const live = d.live && typeof d.live === 'object' ? d.live : { enabled: false, mode: 'auto', tickerSpeedSeconds: 12, speedSec: 12 };

  const breakingSpeed = clampTickerSpeedSeconds(breaking.tickerSpeedSeconds) ?? clampTickerSpeedSeconds(breaking.speedSec) ?? 12;
  const liveSpeed = clampTickerSpeedSeconds(live.tickerSpeedSeconds) ?? clampTickerSpeedSeconds(live.speedSec) ?? 12;

  return {
    breaking: {
      enabled: Boolean(breaking.enabled),
      mode: normalizeMode(breaking.mode) || 'auto',
      tickerSpeedSeconds: breakingSpeed,
      durationSeconds: breakingSpeed,
      speedSec: breakingSpeed,
    },
    live: {
      enabled: Boolean(live.enabled),
      mode: normalizeMode(live.mode) || 'auto',
      tickerSpeedSeconds: liveSpeed,
      durationSeconds: liveSpeed,
      speedSec: liveSpeed,
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

  const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
  const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

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
  computePublicEnabled,
  clampScrollDurationSeconds,
};
