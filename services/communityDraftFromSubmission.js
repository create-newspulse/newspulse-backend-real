// services/communityDraftFromSubmission.js
// Helper to create a News draft from a CommunitySubmission on approval.

const CommunitySubmission = require('../models/CommunitySubmission');
const News = require('../models/News');

/**
 * Create a draft News article from a community submission.
 * Avoids duplicates by checking linkedArticleId.
 *
 * @param {string} submissionId
 * @param {{ session?: import('mongoose').ClientSession }} [opts]
 * @returns {Promise<{ submission: any, article: any }>} 
 */
async function createDraftArticleFromSubmission(submissionId, opts = {}) {
  const { session } = opts;

  if (!submissionId) {
    const err = new Error('Missing submission id');
    err.statusCode = 400;
    throw err;
  }

  const query = CommunitySubmission.findById(submissionId);
  if (session) query.session(session);
  const submission = await query;

  if (!submission) {
    const err = new Error('Submission not found');
    err.statusCode = 404;
    throw err;
  }

  if (submission.linkedArticleId) {
    const article = await News.findById(submission.linkedArticleId).session(session || null);
    return { submission, article: article || null };
  }

  const title = submission.headline || 'Community Report';
  const description = (submission.body || '').slice(0, 200) || 'Community Reporter story';

  const article = new News({
    title,
    description,
    content: submission.body || '',
    tags: [],
    category: submission.category || undefined,
    status: 'draft', // ensure draft status on creation
    language: submission.language || 'en',
  });

  if (session) {
    await article.save({ session });
  } else {
    await article.save();
  }

  submission.linkedArticleId = article._id;

  if (session) {
    await submission.save({ session });
  } else {
    await submission.save();
  }

  return { submission, article };
}

module.exports = {
  createDraftArticleFromSubmission,
};
