/**
 * Migration: Backfill Phase-1 language fields for BroadcastItem
 * - Sets sourceLang='gu' when missing
 * - Ensures textByLang.gu = text when missing
 * - Sets statusByLang.gu='APPROVED' and qualityByLang.gu=100 when missing
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate_broadcast_lang.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BroadcastItem = require('../models/BroadcastItem');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    console.error('MONGODB_URI (or legacy MONGO_URI) not set. Aborting migration.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const cursor = BroadcastItem.find({}).cursor();
  let scanned = 0;
  let updated = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;
    let changed = false;

    const rawText = typeof doc.text === 'string' ? doc.text.trim() : '';

    if (!doc.sourceLang) {
      doc.sourceLang = 'gu';
      changed = true;
    }

    if (!doc.textByLang || typeof doc.textByLang !== 'object') {
      doc.textByLang = {};
      changed = true;
    }

    if (rawText && !doc.textByLang.gu) {
      doc.textByLang.gu = rawText;
      changed = true;
    }

    if (!doc.statusByLang || typeof doc.statusByLang !== 'object') {
      doc.statusByLang = {};
      changed = true;
    }

    if (!doc.statusByLang.gu) {
      doc.statusByLang.gu = 'APPROVED';
      changed = true;
    }

    if (!doc.qualityByLang || typeof doc.qualityByLang !== 'object') {
      doc.qualityByLang = {};
      changed = true;
    }

    if (typeof doc.qualityByLang.gu !== 'number') {
      doc.qualityByLang.gu = 100;
      changed = true;
    }

    if (changed) {
      try {
        await doc.save();
        updated += 1;
        if (updated % 50 === 0) console.log(`Updated ${updated} / Scanned ${scanned}`);
      } catch (e) {
        console.warn('Save failed, applying minimal $set update:', e.message || e);
        await BroadcastItem.updateOne(
          { _id: doc._id },
          {
            $set: {
              sourceLang: doc.sourceLang,
              textByLang: doc.textByLang,
              statusByLang: doc.statusByLang,
              qualityByLang: doc.qualityByLang,
            },
          },
        );
        updated += 1;
      }
    }
  }

  console.log(`Migration complete. Scanned=${scanned}, Updated=${updated}`);
  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error('Migration failed:', e?.message || e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
