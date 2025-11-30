// Temporary inspection script for CommunitySubmission collection
// Usage: npm run inspect:community
require('dotenv').config();
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[inspectCommunity] Missing MONGO_URI in environment');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    console.log('[inspectCommunity] Connected');

    // Basic counts (requested explicit status values even if schema uses others)
    const total = await CommunitySubmission.countDocuments({});
    const pending = await CommunitySubmission.countDocuments({ status: 'pending' });
    const rejected = await CommunitySubmission.countDocuments({ status: 'rejected' });
    const approved = await CommunitySubmission.countDocuments({ status: 'approved' });

    // Also show internal status distribution for visibility
    const internalAgg = await CommunitySubmission.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    console.log('\nCounts');
    console.log('total:', total);
    console.log('pending (exact match):', pending);
    console.log('rejected (exact match):', rejected);
    console.log('approved (exact match):', approved);

    console.log('\nInternal status distribution (raw values):');
    internalAgg.forEach(s => console.log(`  ${s._id || '(null)'}: ${s.count}`));

    const recent = await CommunitySubmission.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select({ headline: 1, status: 1, sourceType: 1, reporterVerificationLevel: 1, createdAt: 1 })
      .lean();

    console.log('\nRecent 5 submissions:');
    recent.forEach(r => {
      console.log({
        _id: r._id.toString(),
        headline: r.headline,
        status: r.status,
        sourceType: r.sourceType || '(missing -> treated community)',
        reporterVerificationLevel: r.reporterVerificationLevel,
        createdAt: r.createdAt,
      });
    });
  } catch (e) {
    console.error('[inspectCommunity] Error:', e.message || e);
  } finally {
    await mongoose.disconnect().catch(() => {});
    console.log('[inspectCommunity] Disconnected');
    process.exit(0);
  }
})();
