const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');

const PublicSiteSettings = require('../models/PublicSiteSettings');
const AiraBulletin = require('../models/AiraBulletin');
const LiveTvSchedule = require('../models/LiveTvSchedule');
const { ensureCategoryStripEnabled } = require('../controllers/publicSiteSettingsController');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { deleteMediaLibraryItem, uploadMediaLibraryFile } = require('../lib/mediaLibraryStorage');
const { createIndexedMediaRecord } = require('../services/mediaLibraryService');
const {
  LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES,
  LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES,
  assertAllowedLiveTvOfflinePosterMimeType,
  assertAllowedLiveTvOfflineVideoMimeType,
} = require('../lib/mediaUploadValidation');
const {
  resolveVideoSource,
  toCurrentSource,
  updateExistingLiveTv,
} = require('../lib/airaLiveTv');

const router = express.Router();
const originalLiveTvScheduleFind = LiveTvSchedule.find;
const offlineMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function canReadLiveTvSchedule() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1 && mongoose.connection.db)
    || LiveTvSchedule.find !== originalLiveTvScheduleFind;
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function hasOwn(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

function actorFromReq(req) {
  const admin = req.admin || {};
  return normalizeString(admin.email || admin.id || admin.name);
}

function codeResponse(res, status, code, extra = {}) {
  return res.status(status).json({ ok: false, code, message: code, ...extra });
}

function cleanErrorResponse(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, success: false, message, ...extra });
}

function pickUploadFile(req, preferredFields = []) {
  if (req.file) return req.file;
  const files = req.files;
  if (!files) return null;
  if (Array.isArray(files)) {
    for (const fieldName of preferredFields) {
      const match = files.find((file) => String(file?.fieldname || '') === fieldName);
      if (match) return match;
    }
    return files[0] || null;
  }
  for (const fieldName of preferredFields) {
    const fieldFiles = files[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles[0]) return fieldFiles[0];
  }
  for (const fieldName of Object.keys(files)) {
    const fieldFiles = files[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles[0]) return fieldFiles[0];
  }
  return null;
}

function publicUploadUrl(uploaded) {
  return normalizeString(uploaded?.relativeUrl) || normalizeString(uploaded?.assetUrl) || normalizeString(uploaded?.url) || normalizeString(uploaded?.secureUrl);
}

function handleOfflineUpload(kind) {
  const isPoster = kind === 'poster';
  const preferredFields = isPoster ? ['offlinePosterImage', 'poster', 'image', 'file', 'media'] : ['offlineLoopVideo', 'video', 'file', 'media'];
  const allowedMimeTypes = isPoster ? LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES : LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES;
  const assertMimeType = isPoster ? assertAllowedLiveTvOfflinePosterMimeType : assertAllowedLiveTvOfflineVideoMimeType;
  const source = isPoster ? 'live-tv-offline-poster' : 'live-tv-offline-loop-video';

  return async (req, res) => {
    let uploaded = null;
    try {
      const file = pickUploadFile(req, preferredFields);
      if (!file) return cleanErrorResponse(res, 400, `No file uploaded. Use multipart field '${preferredFields[0]}' or 'file'.`);
      if (!file.buffer || !Buffer.isBuffer(file.buffer)) return cleanErrorResponse(res, 400, 'Invalid upload');
      if (file.buffer.length === 0 || file.size === 0) return cleanErrorResponse(res, 400, 'Uploaded file is empty');

      const mimeType = assertMimeType(file.mimetype);
      uploaded = await uploadMediaLibraryFile(req, file, {
        allowedMimeTypes,
        validationMessage: isPoster
          ? 'Only JPG, JPEG, PNG, and WEBP images are allowed for Live TV offline poster uploads.'
          : 'Only MP4 and WEBM videos are allowed for Live TV offline loop uploads.',
      });

      const mediaRecord = await createIndexedMediaRecord(req, uploaded, {
        source,
        mediaType: isPoster ? 'image' : 'video',
      });
      const url = publicUploadUrl(uploaded) || publicUploadUrl(mediaRecord);
      return res.status(200).json({
        ok: true,
        success: true,
        url,
        data: {
          url,
          media: mediaRecord,
          mimeType,
          field: isPoster ? 'offlinePosterImageUrl' : 'offlineLoopVideoUrl',
        },
      });
    } catch (error) {
      if (uploaded && uploaded.id) {
        try { await deleteMediaLibraryItem(uploaded.id); } catch (_) {}
      }
      const status = typeof error?.status === 'number' ? error.status : 500;
      return cleanErrorResponse(res, status, error?.message || 'Live TV offline media upload failed', { code: error?.code || undefined });
    }
  };
}

function toMinutes(time) {
  const raw = normalizeString(time);
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function timeFromMinutes(totalMinutes) {
  const normalized = Math.max(0, Math.min(totalMinutes, 24 * 60 - 1));
  const hours = String(Math.floor(normalized / 60)).padStart(2, '0');
  const minutes = String(normalized % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function effectiveEndTime(entry) {
  const end = normalizeString(entry.endTime);
  if (end) return end;
  const startMinutes = toMinutes(entry.startTime);
  const duration = Number(entry.durationMinutes);
  if (startMinutes === null || !Number.isFinite(duration) || duration <= 0) return '';
  return timeFromMinutes(startMinutes + duration);
}

function isWithinWindow(entry, now = new Date()) {
  const date = normalizeString(entry.date || entry.scheduleDate);
  const start = normalizeString(entry.startTime);
  const end = effectiveEndTime(entry);
  if (!date || !start || !end) return false;
  const startDate = new Date(`${date}T${start}:00`);
  let endDate = new Date(`${date}T${end}:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return false;
  if (endDate < startDate) endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
  return now >= startDate && now <= endDate;
}

function scheduleDto(doc) {
  const source = typeof doc?.toObject === 'function' ? doc.toObject() : (doc || {});
  return {
    id: source._id ? String(source._id) : (source.id ? String(source.id) : ''),
    programTitle: source.programTitle || '',
    sourceType: source.sourceType || '',
    label: source.label || '',
    date: source.date || '',
    startTime: source.startTime || '',
    endTime: source.endTime || '',
    durationMinutes: source.durationMinutes || null,
    selectedAiraBulletinId: source.selectedAiraBulletinId || '',
    videoUrl: source.videoUrl || '',
    embedUrl: source.embedUrl || '',
    sponsorName: source.sponsorName || '',
    sponsorLabel: source.sponsorLabel || '',
    status: source.status || 'draft',
    priority: source.priority || 'normal',
    repeat: source.repeat || 'none',
    createdBy: source.createdBy || '',
    updatedBy: source.updatedBy || '',
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function sourceMode(sourceType) {
  switch (sourceType) {
    case 'aira_bulletin': return 'AIRA Bulletin';
    case 'offline_replay': return 'Offline Replay';
    case 'scheduled_program': return 'Scheduled Show';
    case 'breaking_bulletin': return 'Breaking Mode';
    case 'maintenance': return 'Maintenance / Coming Soon';
    case 'youtube_live':
    case 'custom_embed':
    case 'sponsored_program':
    default:
      return 'News Pulse Live';
  }
}

function sourceStatus(sourceType, status = 'active') {
  if (sourceType === 'offline_replay') return 'replay';
  if (sourceType === 'scheduled_program' && status !== 'active') return 'scheduled';
  if (sourceType === 'maintenance') return 'maintenance';
  return 'live';
}

function scheduleToLiveTv(entry, options = {}) {
  const source = scheduleDto(entry);
  const videoCandidate = normalizeString(source.videoUrl) || normalizeString(source.embedUrl);
  const video = resolveVideoSource(videoCandidate);
  const isEmbedOnly = !video && normalizeString(source.embedUrl);
  const provider = video?.kind === 'youtube' ? 'YouTube' : 'Custom Embed';
  return {
    enabled: source.sourceType !== 'maintenance',
    mode: sourceMode(source.sourceType),
    provider,
    embedUrl: video?.embedUrl || (isEmbedOnly ? source.embedUrl : ''),
    fallbackVideoUrl: video?.fallbackVideoUrl || source.videoUrl || '',
    title: source.programTitle,
    subtitle: source.sponsorLabel || source.sponsorName || '',
    language: 'English',
    showOnHomepage: true,
    status: sourceStatus(source.sourceType, source.status),
    sourceType: source.sourceType,
    currentProgramTitle: source.programTitle,
    currentProgramLabel: source.label,
    currentProgramType: source.sourceType,
    currentVideoUrl: video?.videoUrl || source.videoUrl || source.embedUrl || '',
    selectedAiraBulletinId: source.selectedAiraBulletinId,
    scheduleEntryId: source.id,
    startTime: source.startTime,
    endTime: source.endTime || effectiveEndTime(source),
    updatedAt: new Date().toISOString(),
    ...(options.extra || {}),
  };
}

async function getPublishedLiveTv() {
  const settings = await PublicSiteSettings.getOrCreate();
  const published = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());
  return published.liveTv;
}

async function findScheduleOr404(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    codeResponse(res, 404, 'LIVE_TV_SCHEDULE_NOT_FOUND');
    return null;
  }
  const entry = await LiveTvSchedule.findById(id);
  if (!entry) {
    codeResponse(res, 404, 'LIVE_TV_SCHEDULE_NOT_FOUND');
    return null;
  }
  return entry;
}

async function validateAiraBulletin(payload, res) {
  if (payload.sourceType !== 'aira_bulletin') return true;
  if (!payload.selectedAiraBulletinId) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (!mongoose.isValidObjectId(payload.selectedAiraBulletinId)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  const bulletin = await AiraBulletin.findById(payload.selectedAiraBulletinId);
  if (!bulletin) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (String(bulletin.status || '') !== 'Approved') return codeResponse(res, 409, 'AIRA_BULLETIN_NOT_APPROVED');
  if (!normalizeString(bulletin.videoUrl)) return codeResponse(res, 400, 'AIRA_BULLETIN_VIDEO_REQUIRED');

  payload.programTitle = payload.programTitle || normalizeString(bulletin.title);
  payload.videoUrl = payload.videoUrl || normalizeString(bulletin.videoUrl);
  const video = resolveVideoSource(payload.videoUrl);
  if (video && !payload.embedUrl) payload.embedUrl = video.embedUrl;
  return true;
}

function buildSchedulePayload(body, res, options = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const payload = {};
  const enums = LiveTvSchedule.enums;
  const stringFields = ['programTitle', 'sourceType', 'label', 'date', 'startTime', 'endTime', 'selectedAiraBulletinId', 'videoUrl', 'embedUrl', 'sponsorName', 'sponsorLabel', 'status', 'priority', 'repeat'];
  for (const field of stringFields) {
    if (hasOwn(source, field)) payload[field] = normalizeString(source[field]);
  }
  if (hasOwn(source, 'durationMinutes')) {
    const duration = Number(source.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
    payload.durationMinutes = duration;
  }

  if (options.create) {
    for (const field of ['programTitle', 'sourceType', 'label', 'date', 'startTime']) {
      if (!normalizeString(payload[field])) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
    }
    if (!normalizeString(payload.endTime) && !payload.durationMinutes) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  }

  if (payload.sourceType && !enums.SOURCE_TYPE_VALUES.includes(payload.sourceType)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (payload.label && !enums.LABEL_VALUES.includes(payload.label)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (payload.status && !enums.STATUS_VALUES.includes(payload.status)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (payload.priority && !enums.PRIORITY_VALUES.includes(payload.priority)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  if (payload.repeat && !enums.REPEAT_VALUES.includes(payload.repeat)) return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');

  if (options.create) {
    payload.status = payload.status || 'scheduled';
    payload.priority = payload.priority || 'normal';
    payload.repeat = payload.repeat || 'none';
  }

  const sourceType = payload.sourceType || options.existing?.sourceType || '';
  const videoUrl = payload.videoUrl !== undefined ? payload.videoUrl : normalizeString(options.existing?.videoUrl);
  const embedUrl = payload.embedUrl !== undefined ? payload.embedUrl : normalizeString(options.existing?.embedUrl);
  if ((sourceType === 'youtube_live' || sourceType === 'custom_embed' || sourceType === 'sponsored_program') && !videoUrl && !embedUrl) {
    return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
  }

  return payload;
}

function rangesOverlap(a, b) {
  const aStart = toMinutes(a.startTime);
  const aEnd = toMinutes(effectiveEndTime(a));
  const bStart = toMinutes(b.startTime);
  const bEnd = toMinutes(effectiveEndTime(b));
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  return aStart < bEnd && bStart < aEnd;
}

async function findOverlaps(payload, excludeId = '') {
  const date = normalizeString(payload.date);
  if (!date) return [];
  const docs = await LiveTvSchedule.find({ date }).sort({ startTime: 1 }).lean();
  return docs
    .filter((doc) => String(doc._id || doc.id || '') !== String(excludeId))
    .filter((doc) => !['disabled', 'completed'].includes(String(doc.status || '').toLowerCase()))
    .filter((doc) => rangesOverlap(payload, doc))
    .map(scheduleDto);
}

async function activeScheduleSource() {
  if (!canReadLiveTvSchedule()) return null;
  let docs = [];
  try {
    docs = await LiveTvSchedule.find({ status: { $in: ['active', 'scheduled'] } }).sort({ date: 1, startTime: 1, createdAt: -1 }).lean();
  } catch (error) {
    console.warn('[live-tv][activeScheduleSource] schedule lookup skipped:', error.message);
    return null;
  }
  const activeBreaking = docs.find((doc) => doc.status === 'active' && doc.sourceType === 'breaking_bulletin');
  if (activeBreaking) return scheduleToLiveTv(activeBreaking);
  const activeManual = docs.find((doc) => doc.status === 'active' && ['youtube_live', 'custom_embed'].includes(doc.sourceType));
  if (activeManual) return scheduleToLiveTv(activeManual);
  const currentScheduled = docs.find((doc) => ['active', 'scheduled'].includes(doc.status) && isWithinWindow(doc));
  if (currentScheduled) return scheduleToLiveTv({ ...currentScheduled, sourceType: currentScheduled.sourceType === 'aira_bulletin' ? 'scheduled_program' : currentScheduled.sourceType });
  return null;
}

router.get('/current-source', async (_req, res) => {
  try {
    if (!isDbReady()) {
      const fallback = ensureCategoryStripEnabled(PublicSiteSettings.getDefaultSettings()).liveTv;
      return res.status(200).json(toCurrentSource(fallback));
    }
    const currentSettingsSource = toCurrentSource(await getPublishedLiveTv());
    const scheduledSource = await activeScheduleSource();
    if (scheduledSource) {
      const scheduledCurrentSource = toCurrentSource(scheduledSource);
      if (scheduledCurrentSource.sourceType === 'breaking_bulletin') return res.status(200).json(scheduledCurrentSource);
      if (currentSettingsSource.sourceType === 'breaking_bulletin') return res.status(200).json(currentSettingsSource);
      if (['youtube_live', 'custom_embed', 'aira_bulletin', 'sponsored_program'].includes(currentSettingsSource.sourceType)) return res.status(200).json(currentSettingsSource);
      if (['youtube_live', 'custom_embed', 'scheduled_program'].includes(scheduledCurrentSource.sourceType)) return res.status(200).json(scheduledCurrentSource);
    }
    return res.status(200).json(currentSettingsSource);
  } catch (error) {
    console.error('[live-tv][current-source] error:', error);
    return res.status(200).json(toCurrentSource({ enabled: false, sourceType: 'maintenance' }));
  }
});

router.post('/upload-offline-poster', requireAdminAuth, offlineMediaUpload.any(), handleOfflineUpload('poster'));
router.post('/upload-offline-video', requireAdminAuth, offlineMediaUpload.any(), handleOfflineUpload('video'));

router.get('/schedule/upcoming', requireAdminAuth, async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const today = new Date().toISOString().slice(0, 10);
    const docs = await LiveTvSchedule.find({ date: { $gte: today }, status: 'scheduled' }).sort({ date: 1, startTime: 1 }).lean();
    return res.status(200).json({ ok: true, schedule: docs.map(scheduleDto) });
  } catch (error) {
    console.error('[live-tv][scheduleUpcoming] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get('/schedule', requireAdminAuth, async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const docs = await LiveTvSchedule.find({}).sort({ date: 1, startTime: 1, createdAt: -1 }).lean();
    return res.status(200).json({ ok: true, schedule: docs.map(scheduleDto) });
  } catch (error) {
    console.error('[live-tv][scheduleList] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get('/schedule/:id', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const entry = await findScheduleOr404(req.params.id, res);
    if (!entry) return null;
    return res.status(200).json({ ok: true, schedule: scheduleDto(entry) });
  } catch (error) {
    console.error('[live-tv][scheduleGet] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post('/schedule', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const payload = buildSchedulePayload(req.body, res, { create: true });
    if (!payload || res.headersSent) return null;
    const airaOk = await validateAiraBulletin(payload, res);
    if (!airaOk || res.headersSent) return null;
    const overlaps = await findOverlaps(payload);
    if (overlaps.length && req.body?.forceSave !== true) {
      return codeResponse(res, 409, 'LIVE_TV_SCHEDULE_TIME_OVERLAP', { warning: 'SCHEDULE_TIME_OVERLAP', overlaps });
    }
    const actor = actorFromReq(req);
    const created = await LiveTvSchedule.create({ ...payload, createdBy: actor, updatedBy: actor });
    return res.status(201).json({ ok: true, schedule: scheduleDto(created), ...(overlaps.length ? { warning: 'SCHEDULE_TIME_OVERLAP', overlaps } : {}) });
  } catch (error) {
    console.error('[live-tv][scheduleCreate] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.patch('/schedule/:id', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const existing = await findScheduleOr404(req.params.id, res);
    if (!existing) return null;
    const existingDto = scheduleDto(existing);
    const payload = buildSchedulePayload(req.body, res, { existing: existingDto });
    if (!payload || res.headersSent) return null;
    const merged = { ...existingDto, ...payload };
    const airaOk = await validateAiraBulletin(merged, res);
    if (!airaOk || res.headersSent) return null;
    const overlaps = await findOverlaps(merged, existingDto.id);
    if (overlaps.length && req.body?.forceSave !== true) {
      return codeResponse(res, 409, 'LIVE_TV_SCHEDULE_TIME_OVERLAP', { warning: 'SCHEDULE_TIME_OVERLAP', overlaps });
    }
    payload.updatedBy = actorFromReq(req);
    const updated = await LiveTvSchedule.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true });
    if (!updated) return codeResponse(res, 404, 'LIVE_TV_SCHEDULE_NOT_FOUND');
    return res.status(200).json({ ok: true, schedule: scheduleDto(updated), ...(overlaps.length ? { warning: 'SCHEDULE_TIME_OVERLAP', overlaps } : {}) });
  } catch (error) {
    console.error('[live-tv][scheduleUpdate] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post('/schedule/:id/activate-now', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const entry = await findScheduleOr404(req.params.id, res);
    if (!entry) return null;
    const liveTvPatch = scheduleToLiveTv(entry, { extra: { status: sourceStatus(entry.sourceType, 'active') } });
    const liveTv = await updateExistingLiveTv((current) => ({ ...current, ...liveTvPatch }));
    entry.status = 'active';
    entry.updatedBy = actorFromReq(req);
    await entry.save();
    return res.status(200).json({ ok: true, schedule: scheduleDto(entry), liveTv });
  } catch (error) {
    console.error('[live-tv][scheduleActivate] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_CURRENT_SOURCE_UNAVAILABLE');
  }
});

router.post('/schedule/:id/disable', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const entry = await findScheduleOr404(req.params.id, res);
    if (!entry) return null;
    entry.status = 'disabled';
    entry.updatedBy = actorFromReq(req);
    await entry.save();
    return res.status(200).json({ ok: true, schedule: scheduleDto(entry) });
  } catch (error) {
    console.error('[live-tv][scheduleDisable] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete('/schedule/:id', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    if (!mongoose.isValidObjectId(req.params.id)) return codeResponse(res, 404, 'LIVE_TV_SCHEDULE_NOT_FOUND');
    const deleted = await LiveTvSchedule.findByIdAndDelete(req.params.id);
    if (!deleted) return codeResponse(res, 404, 'LIVE_TV_SCHEDULE_NOT_FOUND');
    return res.status(200).json({ ok: true, deleted: true, id: req.params.id });
  } catch (error) {
    console.error('[live-tv][scheduleDelete] error:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post('/manual-override', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const body = req.body || {};
    const sourceType = normalizeString(body.sourceType);
    if (!['youtube_live', 'custom_embed', 'breaking_bulletin', 'sponsored_program', 'maintenance'].includes(sourceType)) {
      return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
    }
    if (sourceType !== 'maintenance' && !normalizeString(body.embedUrl) && !normalizeString(body.videoUrl)) {
      return codeResponse(res, 400, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');
    }
    const patch = scheduleToLiveTv({
      programTitle: normalizeString(body.title) || 'Live TV',
      sourceType,
      label: normalizeString(body.label) || (sourceType === 'breaking_bulletin' ? 'BREAKING BULLETIN' : 'LIVE'),
      date: new Date().toISOString().slice(0, 10),
      startTime: normalizeString(body.startTime),
      endTime: normalizeString(body.endTime),
      videoUrl: normalizeString(body.videoUrl),
      embedUrl: normalizeString(body.embedUrl),
      status: 'active',
      priority: sourceType === 'breaking_bulletin' ? 'breaking' : 'high',
    });
    const liveTv = await updateExistingLiveTv((current) => ({ ...current, ...patch }));
    return res.status(200).json({ ok: true, liveTv, currentSource: toCurrentSource(liveTv) });
  } catch (error) {
    console.error('[live-tv][manualOverride] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_CURRENT_SOURCE_UNAVAILABLE');
  }
});

router.post('/resume-schedule', requireAdminAuth, async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const scheduledSource = await activeScheduleSource();
    if (scheduledSource) return res.status(200).json({ ok: true, currentSource: toCurrentSource(scheduledSource) });
    const currentSource = toCurrentSource(await getPublishedLiveTv());
    return res.status(200).json({ ok: true, currentSource });
  } catch (error) {
    console.error('[live-tv][resumeSchedule] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_CURRENT_SOURCE_UNAVAILABLE');
  }
});

module.exports = router;