const User = require('../models/User');
const { isUserAccessEligible, normalizeRole } = require('./teamAccess');
const { ACCOUNT_STATUS, lifecycleStatus } = require('./accountLifecycle');

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

module.exports = { loadArticleMutationActor };
