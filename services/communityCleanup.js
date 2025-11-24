// services/communityCleanup.js
// Maintenance helpers for CommunitySubmission cleanup.

const CommunitySubmission = require('../models/CommunitySubmission');

/**
 * Hard-delete old, low-priority rejected community submissions.
 *
 * @param {{ olderThanDays?: number }} [options]
 * @returns {Promise<{ deletedCount: number, olderThanDays: number, cutoffDate: Date }>}
 */
async function cleanupOldLowPrioritySubmissions(options = {}) {
  const olderThanDays = Number.isFinite(options.olderThanDays)
    ? Number(options.olderThanDays)
    : 30;

  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const filter = {
    status: 'REJECTED',
    priority: 'LOW_PRIORITY',
    updatedAt: { $lt: cutoffDate },
  };

  const result = await CommunitySubmission.deleteMany(filter);
  const deletedCount = typeof result.deletedCount === 'number'
    ? result.deletedCount
    : 0;

  console.log(
    '[communityCleanup] deleted %d low-priority rejected submissions older than %d days',
    deletedCount,
    olderThanDays,
  );

  return { deletedCount, olderThanDays, cutoffDate };
}

module.exports = {
  cleanupOldLowPrioritySubmissions,
};
