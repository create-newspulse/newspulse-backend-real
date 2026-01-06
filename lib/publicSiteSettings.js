function defaultPublicSiteSettings() {
  return {
    ui: {
      showBreakingTicker: true,
      showLiveUpdatesTicker: true,
    },
    // Admin UI "Home Modules" defaults (keep enabled so new installs don't hide modules)
    // The admin UI may use any of these common numeric keys; keep them aligned.
    homeModules: {
      categoryStrip: { enabled: true, order: 1, position: 1, orderPosition: 1 },
      trendingStrip: { enabled: true, order: 2, position: 2, orderPosition: 2 },
      exploreCategories: { enabled: true, order: 3, position: 3, orderPosition: 3 },
      liveUpdatesTicker: { enabled: true, order: 4, position: 4, orderPosition: 4 },
      breakingTicker: { enabled: true, order: 5, position: 5, orderPosition: 5 },
      quickTools: { enabled: true, order: 6, position: 6, orderPosition: 6 },
      appPromo: { enabled: true, order: 7, position: 7, orderPosition: 7 },
      snapshots: { enabled: true, order: 8, position: 8, orderPosition: 8 },
      liveTV: { enabled: true, order: 9, position: 9, orderPosition: 9 },
      footer: { enabled: true, order: 10, position: 10, orderPosition: 10 },
    },
    tickers: {
      // Admin panel-friendly flat fields
      breakingSpeedSec: 6,
      liveSpeedSec: 8,

      // Legacy nested fields used by parts of the codebase
      breaking: { enabled: true, speedSeconds: 6 },
      live: { enabled: true, speedSeconds: 8 },
    },
  };
}

function applyPublicSiteSettingsDefaults(input) {
  const base = defaultPublicSiteSettings();
  if (!input || typeof input !== 'object') return base;

  const next = { ...input };

  // Home modules: merge missing defaults only (do not override explicit enabled=false)
  const incomingHomeModules = (next.homeModules && typeof next.homeModules === 'object') ? next.homeModules : {};
  const homeModules = { ...incomingHomeModules };
  const defaults = base.homeModules || {};

  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const cur = homeModules[key];

    if (!cur || typeof cur !== 'object') {
      homeModules[key] = { ...def };
      continue;
    }

    // Merge missing keys inside the module object
    const merged = { ...cur };
    for (const k of Object.keys(def)) {
      if (merged[k] === undefined) merged[k] = def[k];
    }
    homeModules[key] = merged;
  }

  next.homeModules = homeModules;
  return next;
}

function coerceBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '1') return true;
    if (v === '0') return false;
  }
  return fallback;
}

function coerceNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function clampNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.max(min, Math.min(max, value));
}

// Normalizes *only* the public-site tickers contract.
// - Preserves unknown keys.
// - Accepts both speedSeconds (new) and speedSec (legacy).
// - Coerces numeric/boolean string values instead of defaulting.
function normalizePublicSiteSettings(input) {
  const base = defaultPublicSiteSettings();
  if (!input || typeof input !== 'object') return base;

  const next = { ...input };
  const ui = (next.ui && typeof next.ui === 'object') ? { ...next.ui } : {};
  const tickers = (next.tickers && typeof next.tickers === 'object') ? { ...next.tickers } : {};

  const breakingRaw = (tickers.breaking && typeof tickers.breaking === 'object') ? { ...tickers.breaking } : {};
  const liveRaw = (tickers.live && typeof tickers.live === 'object') ? { ...tickers.live } : {};

  // Prefer explicit admin-panel fields if present, else fall back to nested legacy fields.
  // Speeds: accept breakingSpeedSec/liveSpeedSec (admin) and speedSeconds/speedSec (legacy)
  const breakingSpeedInput =
    tickers.breakingSpeedSec ??
    tickers.breakingSpeedSeconds ??
    breakingRaw.speedSeconds ??
    breakingRaw.speedSec;

  const liveSpeedInput =
    tickers.liveSpeedSec ??
    tickers.liveSpeedSeconds ??
    liveRaw.speedSeconds ??
    liveRaw.speedSec;

  const breakingSpeedSeconds = clampNumber(
    coerceNumber(breakingSpeedInput, base.tickers.breaking.speedSeconds),
    1,
    60,
  );

  const liveSpeedSeconds = clampNumber(
    coerceNumber(liveSpeedInput, base.tickers.live.speedSeconds),
    1,
    60,
  );

  // Booleans: accept admin ui fields; fallback to legacy nested enabled flags.
  const showBreakingTicker = coerceBoolean(
    ui.showBreakingTicker ?? ui.showBreaking ?? breakingRaw.enabled,
    base.ui.showBreakingTicker,
  );

  const showLiveUpdatesTicker = coerceBoolean(
    ui.showLiveUpdatesTicker ?? ui.showLiveTicker ?? liveRaw.enabled,
    base.ui.showLiveUpdatesTicker,
  );

  const breaking = {
    ...breakingRaw,
    enabled: showBreakingTicker,
    // keep both speedSeconds and speedSec for backward compatibility
    speedSeconds: breakingSpeedSeconds,
    speedSec: breakingSpeedSeconds,
  };

  const live = {
    ...liveRaw,
    enabled: showLiveUpdatesTicker,
    speedSeconds: liveSpeedSeconds,
    speedSec: liveSpeedSeconds,
  };

  ui.showBreakingTicker = showBreakingTicker;
  ui.showLiveUpdatesTicker = showLiveUpdatesTicker;

  tickers.breakingSpeedSec = breakingSpeedSeconds;
  tickers.liveSpeedSec = liveSpeedSeconds;
  tickers.breaking = breaking;
  tickers.live = live;
  next.ui = ui;
  next.tickers = tickers;

  return applyPublicSiteSettingsDefaults(next);
}

module.exports = {
  defaultPublicSiteSettings,
  applyPublicSiteSettingsDefaults,
  normalizePublicSiteSettings,
};
