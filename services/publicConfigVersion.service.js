const mongoose = require('mongoose');

const PublicConfigVersion = require('../models/PublicConfigVersion');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeVersionDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    return { version: 0, updatedAt: null };
  }

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : null,
  };
}

async function getPublicConfigVersionDetails() {
  if (!isDbReady()) return { version: 0, updatedAt: null };

  const doc = await PublicConfigVersion.findOne({ key: 'public' }).lean();
  return normalizeVersionDoc(doc);
}

async function getPublicConfigVersion() {
  const state = await getPublicConfigVersionDetails();
  return state.version;
}

async function bumpPublicConfigVersion() {
  if (!isDbReady()) return { version: 0, updatedAt: null };

  const current = await PublicConfigVersion.findOne({ key: 'public' }).lean();
  const nowMs = Date.now();
  const nextVersion = current && typeof current.version === 'number'
    ? Math.max(nowMs, current.version + 1)
    : nowMs;
  const now = new Date();

  const updated = await PublicConfigVersion.findOneAndUpdate(
    { key: 'public' },
    {
      $set: {
        key: 'public',
        version: nextVersion,
        updatedAt: now,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return normalizeVersionDoc(updated);
}

module.exports = {
  getPublicConfigVersion,
  getPublicConfigVersionDetails,
  bumpPublicConfigVersion,
};