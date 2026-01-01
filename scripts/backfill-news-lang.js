/*
One-time backfill for News language field.

Usage:
  MONGO_URI="..." node scripts/backfill-news-lang.js

Behavior:
  - If a doc has `language` (en/hi/gu) but missing `lang`, copy it into `lang`.
  - Otherwise, if `lang` is missing, set `lang` to "en".

This script is safe to run multiple times.
*/

require('dotenv').config();
const mongoose = require('mongoose');

const News = require('../models/News');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(uri);

  // Copy existing `language` -> `lang` (best-effort) using per-language updates.
  const copyResults = [];
  for (const l of ['en', 'hi', 'gu']) {
    copyResults.push(
      await News.updateMany(
        { lang: { $exists: false }, language: l },
        { $set: { lang: l } }
      )
    );
  }

  const copiedMatched = copyResults.reduce((s, r) => s + (r.matchedCount || 0), 0);
  const copiedModified = copyResults.reduce((s, r) => s + (r.modifiedCount || 0), 0);

  const defaultRes = await News.updateMany(
    { lang: { $exists: false } },
    { $set: { lang: 'gu' } }
  );

  console.log('[backfill-news-lang] done', {
    copiedFromLanguage: {
      matched: copiedMatched,
      modified: copiedModified,
    },
    defaultedToEn: {
      matched: defaultRes.matchedCount ?? defaultRes.nMatched ?? null,
      modified: defaultRes.modifiedCount ?? defaultRes.nModified ?? null,
    },
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill-news-lang] failed', err?.message || err);
  process.exitCode = 1;
});
