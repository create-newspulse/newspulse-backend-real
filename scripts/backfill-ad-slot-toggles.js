// scripts/backfill-ad-slot-toggles.js
// Backfills AdSettings.slotEnabled keys for all known ad slots.
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/your_database node scripts/backfill-ad-slot-toggles.js
// Or set MONGODB_URI / MONGO_URI in your .env.

require('dotenv').config();

const mongoose = require('mongoose');
const AdSettings = require('../models/AdSettings');
const { buildSlotEnabledDefaults } = require('../src/constants/adSlots');

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  (String(process.env.DATABASE_URL || '').startsWith('mongodb') ? process.env.DATABASE_URL : undefined);

async function main() {
  if (!MONGO_URI) {
    throw new Error('Missing MONGO_URI (or MONGODB_URI)');
  }

  await mongoose.connect(MONGO_URI);

  const defaults = buildSlotEnabledDefaults(true, {
    HOME_RIGHT_300x600: false,
    HOME_BILLBOARD_970x250: false,
    BREAKING_SPONSOR: false,
    LIVE_UPDATE_SPONSOR: false,
  });

  const doc = await AdSettings.findByIdAndUpdate(
    'global',
    { $setOnInsert: { _id: 'global' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  const raw = doc && typeof doc === 'object' ? doc.slotEnabled : null;
  const slotEnabled = { ...defaults };

  if (raw && typeof raw === 'object') {
    // Support both Map and plain object
    const entries = typeof raw.entries === 'function' ? Array.from(raw.entries()) : Object.entries(raw);
    for (const [k, v] of entries) {
      if (Object.prototype.hasOwnProperty.call(slotEnabled, k) && typeof v === 'boolean') {
        slotEnabled[k] = v;
      }
    }

    // Safety defaults for newly-added slots: if the persisted record predates the key,
    // treat it as disabled until explicitly enabled.
    for (const key of ['FOOTER_BANNER_728x90', 'HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250', 'BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR']) {
      const rawVal = typeof raw.get === 'function' ? raw.get(key) : raw[key];
      if (typeof rawVal !== 'boolean') slotEnabled[key] = false;
    }

    // Keep legacy alias in sync
    if (typeof raw.HOME_RIGHT_300x250 !== 'boolean' && typeof raw.HOME_RIGHT_RAIL === 'boolean') {
      slotEnabled.HOME_RIGHT_300x250 = raw.HOME_RIGHT_RAIL;
    }
    slotEnabled.HOME_RIGHT_RAIL = slotEnabled.HOME_RIGHT_300x250;
  }

  await AdSettings.updateOne({ _id: 'global' }, { $set: { slotEnabled } }, { upsert: true });

  console.log('[ads][backfill] updated ad_settings.global.slotEnabled keys:', Object.keys(slotEnabled));

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('[ads][backfill] failed', e?.message || e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
