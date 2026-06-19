const express = require('express');
const mongoose = require('mongoose');

const Schedule = require('../models/Schedule');
const { logAudit } = require('../lib/audit');
const {
  actorObjectId,
  bad,
  can,
  ensureDb,
  ok,
  requirePermission,
  requireTeamAuth,
} = require('../lib/teamManagement');

const router = express.Router();

function normalizeObjectIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = String(raw || '').trim();
    if (!mongoose.isValidObjectId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeWeeklyOffDays(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const day = Number(raw);
    if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day)) continue;
    seen.add(day);
    out.push(day);
  }
  return out;
}

function scheduleDto(doc) {
  const raw = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  return raw ? { ...raw, id: String(raw._id) } : null;
}

function schedulePatch(body, partial = false) {
  const patch = {};
  if (!partial || body.title !== undefined) patch.title = String(body.title || '').trim();
  if (!partial || body.startTime !== undefined) patch.startTime = String(body.startTime || '').trim();
  if (!partial || body.endTime !== undefined) patch.endTime = String(body.endTime || '').trim();
  if (body.userIds !== undefined) patch.userIds = normalizeObjectIds(body.userIds);
  if (body.roleIds !== undefined) patch.roleIds = normalizeObjectIds(body.roleIds);
  if (body.weeklyOffDays !== undefined) patch.weeklyOffDays = normalizeWeeklyOffDays(body.weeklyOffDays);
  if (body.timezone !== undefined) patch.timezone = String(body.timezone || 'Asia/Kolkata').trim() || 'Asia/Kolkata';
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (!partial && (!patch.title || !patch.startTime || !patch.endTime)) return { error: 'title, startTime, and endTime are required' };
  return { patch };
}

function ownScheduleQuery(req) {
  const clauses = [];
  if (mongoose.isValidObjectId(String(req.user?.id || ''))) clauses.push({ userIds: req.user.id });
  if (mongoose.isValidObjectId(String(req.user?.roleId || ''))) clauses.push({ roleIds: req.user.roleId });
  return { active: true, ...(clauses.length ? { $or: clauses } : { userIds: req.user.id }) };
}

router.use('/schedules', requireTeamAuth);

router.post('/schedules', requirePermission('schedule_manage'), async (req, res) => {
  if (!ensureDb(res)) return;
  const parsed = schedulePatch(req.body || {}, false);
  if (parsed.error) return bad(res, 400, parsed.error, 'INVALID_SCHEDULE');
  const schedule = await Schedule.create({ ...parsed.patch, createdBy: actorObjectId(req), createdAt: new Date() });
  await logAudit(req, 'SCHEDULE_CREATED', null, { scheduleId: String(schedule._id) });
  return ok(res, { data: scheduleDto(schedule) }, 201);
});

router.get('/schedules', async (req, res) => {
  if (!ensureDb(res)) return;
  if (!can('schedule_manage', req.user) && !can('schedule_view_own', req.user)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
  const query = can('schedule_manage', req.user) ? {} : ownScheduleQuery(req);
  const docs = await Schedule.find(query).sort({ active: -1, title: 1 }).limit(300).lean();
  return ok(res, { data: docs.map(scheduleDto) });
});

router.get('/schedules/me', requirePermission('schedule_view_own'), async (req, res) => {
  if (!ensureDb(res)) return;
  const docs = await Schedule.find(ownScheduleQuery(req)).sort({ title: 1 }).limit(100).lean();
  return ok(res, { data: docs.map(scheduleDto) });
});

router.patch('/schedules/:id', requirePermission('schedule_manage'), async (req, res) => {
  if (!ensureDb(res)) return;
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid schedule id', 'INVALID_ID');
  const parsed = schedulePatch(req.body || {}, true);
  const schedule = await Schedule.findByIdAndUpdate(
    req.params.id,
    { $set: { ...parsed.patch, updatedAt: new Date() } },
    { new: true },
  );
  if (!schedule) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'SCHEDULE_UPDATED', null, { scheduleId: String(schedule._id) });
  return ok(res, { data: scheduleDto(schedule) });
});

router.delete('/schedules/:id', requirePermission('schedule_manage'), async (req, res) => {
  if (!ensureDb(res)) return;
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid schedule id', 'INVALID_ID');
  const schedule = await Schedule.findByIdAndDelete(req.params.id);
  if (!schedule) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'SCHEDULE_DELETED', null, { scheduleId: String(schedule._id) });
  return ok(res, { data: scheduleDto(schedule) });
});

module.exports = router;