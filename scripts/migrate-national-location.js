/*
One-time migration: backfill nationalLocation for National articles.

Usage:
  MONGODB_URI="..." node scripts/migrate-national-location.js

Behavior:
  - Finds News documents with category "national" that are missing nationalLocation or missing scope.
  - Sets nationalLocation.scope = "ALL_INDIA" and clears stateUt* fields.

This script is safe to run multiple times.
*/

require('dotenv').config();
const mongoose = require('mongoose');

const News = require('../models/News');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGODB_URI (or legacy MONGO_URI) is required');
  }

  await mongoose.connect(uri);

  const filter = {
    category: 'national',
    $or: [
      { nationalLocation: { $exists: false } },
      { 'nationalLocation.scope': { $exists: false } },
      { 'nationalLocation.scope': null },
      { 'nationalLocation.scope': '' },
    ],
  };

  const update = {
    $set: {
      nationalLocation: {
        scope: 'ALL_INDIA',
        stateUtName: '',
        stateUtSlug: '',
        stateUtType: '',
      },
    },
  };

  const res = await News.updateMany(filter, update);

  console.log('[migrate-national-location] done', {
    matched: res.matchedCount ?? res.nMatched ?? null,
    modified: res.modifiedCount ?? res.nModified ?? null,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migrate-national-location] failed', err?.message || err);
  process.exitCode = 1;
});
