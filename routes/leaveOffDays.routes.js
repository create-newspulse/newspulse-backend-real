const express = require('express');
const mongoose = require('mongoose');

const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');
const OffDay = require('../models/OffDay');
const { logAudit } = require('../lib/audit');
const {
  actorObjectId,
  bad,
  can,
  dayStart,
  ensureDb,
  ok,
  parseDate,
  requirePermission,
  requireTeamAuth,
} = require('../lib/teamManagement');

const router = express.Router();

function leaveDto(doc) {
  const raw = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  return raw ? { ...raw, id: String(raw._id) } : null;
}

async function applyAttendanceStatus(userId, fromDate, toDate, status) {
  const start = dayStart(fromDate);
  const end = dayStart(toDate);
  if (!start || !end) return;
  for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    const currentDate = new Date(date);
    await Attendance.findOneAndUpdate(
      { userId, date: currentDate },
      { $set: { userId, date: currentDate, status, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true },
    );
  }
}

router.use(['/leave', '/off-days'], requireTeamAuth);

router.post('/leave/request', requirePermission('leave_request'), async (req, res) => {
  if (!ensureDb(res)) return;
  const leaveType = String(req.body?.leaveType || '').trim();
  const startDate = parseDate(req.body?.startDate, null);
  const endDate = parseDate(req.body?.endDate, null);
  if (!leaveType) return bad(res, 400, 'leaveType is required', 'MISSING_LEAVE_TYPE');
  if (!startDate || !endDate || endDate < startDate) return bad(res, 400, 'Invalid leave date range', 'INVALID_DATES');

  const leave = await LeaveRequest.create({
    userId: req.user.id,
    leaveType,
    startDate,
    endDate,
    reason: req.body?.reason ? String(req.body.reason).slice(0, 1000) : null,
    requestedAt: new Date(),
  });
  await logAudit(req, 'LEAVE_REQUEST', req.user.id, { leaveId: String(leave._id) });
  return ok(res, { data: leaveDto(leave) }, 201);
});

router.get('/leave/me', async (req, res) => {
  if (!ensureDb(res)) return;
  const docs = await LeaveRequest.find({ userId: req.user.id }).sort({ requestedAt: -1 }).limit(200).lean();
  return ok(res, { data: docs.map(leaveDto) });
});

router.get('/leave/all', requirePermission('leave_approve'), async (_req, res) => {
  if (!ensureDb(res)) return;
  const docs = await LeaveRequest.find({}).sort({ requestedAt: -1 }).limit(500).populate('userId', 'name fullName email role').lean();
  return ok(res, { data: docs.map(leaveDto) });
});

router.patch('/leave/:id/approve', requirePermission('leave_approve'), async (req, res) => {
  if (!ensureDb(res)) return;
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid leave id', 'INVALID_ID');
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave) return bad(res, 404, 'Not found', 'NOT_FOUND');
  leave.status = 'approved';
  leave.reviewedBy = actorObjectId(req);
  leave.reviewedAt = new Date();
  leave.reviewNote = req.body?.reviewNote ? String(req.body.reviewNote).slice(0, 1000) : null;
  await leave.save();
  await applyAttendanceStatus(leave.userId, leave.startDate, leave.endDate, 'on_leave');
  await logAudit(req, 'LEAVE_APPROVED', String(leave.userId), { leaveId: String(leave._id) });
  return ok(res, { data: leaveDto(leave) });
});

router.patch('/leave/:id/reject', requirePermission('leave_approve'), async (req, res) => {
  if (!ensureDb(res)) return;
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid leave id', 'INVALID_ID');
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave) return bad(res, 404, 'Not found', 'NOT_FOUND');
  leave.status = 'rejected';
  leave.reviewedBy = actorObjectId(req);
  leave.reviewedAt = new Date();
  leave.reviewNote = req.body?.reviewNote ? String(req.body.reviewNote).slice(0, 1000) : null;
  await leave.save();
  await logAudit(req, 'LEAVE_REJECTED', String(leave.userId), { leaveId: String(leave._id) });
  return ok(res, { data: leaveDto(leave) });
});

router.post('/off-days/mark', requirePermission('offday_manage'), async (req, res) => {
  if (!ensureDb(res)) return;
  const userId = String(req.body?.userId || '').trim();
  const date = parseDate(req.body?.date, null);
  if (!mongoose.isValidObjectId(userId)) return bad(res, 400, 'Invalid user id', 'INVALID_ID');
  if (!date) return bad(res, 400, 'Invalid date', 'INVALID_DATE');
  const offDay = await OffDay.findOneAndUpdate(
    { userId, date },
    {
      $set: {
        reason: req.body?.reason ? String(req.body.reason).slice(0, 500) : null,
        markedBy: actorObjectId(req),
        updatedAt: new Date(),
      },
      $setOnInsert: { userId, date, createdAt: new Date() },
    },
    { new: true, upsert: true },
  );
  await Attendance.findOneAndUpdate(
    { userId, date },
    { $set: { userId, date, status: 'off_day', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  await logAudit(req, 'OFF_DAY_MARKED', userId, { offDayId: String(offDay._id) });
  return ok(res, { data: offDay }, 201);
});

router.get('/off-days', async (req, res) => {
  if (!ensureDb(res)) return;
  const query = {};
  if (can('offday_manage', req.user) || can('attendance_view_all', req.user)) {
    if (req.query.userId && mongoose.isValidObjectId(String(req.query.userId))) query.userId = String(req.query.userId);
  } else {
    query.userId = req.user.id;
  }
  const docs = await OffDay.find(query).sort({ date: -1 }).limit(300).populate('userId', 'name fullName email role').lean();
  return ok(res, { data: docs });
});

module.exports = router;