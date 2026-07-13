const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const AiraBulletin = require('../models/AiraBulletin');
const {
  buildAiraLiveTvPatch,
  buildReplayLiveTvPatch,
  buildScheduledProgram,
  removeBulletinAssociations,
  resolveVideoSource,
  updateExistingLiveTv,
  upsertScheduledProgram,
} = require('../lib/airaLiveTv');

const router = express.Router();

const airaStatus = Object.freeze({
  enabled: true,
  phase: 'local-workflow-ready',
  displayStatus: 'AIRA Studio Ready',
  storageMode: 'local-test-mode',
  serverTtsConfigured: false,
  aiVideoProviderConfigured: false,
  manualVideoUrlEnabled: true,
  liveTvPublishConfigured: true,
  scheduleConfigured: true,
  message: 'AIRA manual bulletin workflow, approval, schedule metadata, and Live TV publishing are available in local testing mode.',
});

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function actorFromReq(req) {
  const admin = req.admin || {};
  return String(admin.email || admin.id || admin.name || '').trim();
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function hasOwn(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

function badRequest(res, message) {
  res.status(400).json({ ok: false, message });
  return null;
}

function unsupported(code) {
  return (_req, res) => res.status(200).json({ ok: false, code, message: code });
}

function toDto(doc) {
  const source = typeof doc?.toObject === 'function' ? doc.toObject() : (doc || {});
  return {
    id: source._id ? String(source._id) : (source.id ? String(source.id) : ''),
    title: source.title || '',
    language: source.language || '',
    bulletinType: source.bulletinType || '',
    durationMinutes: source.durationMinutes || null,
    scheduleDate: source.scheduleDate || '',
    scheduleTime: source.scheduleTime || '',
    endTime: source.endTime || '',
    publicLabel: source.publicLabel || '',
    anchorName: source.anchorName || '',
    anchorFace: source.anchorFace || '',
    dressStyle: source.dressStyle || '',
    voiceStyle: source.voiceStyle || '',
    tone: source.tone || '',
    studioTemplate: source.studioTemplate || '',
    script: source.script || '',
    audioUrl: source.audioUrl || '',
    videoUrl: source.videoUrl || '',
    visualBlocks: Array.isArray(source.visualBlocks) ? source.visualBlocks : [],
    status: source.status || 'Draft',
    publishStatus: source.publishStatus || '',
    liveTvAssociation: source.liveTvAssociation || null,
    createdBy: source.createdBy || '',
    updatedBy: source.updatedBy || '',
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function normalizeVisualBlocks(value, res) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    badRequest(res, 'visualBlocks must be an array');
    return null;
  }

  const { VISUAL_TYPE_VALUES } = AiraBulletin.enums;
  const blocks = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const block = item && typeof item === 'object' ? item : {};
    const visualType = normalizeString(block.visualType) || 'anchor_only';
    if (!VISUAL_TYPE_VALUES.includes(visualType)) {
      badRequest(res, `visualBlocks[${index}].visualType must be one of ${VISUAL_TYPE_VALUES.join(', ')}`);
      return null;
    }
    blocks.push({
      id: normalizeString(block.id),
      startTime: normalizeString(block.startTime),
      endTime: normalizeString(block.endTime),
      visualType,
      title: normalizeString(block.title),
      description: normalizeString(block.description),
      sourceCredit: normalizeString(block.sourceCredit),
      mediaUrl: normalizeString(block.mediaUrl),
    });
  }
  return blocks;
}

function buildBulletinPayload(body, res, options = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const payload = {};
  const enums = AiraBulletin.enums;

  const stringFields = [
    'title',
    'language',
    'bulletinType',
    'scheduleDate',
    'scheduleTime',
    'endTime',
    'publicLabel',
    'anchorName',
    'anchorFace',
    'dressStyle',
    'voiceStyle',
    'tone',
    'studioTemplate',
    'script',
    'audioUrl',
    'videoUrl',
    'status',
  ];

  for (const field of stringFields) {
    if (hasOwn(source, field)) payload[field] = normalizeString(source[field]);
  }

  if (hasOwn(source, 'durationMinutes')) {
    const durationMinutes = Number(source.durationMinutes);
    if (!Number.isFinite(durationMinutes)) return badRequest(res, 'durationMinutes must be a number');
    payload.durationMinutes = durationMinutes;
  }

  if (hasOwn(source, 'visualBlocks')) {
    const visualBlocks = normalizeVisualBlocks(source.visualBlocks, res);
    if (!visualBlocks) return null;
    payload.visualBlocks = visualBlocks;
  }

  if (options.create) {
    if (!normalizeString(payload.title)) return badRequest(res, 'title is required');
    if (!normalizeString(payload.language)) return badRequest(res, 'language is required');
  } else {
    if (hasOwn(payload, 'title') && !payload.title) return badRequest(res, 'title is required');
    if (hasOwn(payload, 'language') && !payload.language) return badRequest(res, 'language is required');
  }

  if (payload.language && !enums.LANGUAGE_VALUES.includes(payload.language)) {
    return badRequest(res, `language must be one of ${enums.LANGUAGE_VALUES.join(', ')}`);
  }
  if (payload.bulletinType && !enums.BULLETIN_TYPE_VALUES.includes(payload.bulletinType)) {
    return badRequest(res, `bulletinType must be one of ${enums.BULLETIN_TYPE_VALUES.join(', ')}`);
  }
  if (payload.durationMinutes !== undefined && !enums.DURATION_MINUTES_VALUES.includes(payload.durationMinutes)) {
    return badRequest(res, `durationMinutes must be one of ${enums.DURATION_MINUTES_VALUES.join(', ')}`);
  }
  if (payload.publicLabel && !enums.PUBLIC_LABEL_VALUES.includes(payload.publicLabel)) {
    return badRequest(res, `publicLabel must be one of ${enums.PUBLIC_LABEL_VALUES.join(', ')}`);
  }
  if (payload.status && !enums.STATUS_VALUES.includes(payload.status)) {
    return badRequest(res, `status must be one of ${enums.STATUS_VALUES.join(', ')}`);
  }

  if (payload.status && payload.status !== 'Draft' && !normalizeString(payload.script)) {
    return badRequest(res, 'script is required before moving a bulletin out of Draft');
  }

  if (!payload.bulletinType && options.create) payload.bulletinType = 'Morning';
  if (!payload.durationMinutes && options.create) payload.durationMinutes = 5;
  if (!payload.publicLabel && options.create) payload.publicLabel = 'AIRA BULLETIN';
  if (!payload.status && options.create) payload.status = 'Draft';
  if (!payload.visualBlocks && options.create) payload.visualBlocks = [];

  return payload;
}

async function findBulletin(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ ok: false, code: 'AIRA_BULLETIN_NOT_FOUND', message: 'AIRA_BULLETIN_NOT_FOUND' });
    return null;
  }
  const bulletin = await AiraBulletin.findById(id);
  if (!bulletin) {
    res.status(404).json({ ok: false, code: 'AIRA_BULLETIN_NOT_FOUND', message: 'AIRA_BULLETIN_NOT_FOUND' });
    return null;
  }
  return bulletin;
}

router.get('/status', (_req, res) => res.status(200).json(airaStatus));

router.post('/bulletins/:id/generate-voice', unsupported('SERVER_TTS_NOT_CONFIGURED'));
router.post('/bulletins/:id/generate-video', unsupported('AI_VIDEO_PROVIDER_NOT_CONFIGURED'));

router.use('/bulletins', requireAdminAuth);

function codeResponse(res, status, code) {
  return res.status(status).json({ ok: false, code, message: code });
}

function ensureApprovedForLiveTv(bulletin, res) {
  if (!bulletin) return false;
  if (String(bulletin.status || '') !== 'Approved') {
    codeResponse(res, 409, 'AIRA_BULLETIN_NOT_APPROVED');
    return false;
  }
  return true;
}

function ensurePlayableVideo(bulletin, res) {
  if (!normalizeString(bulletin?.videoUrl) || !resolveVideoSource(bulletin.videoUrl)) {
    codeResponse(res, 400, 'AIRA_BULLETIN_VIDEO_REQUIRED');
    return false;
  }
  return true;
}

router.get('/bulletins/approved/live-tv-ready', async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const docs = await AiraBulletin.find({ status: 'Approved', videoUrl: { $ne: '' } }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      ok: true,
      bulletins: docs.filter((doc) => doc.status !== 'Archived' && resolveVideoSource(doc.videoUrl)).map(toDto),
    });
  } catch (error) {
    console.error('[aira][liveTvReady] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to fetch Live TV-ready AIRA bulletins', error: error.message });
  }
});

router.get('/bulletins', async (_req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const docs = await AiraBulletin.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ ok: true, bulletins: docs.map(toDto) });
  } catch (error) {
    console.error('[aira][listBulletins] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to fetch AIRA bulletins', error: error.message });
  }
});

router.get('/bulletins/:id', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const bulletin = await findBulletin(req.params.id, res);
    if (!bulletin) return null;
    return res.status(200).json({ ok: true, bulletin: toDto(bulletin) });
  } catch (error) {
    console.error('[aira][getBulletin] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to fetch AIRA bulletin', error: error.message });
  }
});

router.post('/bulletins', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const payload = buildBulletinPayload(req.body, res, { create: true });
    if (!payload || res.headersSent) return null;
    const actor = actorFromReq(req);
    const created = await AiraBulletin.create({ ...payload, createdBy: actor, updatedBy: actor });
    return res.status(201).json({ ok: true, bulletin: toDto(created) });
  } catch (error) {
    console.error('[aira][createBulletin] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to create AIRA bulletin', error: error.message });
  }
});

router.patch('/bulletins/:id', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ ok: false, code: 'AIRA_BULLETIN_NOT_FOUND', message: 'AIRA_BULLETIN_NOT_FOUND' });
    const payload = buildBulletinPayload(req.body, res);
    if (!payload || res.headersSent) return null;
    payload.updatedBy = actorFromReq(req);
    const updated = await AiraBulletin.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ ok: false, code: 'AIRA_BULLETIN_NOT_FOUND', message: 'AIRA_BULLETIN_NOT_FOUND' });
    return res.status(200).json({ ok: true, bulletin: toDto(updated) });
  } catch (error) {
    console.error('[aira][updateBulletin] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to update AIRA bulletin', error: error.message });
  }
});

function transitionStatus(status) {
  return async (req, res) => {
    try {
      if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
      const bulletin = await findBulletin(req.params.id, res);
      if (!bulletin) return null;
      if (status !== 'Draft' && !normalizeString(bulletin.script)) {
        return badRequest(res, 'script is required before moving a bulletin out of Draft');
      }
      bulletin.status = status;
      bulletin.updatedBy = actorFromReq(req);
      await bulletin.save();
      return res.status(200).json({ ok: true, bulletin: toDto(bulletin) });
    } catch (error) {
      console.error('[aira][transitionStatus] error:', error);
      return res.status(500).json({ ok: false, message: 'Failed to update AIRA bulletin status', error: error.message });
    }
  };
}

router.post('/bulletins/:id/ready-for-review', transitionStatus('Ready for Review'));
router.post('/bulletins/:id/approve', transitionStatus('Approved'));
router.post('/bulletins/:id/reject', transitionStatus('Rejected'));
router.post('/bulletins/:id/archive', transitionStatus('Archived'));

router.post('/bulletins/:id/publish-to-live-tv', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const bulletin = await findBulletin(req.params.id, res);
    if (!bulletin) return null;
    if (!ensureApprovedForLiveTv(bulletin, res)) return null;
    if (!ensurePlayableVideo(bulletin, res)) return null;

    const patch = buildAiraLiveTvPatch(bulletin, req.body || {});
    if (!patch) return codeResponse(res, 400, 'AIRA_BULLETIN_VIDEO_REQUIRED');
    const liveTv = await updateExistingLiveTv((current) => ({ ...current, ...patch }));

    bulletin.publishStatus = 'Published';
    bulletin.publicLabel = normalizeString(req.body?.label) || bulletin.publicLabel || 'AIRA BULLETIN • ON AIR';
    bulletin.liveTvAssociation = { sourceType: 'aira_bulletin', publishedAt: new Date().toISOString(), liveTv };
    bulletin.updatedBy = actorFromReq(req);
    await bulletin.save();

    return res.status(200).json({ ok: true, bulletin: toDto(bulletin), liveTv });
  } catch (error) {
    console.error('[aira][publishToLiveTv] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_SETTINGS_UPDATE_FAILED');
  }
});

router.post('/bulletins/:id/schedule-live-tv', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const bulletin = await findBulletin(req.params.id, res);
    if (!bulletin) return null;
    if (!ensureApprovedForLiveTv(bulletin, res)) return null;
    if (!ensurePlayableVideo(bulletin, res)) return null;

    const schedule = buildScheduledProgram(bulletin, req.body || {});
    if (!schedule) return codeResponse(res, 400, 'AIRA_BULLETIN_VIDEO_REQUIRED');
    const liveTv = await updateExistingLiveTv((current) => ({
      ...current,
      scheduledPrograms: upsertScheduledProgram(current, schedule),
      updatedAt: new Date().toISOString(),
    }));

    bulletin.scheduleDate = schedule.scheduleDate || bulletin.scheduleDate;
    bulletin.scheduleTime = schedule.startTime || bulletin.scheduleTime;
    bulletin.endTime = schedule.endTime || bulletin.endTime;
    bulletin.publicLabel = schedule.label || bulletin.publicLabel || 'SCHEDULED';
    bulletin.publishStatus = 'Scheduled';
    bulletin.liveTvAssociation = { sourceType: 'scheduled_program', schedule };
    bulletin.updatedBy = actorFromReq(req);
    await bulletin.save();

    return res.status(200).json({ ok: true, bulletin: toDto(bulletin), schedule, liveTv });
  } catch (error) {
    console.error('[aira][scheduleLiveTv] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_SETTINGS_UPDATE_FAILED');
  }
});

router.post('/bulletins/:id/set-as-replay', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const bulletin = await findBulletin(req.params.id, res);
    if (!bulletin) return null;
    if (!ensurePlayableVideo(bulletin, res)) return null;

    const patch = buildReplayLiveTvPatch(bulletin);
    if (!patch) return codeResponse(res, 400, 'AIRA_BULLETIN_VIDEO_REQUIRED');
    const liveTv = await updateExistingLiveTv((current) => ({ ...current, ...patch }));

    bulletin.publishStatus = 'Replay';
    bulletin.publicLabel = 'REPLAY';
    bulletin.liveTvAssociation = { sourceType: 'offline_replay', publishedAt: new Date().toISOString(), liveTv };
    bulletin.updatedBy = actorFromReq(req);
    await bulletin.save();

    return res.status(200).json({ ok: true, bulletin: toDto(bulletin), liveTv });
  } catch (error) {
    console.error('[aira][setAsReplay] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_SETTINGS_UPDATE_FAILED');
  }
});

router.post('/bulletins/:id/remove-from-live-tv', async (req, res) => {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });
    const bulletin = await findBulletin(req.params.id, res);
    if (!bulletin) return null;
    const bulletinId = String(bulletin._id || bulletin.id || '');
    const liveTv = await updateExistingLiveTv((current) => removeBulletinAssociations(current, bulletinId));

    bulletin.publishStatus = '';
    bulletin.liveTvAssociation = null;
    bulletin.updatedBy = actorFromReq(req);
    await bulletin.save();

    return res.status(200).json({ ok: true, bulletin: toDto(bulletin), liveTv });
  } catch (error) {
    console.error('[aira][removeFromLiveTv] error:', error);
    return codeResponse(res, 500, 'LIVE_TV_SETTINGS_UPDATE_FAILED');
  }
});

module.exports = router;