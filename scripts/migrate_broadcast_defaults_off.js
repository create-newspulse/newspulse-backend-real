/**
 * One-time migration: force Broadcast settings defaults OFF.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate_broadcast_defaults_off.js
 *
 * This backend primarily stores broadcast settings in the single-doc `BroadcastSettings` model.
 * Some older deployments may also have a SiteSetting-like document with `key: "broadcast"`.
 */

const mongoose = require('mongoose');

const BroadcastSettings = require('../models/BroadcastSettings');
let SiteSetting = null;
try {
  // Optional: only present/used in some deployments.
  // eslint-disable-next-line global-require
  SiteSetting = require('../models/SiteSetting');
} catch (_) {
  SiteSetting = null;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('MONGODB_URI (or legacy MONGO_URI) is required');
  }

  await mongoose.connect(uri);

  const patch = {
    $set: {
      'breaking.enabled': false,
      'live.enabled': false,
      'breaking.mode': 'auto',
      'live.mode': 'auto',

      // Keep legacy mirrors aligned for older UIs/endpoints.
      breakingEnabled: false,
      liveEnabled: false,
      breakingMode: 'auto',
      liveMode: 'auto',
    },
  };

  // Primary store: BroadcastSettings (single doc). Use updateMany to be safe.
  const resBroadcast = await BroadcastSettings.updateMany({}, patch);

  let resSiteSetting = null;
  if (SiteSetting && typeof SiteSetting.updateMany === 'function') {
    resSiteSetting = await SiteSetting.updateMany(
      { key: 'broadcast' },
      {
        $set: {
          'data.breaking.enabled': false,
          'data.live.enabled': false,
          'data.breaking.mode': 'auto',
          'data.live.mode': 'auto',
        },
      },
    );
  }

  console.log('[migrate_broadcast_defaults_off] done');
  console.log('BroadcastSettings:', {
    matchedCount: resBroadcast.matchedCount,
    modifiedCount: resBroadcast.modifiedCount,
  });
  if (resSiteSetting) {
    console.log('SiteSetting(key=broadcast):', {
      matchedCount: resSiteSetting.matchedCount,
      modifiedCount: resSiteSetting.modifiedCount,
    });
  } else {
    console.log('SiteSetting(key=broadcast): skipped (model not available)');
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error('[migrate_broadcast_defaults_off] failed:', err && err.message ? err.message : err);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  });
