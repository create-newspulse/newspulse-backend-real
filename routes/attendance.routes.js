const express = require('express');
const mongoose = require('mongoose');

const Attendance = require('../models/Attendance');
const BreakLog = require('../models/BreakLog');
const User = require('../models/User');
const { logAudit } = require('../lib/audit');
const {
  actorObjectId,
  bad,
  can,
  canViewUser,
  dayStart,
  ensureActiveAccount,
  ensureDb,
  minutesBetween,
  ok,
  parseDate,
  parseDateTime,
  requirePermission,
  requireTeamAuth,
} = require('../lib/teamManagement');

const router = express.Router();

function attendanceDto(doc) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return { ...raw, id: String(raw._id) };
}

function attendanceQueryFromRequest(req, userId) {
  const query = { userId };
  const from = parseDate(req.query.from || req.query.startDate, null);
  const to = parseDate(req.query.to || req.query.endDate, null);
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to) query.date.$lte = to;
  }
  return query;
}

async function markForgottenCheckouts(userId = null) {
  const today = dayStart();
  const query = { checkInAt: { $ne: null }, checkOutAt: null, date: { $lt: today } };
  if (userId) query.userId = userId;
  await Attendance.updateMany(query, {
    $set: {
      correctionRequested: true,
      notes: 'Checkout missing. Needs review.',
      updatedAt: new Date(),
    },
  });
}

async function loadSelfUser(req, res) {
  if (!req.user?.id || !mongoose.isValidObjectId(String(req.user.id))) {
    bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    return null;
  }
  const user = await User.findById(req.user.id);
  if (!user) {
    bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    return null;
  }
  return user;
}

router.use(requireTeamAuth);

router.post('/check-in', async (req, res) => {
  if (!ensureDb(res)) return;
  const user = await loadSelfUser(req, res);
  if (!user || !ensureActiveAccount(user, res)) return;

  const date = dayStart();
  const existing = await Attendance.findOne({ userId: user._id, date });
  if (existing?.checkInAt && !existing.checkOutAt) return bad(res, 409, 'Already checked in', 'ALREADY_CHECKED_IN');
  if (existing?.checkOutAt) return bad(res, 409, 'Attendance already closed for today', 'ALREADY_CHECKED_OUT');

  const now = new Date();
  const attendance = existing || new Attendance({ userId: user._id, date });
  attendance.checkInAt = now;
  attendance.status = req.body?.status && ['present', 'late', 'half_day'].includes(String(req.body.status)) ? String(req.body.status) : 'present';
  attendance.notes = req.body?.notes ? String(req.body.notes).slice(0, 1000) : attendance.notes;
  await attendance.save();

  user.currentAttendanceId = attendance._id;
  user.lastSeenAt = now;
  if (user.onlineStatus !== 'on_break') user.onlineStatus = 'online';
  await user.save();

  await logAudit(req, 'ATTENDANCE_CHECK_IN', String(user._id), { attendanceId: String(attendance._id) });
  return ok(res, { data: attendanceDto(attendance) }, 201);
});

router.post('/check-out', async (req, res) => {
  if (!ensureDb(res)) return;
  const user = await loadSelfUser(req, res);
  if (!user) return;

  const date = dayStart();
  const attendance = await Attendance.findOne({ userId: user._id, date, checkInAt: { $ne: null }, checkOutAt: null });
  if (!attendance) return bad(res, 404, 'No active attendance found for today', 'NO_ACTIVE_ATTENDANCE');

  const now = new Date();
  const activeBreak = await BreakLog.findOne({ userId: user._id, attendanceId: attendance._id, status: 'active' });
  if (activeBreak) {
    activeBreak.breakEndAt = now;
    activeBreak.totalMinutes = minutesBetween(activeBreak.breakStartAt, now);
    activeBreak.status = 'ended';
    await activeBreak.save();
    attendance.totalBreakMinutes = (attendance.totalBreakMinutes || 0) + activeBreak.totalMinutes;
  }

  attendance.checkOutAt = now;
  attendance.totalWorkMinutes = Math.max(0, minutesBetween(attendance.checkInAt, now) - (attendance.totalBreakMinutes || 0));
  await attendance.save();

  user.currentAttendanceId = null;
  user.currentBreakId = null;
  user.lastSeenAt = now;
  user.onlineStatus = 'online';
  await user.save();

  await logAudit(req, 'ATTENDANCE_CHECK_OUT', String(user._id), { attendanceId: String(attendance._id) });
  return ok(res, { data: attendanceDto(attendance) });
});

router.post('/break/start', async (req, res) => {
  if (!ensureDb(res)) return;
  const user = await loadSelfUser(req, res);
  if (!user) return;

  const attendance = await Attendance.findOne({ userId: user._id, date: dayStart(), checkInAt: { $ne: null }, checkOutAt: null });
  if (!attendance) return bad(res, 404, 'No active attendance found for today', 'NO_ACTIVE_ATTENDANCE');
  const existingBreak = await BreakLog.findOne({ userId: user._id, attendanceId: attendance._id, status: 'active' });
  if (existingBreak) return bad(res, 409, 'Break already active', 'BREAK_ALREADY_ACTIVE');

  const breakLog = await BreakLog.create({
    userId: user._id,
    attendanceId: attendance._id,
    breakStartAt: new Date(),
    reason: req.body?.reason ? String(req.body.reason).slice(0, 300) : null,
  });
  user.currentBreakId = breakLog._id;
  user.onlineStatus = 'on_break';
  user.lastSeenAt = new Date();
  await user.save();

  await logAudit(req, 'ATTENDANCE_BREAK_START', String(user._id), { attendanceId: String(attendance._id), breakId: String(breakLog._id) });
  return ok(res, { data: breakLog }, 201);
});

router.post('/break/end', async (req, res) => {
  if (!ensureDb(res)) return;
  const user = await loadSelfUser(req, res);
  if (!user) return;

  const breakLog = await BreakLog.findOne({ userId: user._id, status: 'active' }).sort({ breakStartAt: -1 });
  if (!breakLog) return bad(res, 404, 'No active break found', 'NO_ACTIVE_BREAK');
  const now = new Date();
  breakLog.breakEndAt = now;
  breakLog.totalMinutes = minutesBetween(breakLog.breakStartAt, now);
  breakLog.status = 'ended';
  await breakLog.save();

  await Attendance.findByIdAndUpdate(breakLog.attendanceId, {
    $inc: { totalBreakMinutes: breakLog.totalMinutes },
    $set: { updatedAt: now },
  });
  user.currentBreakId = null;
  user.onlineStatus = 'online';
  user.lastSeenAt = now;
  await user.save();

  await logAudit(req, 'ATTENDANCE_BREAK_END', String(user._id), { attendanceId: String(breakLog.attendanceId), breakId: String(breakLog._id) });
  return ok(res, { data: breakLog });
});

router.get('/today', async (req, res) => {
  if (!ensureDb(res)) return;
  const attendance = await Attendance.findOne({ userId: req.user.id, date: dayStart() }).lean();
  return ok(res, { data: attendanceDto(attendance) });
});

router.get('/me', async (req, res) => {
  if (!ensureDb(res)) return;
  await markForgottenCheckouts(req.user.id);
  const docs = await Attendance.find(attendanceQueryFromRequest(req, req.user.id)).sort({ date: -1 }).limit(200).lean();
  return ok(res, { data: docs.map(attendanceDto) });
});

router.get('/users/:id', async (req, res) => {
  if (!ensureDb(res)) return;
  const { id } = req.params;
  if (!mongoose.isValidObjectId(String(id))) return bad(res, 400, 'Invalid user id', 'INVALID_ID');
  if (!canViewUser(req, id, 'attendance_view_all', 'attendance_view_own')) {
    await logAudit(req, 'BLOCKED_ATTENDANCE_ACCESS', id, { area: 'attendance_user' });
    return bad(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  await markForgottenCheckouts(id);
  const docs = await Attendance.find(attendanceQueryFromRequest(req, id)).sort({ date: -1 }).limit(200).lean();
  return ok(res, { data: docs.map(attendanceDto) });
});

router.get('/report', requirePermission('attendance_view_all'), async (req, res) => {
  if (!ensureDb(res)) return;
  await markForgottenCheckouts();
  const query = {};
  const from = parseDate(req.query.from || req.query.startDate, null);
  const to = parseDate(req.query.to || req.query.endDate, null);
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to) query.date.$lte = to;
  }
  if (req.query.userId && mongoose.isValidObjectId(String(req.query.userId))) query.userId = String(req.query.userId);
  const docs = await Attendance.find(query).sort({ date: -1 }).limit(1000).populate('userId', 'name fullName email role').lean();
  const summary = docs.reduce((acc, item) => {
    const status = item.status || 'present';
    acc.total += 1;
    acc.byStatus[status] = (acc.byStatus[status] || 0) + 1;
    acc.totalWorkMinutes += item.totalWorkMinutes || 0;
    acc.totalBreakMinutes += item.totalBreakMinutes || 0;
    if (item.correctionRequested) acc.needsReview += 1;
    return acc;
  }, { total: 0, byStatus: {}, totalWorkMinutes: 0, totalBreakMinutes: 0, needsReview: 0 });
  return ok(res, { data: { summary, items: docs.map(attendanceDto) } });
});

router.patch('/:id/correct', requirePermission('attendance_correct'), async (req, res) => {
  if (!ensureDb(res)) return;
  const { id } = req.params;
  if (!mongoose.isValidObjectId(String(id))) return bad(res, 400, 'Invalid attendance id', 'INVALID_ID');
  const attendance = await Attendance.findById(id);
  if (!attendance) return bad(res, 404, 'Not found', 'NOT_FOUND');

  const allowedStatuses = ['present', 'absent', 'late', 'half_day', 'on_leave', 'off_day'];
  if (req.body?.status !== undefined) {
    const status = String(req.body.status || '').trim();
    if (!allowedStatuses.includes(status)) return bad(res, 400, 'Invalid attendance status', 'INVALID_STATUS');
    attendance.status = status;
  }
  const checkInAt = parseDateTime(req.body?.checkInAt);
  const checkOutAt = parseDateTime(req.body?.checkOutAt);
  if (req.body?.checkInAt !== undefined) attendance.checkInAt = checkInAt;
  if (req.body?.checkOutAt !== undefined) attendance.checkOutAt = checkOutAt;
  if (req.body?.totalBreakMinutes !== undefined) attendance.totalBreakMinutes = Math.max(0, parseInt(req.body.totalBreakMinutes || '0', 10));
  if (req.body?.notes !== undefined) attendance.notes = String(req.body.notes || '').slice(0, 1000) || null;
  if (attendance.checkInAt && attendance.checkOutAt) {
    attendance.totalWorkMinutes = Math.max(0, minutesBetween(attendance.checkInAt, attendance.checkOutAt) - (attendance.totalBreakMinutes || 0));
  }
  attendance.correctionRequested = false;
  attendance.correctedBy = actorObjectId(req);
  attendance.correctedAt = new Date();
  await attendance.save();
  await logAudit(req, 'ATTENDANCE_CORRECTION', String(attendance.userId), { attendanceId: String(attendance._id) });
  return ok(res, { data: attendanceDto(attendance) });
});

module.exports = router;