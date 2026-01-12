const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function cleanupOldBroadcastItems() {
  if (!isDbReady()) return { ok: false, skipped: true, reason: 'db_not_ready' };

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await BroadcastItem.deleteMany({ createdAt: { $lt: cutoff } });
  return { ok: true, deletedCount: result?.deletedCount || 0 };
}

function startBroadcastCleanupJob() {
  // Run once at startup, then every 30 minutes.
  const intervalMs = 30 * 60 * 1000;

  // Fire-and-forget; don't block startup.
  cleanupOldBroadcastItems().catch(() => {});

  const timer = setInterval(() => {
    cleanupOldBroadcastItems().catch(() => {});
  }, intervalMs);

  // Allow process to exit naturally.
  if (typeof timer.unref === 'function') timer.unref();

  return timer;
}

module.exports = { cleanupOldBroadcastItems, startBroadcastCleanupJob };
