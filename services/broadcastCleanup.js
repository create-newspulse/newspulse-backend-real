const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const backgroundTasks = require('../lib/backgroundTasks');

let timer;
let active;
let unregister;
let stopping = false;

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
  if (!backgroundTasks.isBackgroundWorkersEnabled()) return;
  if (timer || backgroundTasks.closing) return timer;
  stopping = false;
  // Run once at startup, then every 30 minutes.
  const intervalMs = 30 * 60 * 1000;

  const run = () => {
    if (active || stopping || backgroundTasks.closing) return;
    active = backgroundTasks.track('broadcast.cleanup', Promise.resolve().then(() => {
      if (stopping || backgroundTasks.closing) return { ok: false, skipped: true, reason: 'shutdown' };
      return cleanupOldBroadcastItems();
    }));
    active.then(() => { active = null; }, error => {
      active = null;
      console.warn('[broadcast.cleanup] failed', { code: error.code || 'BROADCAST_CLEANUP_FAILED' });
    });
  };

  unregister = backgroundTasks.registerStop(stopBroadcastCleanupJob);
  run();
  timer = setInterval(run, intervalMs);

  // Allow process to exit naturally.
  if (typeof timer.unref === 'function') timer.unref();

  return timer;
}

function stopBroadcastCleanupJob() {
  stopping = true;
  clearInterval(timer);
  timer = null;
  unregister?.();
  return active || Promise.resolve();
}

module.exports = { cleanupOldBroadcastItems, startBroadcastCleanupJob, stopBroadcastCleanupJob };
