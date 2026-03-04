/*
One-time backfill for News.description (required).

Usage:
  MONGODB_URI="..." node scripts/backfill-news-description.js

Behavior:
  - Finds News docs where `description` is missing/null/empty-string.
  - Sets `description = summary || content.slice(0, 160)`.

Notes:
  - `summary` is not a schema field in this codebase, but may exist in legacy docs.
  - This script is safe to run multiple times.
*/

require('dotenv').config();
const mongoose = require('mongoose');

const News = require('../models/News');

function _nonEmptyTrimmedString(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s ? s : '';
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGODB_URI (or legacy MONGO_URI) is required');
  }

  await mongoose.connect(uri);

  const q = {
    $or: [
      { description: { $exists: false } },
      { description: null },
      { description: '' },
    ],
  };

  const cursor = News.find(q)
    .select({ _id: 1, description: 1, summary: 1, content: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let updated = 0;
  let skippedNoSource = 0;
  let failed = 0;

  for await (const doc of cursor) {
    scanned++;

    const summary = _nonEmptyTrimmedString(doc && doc.summary);
    const content = _nonEmptyTrimmedString(doc && doc.content);
    const next = summary || (content ? content.slice(0, 160) : '');

    if (!next) {
      skippedNoSource++;
      continue;
    }

    try {
      const res = await News.updateOne(
        { _id: doc._id },
        { $set: { description: next } }
      );
      if (res && (res.modifiedCount || res.nModified)) updated++;
    } catch (e) {
      failed++;
      console.error('[backfill-news-description] update failed', {
        id: String(doc && doc._id ? doc._id : ''),
        message: e?.message || String(e),
      });
    }

    if (scanned % 500 === 0) {
      console.log('[backfill-news-description] progress', { scanned, updated, skippedNoSource, failed });
    }
  }

  console.log('[backfill-news-description] done', { scanned, updated, skippedNoSource, failed });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill-news-description] failed', err?.message || err);
  process.exitCode = 1;
});
