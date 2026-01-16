// Quick manual smoke-test for Sponsor Ads.
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/your_database node scripts/test-ads.js
// Or set MONGODB_URI in your .env (legacy: MONGO_URI).

require('dotenv').config();

const mongoose = require('mongoose');
const Ad = require('../models/Ad');

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  (String(process.env.DATABASE_URL || '').startsWith('mongodb') ? process.env.DATABASE_URL : undefined);

async function main() {
  if (!MONGO_URI) {
    throw new Error('Missing MONGO_URI (or MONGODB_URI)');
  }

  await mongoose.connect(MONGO_URI);

  const created = await Ad.create({
    slot: 'HOME_728x90',
    title: 'Test Sponsor Banner',
    imageUrl: 'https://example.com/ad.png',
    targetUrl: 'https://example.com',
    isClickable: true,
    isActive: true,
    startAt: null,
    endAt: null,
    priority: 10,
    createdBy: 'script:test-ads',
  });

  console.log('[ads] created', { id: String(created._id) });

  const now = new Date();
  const active = await Ad.findOne({
    slot: 'HOME_728x90',
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] },
    ],
  }).sort({ priority: -1, updatedAt: -1 }).lean();

  console.log('[ads] active', active ? { id: String(active._id), priority: active.priority } : null);

  await Ad.findByIdAndUpdate(created._id, { $inc: { 'stats.impressions': 1 } });
  await Ad.findByIdAndUpdate(created._id, { $inc: { 'stats.clicks': 1 } });

  const after = await Ad.findById(created._id).lean();
  console.log('[ads] stats', after ? after.stats : null);

  // Clean up (comment out if you want to keep the doc)
  await Ad.deleteOne({ _id: created._id });
  console.log('[ads] deleted', { id: String(created._id) });

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('[ads] test failed', e?.message || e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
