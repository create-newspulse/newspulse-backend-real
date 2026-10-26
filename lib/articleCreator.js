const mongoose = require('mongoose');

function buildArticleCreatorFields(req) {
  const user = req?._authUserDoc;
  if (!user) return {};
  if (!mongoose.isObjectIdOrHexString(user._id)) {
    throw Object.assign(new Error('Verified article creator identity is invalid'), {
      statusCode: 500,
      code: 'INVALID_ARTICLE_CREATOR',
    });
  }
  return { createdByUserId: user._id };
}

function hasArticleCreatorInput(body) {
  return Object.keys(body || {}).some(key => key === 'createdByUserId' || key.startsWith('createdByUserId.'));
}

module.exports = { buildArticleCreatorFields, hasArticleCreatorInput };
