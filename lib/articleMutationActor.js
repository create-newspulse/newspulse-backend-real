const User = require('../models/User');
const { isUserAccessEligible, normalizeRole } = require('./teamAccess');
const { ACCOUNT_STATUS, lifecycleStatus } = require('./accountLifecycle');
const { logAudit } = require('./audit');

async function loadArticleMutationActor(req, session, denied) {
  if (!session || !req?._authUserDoc?._id || !req.admin) throw denied();
  req.user = req.admin;
  const user = await User.findById(req._authUserDoc._id, null, { session }).lean();
  if (!user || lifecycleStatus(user) !== ACCOUNT_STATUS.ACTIVE || user.loginAllowed === false
    || !isUserAccessEligible(user)
    || Number(user.tokenVersion || 0) !== Number(req._authUserDoc.tokenVersion || 0)
    || normalizeRole(user.role) !== normalizeRole(req._authUserDoc.role)) throw denied();
  return user;
}

async function requireFounderArticleMutation(req, session) {
  const denied = () => Object.assign(new Error('Founder permission is required.'), {
    status: 403, statusCode: 403, code: 'FOUNDER_REQUIRED',
  });
  try {
    const user = await loadArticleMutationActor(req, session, denied);
    if (normalizeRole(user.role) !== 'founder' && user.isFounder !== true) throw denied();
    return user;
  } catch (error) {
    if (error.code === 'FOUNDER_REQUIRED') {
      await logAudit(req, 'ACCESS_BLOCKED', null, { module: 'articles', reason: 'publication_authority', result: 'blocked' });
    }
    throw error;
  }
}

module.exports = { loadArticleMutationActor, requireFounderArticleMutation };
