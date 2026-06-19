const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const SessionLog = require('../models/SessionLog');
const { logAudit } = require('../lib/audit');
const {
  bad,
  can,
  canViewUser,
  ensureDb,
  heartbeat,
  markIdleUsers,
  ok,
  requirePermission,
  requireTeamAuth,
} = require('../lib/teamManagement');

const router = express.Router();

function presenceDto(user) {
  return {
    id: String(user._id || user.id),
    name: user.fullName || user.name || '',
    email: user.email || '',
    role: user.role || 'staff',
    accountStatus: user.accountStatus || user.status || 'active',
    onlineStatus: user.onlineStatus || 'offline',
    lastLoginAt: user.lastLoginAt || null,
    lastLogoutAt: user.lastLogoutAt || null,
    lastSeenAt: user.lastSeenAt || null,
    currentSessionId: user.currentSessionId || null,
  };
}

router.use(requireTeamAuth);

router.get('/presence', requirePermission('staff_activity_view_all'), async (_req, res) => {
  if (!ensureDb(res)) return;
  await markIdleUsers();
  const users = await User.find({ role: { $ne: 'public' } })
    .select('name fullName email role accountStatus status onlineStatus lastLoginAt lastLogoutAt lastSeenAt currentSessionId')
    .sort({ lastSeenAt: -1, name: 1 })
    .lean();
  return ok(res, { data: users.map(presenceDto) });
});

router.get('/presence/:userId', async (req, res) => {
  if (!ensureDb(res)) return;
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(String(userId))) return bad(res, 400, 'Invalid user id', 'INVALID_ID');
  if (!canViewUser(req, userId, 'staff_activity_view_all', 'staff_activity_view_own')) {
    await logAudit(req, 'BLOCKED_ATTENDANCE_ACCESS', userId, { area: 'presence' });
    return bad(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  await markIdleUsers();
  const user = await User.findById(userId)
    .select('name fullName email role accountStatus status onlineStatus lastLoginAt lastLogoutAt lastSeenAt currentSessionId')
    .lean();
  if (!user) return bad(res, 404, 'Not found', 'NOT_FOUND');
  return ok(res, { data: presenceDto(user) });
});

router.post('/presence/heartbeat', async (req, res) => {
  if (!ensureDb(res)) return;
  if (!req.user?.id || !mongoose.isValidObjectId(String(req.user.id))) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  const user = await heartbeat(req, req.user.id);
  if (!user) return bad(res, 404, 'Not found', 'NOT_FOUND');
  return ok(res, { data: presenceDto(user) });
});

router.get('/session-logs', requirePermission('staff_activity_view_all'), async (req, res) => {
  if (!ensureDb(res)) return;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const logs = await SessionLog.find({})
    .sort({ loginAt: -1 })
    .limit(limit)
    .populate('userId', 'name fullName email role')
    .lean();
  return ok(res, { data: logs });
});

router.get('/users/:id/session-logs', async (req, res) => {
  if (!ensureDb(res)) return;
  const { id } = req.params;
  if (!mongoose.isValidObjectId(String(id))) return bad(res, 400, 'Invalid user id', 'INVALID_ID');
  if (!canViewUser(req, id, 'staff_activity_view_all', 'staff_activity_view_own')) {
    await logAudit(req, 'BLOCKED_ATTENDANCE_ACCESS', id, { area: 'session_logs' });
    return bad(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const logs = await SessionLog.find({ userId: id }).sort({ loginAt: -1 }).limit(limit).lean();
  return ok(res, { data: logs });
});

module.exports = router;