const mongoose = require('mongoose');

const GRANT_SOURCE = 'founder-access-studio-v1';

function publicationDenied() {
  return Object.assign(new Error('An effective Founder-granted Publish News right and authorized article access are required.'), {
    status: 403, statusCode: 403, code: 'ARTICLE_PUBLISH_FORBIDDEN',
  });
}

function issueNewsPublishGrant(req, subjectUserId, { temporaryAccessId, expiresAt } = {}) {
  const { normalizeRole } = require('./teamAccess');
  const actor = req?._authUserDoc;
  const identity = req?.user || req?.admin;
  if (!actor?._id || String(actor._id) !== String(identity?.id)
    || (normalizeRole(actor.role) !== 'founder' && actor.isFounder !== true)
    || !mongoose.isValidObjectId(String(subjectUserId))) throw publicationDenied();
  return {
    source: GRANT_SOURCE,
    subjectUserId,
    grantedBy: actor._id,
    grantedAt: new Date(),
    ...(temporaryAccessId ? { temporaryAccessId, expiresAt } : {}),
  };
}

function grantIssuer(grant, user, now, entry) {
  if (grant?.source !== GRANT_SOURCE || !user?._id
    || String(grant.subjectUserId || '') !== String(user._id)
    || !mongoose.isValidObjectId(String(grant.grantedBy || ''))) return null;
  if (entry) {
    if (String(grant.temporaryAccessId || '') !== String(entry._id || '')
      || new Date(grant.expiresAt).getTime() !== new Date(entry.expiresAt).getTime()
      || new Date(grant.grantedAt).getTime() !== new Date(entry.grantedAt).getTime()) return null;
  } else if (grant.temporaryAccessId || grant.expiresAt) return null;
  const time = grant.grantedAt && new Date(grant.grantedAt).getTime();
  return Number.isFinite(time) && time <= now ? String(grant.grantedBy) : null;
}

function newsPublishGrantIssuers(user, now = Date.now()) {
  const issuers = [];
  if (user?.specialRightsConfigured === true && user.specialRightsOverride?.includes('news_publish')) {
    issuers.push(grantIssuer(user.newsPublishGrant, user, now));
  }
  for (const entry of Array.isArray(user?.temporaryAccess) ? user.temporaryAccess : []) {
    if (entry.rightKey !== 'news_publish' || entry.enabled === false || !entry.expiresAt
      || !(new Date(entry.expiresAt).getTime() > now)) continue;
    const issuer = grantIssuer(entry.newsPublishGrant, user, now, entry);
    if (issuer && issuer === String(entry.grantedBy || '')) issuers.push(issuer);
  }
  return [...new Set(issuers.filter(Boolean))];
}

function hasRecordedNewsPublishGrant(user) {
  return newsPublishGrantIssuers(user).length > 0;
}

function hasNewsPublishGrantInput(body) {
  return Object.keys(body || {}).some(key => key === 'newsPublishGrant' || key.startsWith('newsPublishGrant.'));
}

module.exports = {
  GRANT_SOURCE, publicationDenied, issueNewsPublishGrant, newsPublishGrantIssuers,
  hasRecordedNewsPublishGrant, hasNewsPublishGrantInput,
};
