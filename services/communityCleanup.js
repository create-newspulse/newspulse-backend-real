// services/communityCleanup.js
// Maintenance helpers for CommunitySubmission cleanup.

const CommunitySubmission = require('../models/CommunitySubmission');

const LOW_PRIORITY_TTL_DAYS = 30;

/**
 * Archive old, low-priority community submissions instead of hard-deleting.
 * Only targets LOW_PRIORITY items that are not approved.
 *
 * @param {{ days?: number, dryRun?: boolean }} [opts]
 * @returns {Promise<{ archivedCount: number, days: number, dryRun: boolean }>}
 */
async function cleanupOldLowPrioritySubmissions(opts = {}) {
  const { days = LOW_PRIORITY_TTL_DAYS, dryRun = false } = opts;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const query = {
    priority: 'LOW_PRIORITY',
    status: { $in: ['NEW', 'REJECTED'] },
    createdAt: { $lt: cutoff },
    isArchived: { $ne: true },
  };

  if (dryRun) {
    const count = await CommunitySubmission.countDocuments(query);
    return { archivedCount: count, days, dryRun: true };
  }

  const result = await CommunitySubmission.updateMany(
    query,
    { $set: { isArchived: true, archivedAt: new Date() } }
  );

  const archivedCount = typeof result.modifiedCount === 'number'
    ? result.modifiedCount
    : (result.nModified || 0);

  return { archivedCount, days, dryRun: false };
}

module.exports = {
  LOW_PRIORITY_TTL_DAYS,
  cleanupOldLowPrioritySubmissions,
};
