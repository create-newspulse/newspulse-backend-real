const mongoose = require('mongoose');

const BroadcastVersion = require('../models/BroadcastVersion');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function getBroadcastVersion() {
  if (!isDbReady()) return 0;

  const doc = await BroadcastVersion.findOne({ key: 'global' }).lean();
  if (!doc || typeof doc.version !== 'number') return 0;
  return doc.version;
}

async function bumpBroadcastVersion({ reason } = {}) {
  if (!isDbReady()) return 0;

  const now = new Date();
  const updated = await BroadcastVersion.findOneAndUpdate(
    { key: 'global' },
    {
      $inc: { version: 1 },
      $set: { updatedAt: now },
      $setOnInsert: { key: 'global' },
    },
    { new: true, upsert: true }
  ).lean();

  return updated && typeof updated.version === 'number' ? updated.version : 0;
}

module.exports = {
  getBroadcastVersion,
  bumpBroadcastVersion,
};
