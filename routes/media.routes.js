const express = require('express');
const multer = require('multer');

const {
  getMediaLibraryProviderStatus,
  deleteMediaLibraryItem,
  restoreLocalMediaItem,
  trashLocalMediaItem,
  uploadMediaLibraryFile,
} = require('../lib/mediaLibraryStorage');
const {
  createIndexedMediaRecord,
  findMediaRecordByIdOrStorageId,
  getIndexedMediaStats,
  listIndexedMediaRecords,
  mapMediaRecord,
  markMediaDeleted,
  removeMediaRecord,
  restoreMediaRecord,
  verifyIndexedMediaRecordReadable,
  verifyIndexedMediaRecordVisible,
} = require('../services/mediaLibraryService');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { optionalAdminAuth } = require('../middleware/optionalAdminAuth');
const { shouldLog } = require('../lib/logThrottle');
const { assertAllowedAdminMediaMimeType } = require('../lib/mediaUploadValidation');

const router = express.Router();
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function isLocalhostDev() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  return env !== 'production' && !process.env.RENDER;
}

function logLocalMediaUpload(details) {
  if (!isLocalhostDev()) return;
  // eslint-disable-next-line no-console
  console.log('[media.upload.local]', details);
}

function logLocalMediaRoute(tag, details) {
  if (!isLocalhostDev()) return;
  // eslint-disable-next-line no-console
  console.log(tag, details);
}

function normalizeMediaIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return Array.from(new Set(rawIds.map((value) => String(value || '').trim()).filter(Boolean)));
}

function isMediaTrashed(doc) {
  return !!doc && (doc.isDeleted === true || String(doc.status || '').toLowerCase() === 'trash' || String(doc.status || '').toLowerCase() === 'deleted');
}

async function restoreMediaItemById(itemId, req) {
  const providerStatus = getMediaLibraryProviderStatus();
  if (providerStatus.provider !== 'local-disk') {
    const err = new Error('Restore is only available for local media storage');
    err.status = 409;
    err.reason = 'restore not supported for current media provider';
    throw err;
  }

  const indexed = await restoreMediaRecord(itemId);
  restoreLocalMediaItem(indexed.storageId || itemId);
  return indexed;
}

async function permanentlyDeleteMediaItemById(itemId) {
  const existing = await findMediaRecordByIdOrStorageId(itemId);
  if (!existing) {
    const err = new Error('Media record not found');
    err.status = 404;
    throw err;
  }

  if (!isMediaTrashed(existing)) {
    const err = new Error('Permanent delete is only allowed for media already in Trash.');
    err.status = 409;
    err.code = 'MEDIA_NOT_IN_TRASH';
    throw err;
  }

  const storageId = existing.storageId ? String(existing.storageId) : itemId;
  const result = await deleteMediaLibraryItem(storageId);
  await removeMediaRecord(String(existing._id));
  return {
    id: String(existing._id),
    storageId,
    result,
  };
}

function pickMediaFile(req) {
  if (req.file) return req.file;
  const files = req.files;
  if (!files) return null;
  if (Array.isArray(files)) return files[0] || null;

  for (const fieldName of ['file', 'media', 'image', 'cover']) {
    const fieldFiles = files[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles[0]) return fieldFiles[0];
  }

  for (const fieldName of Object.keys(files)) {
    const fieldFiles = files[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles[0]) return fieldFiles[0];
  }

  return null;
}

function sendStableStatus(res, payload) {
  const ok = true;
  const provider = String((payload && payload.provider) || 'none');
  const available = Boolean(payload && payload.available);
  const reason = available ? null : String((payload && payload.reason) || 'Media upload status unavailable');
  const configured = Boolean(payload && payload.configured);
  const message = String((payload && payload.message) || (available ? 'Media uploads are ready' : reason));

  return res.status(200).json({
    ok,
    provider,
    available,
    reason,
    configured,
    message,
  });
}

// GET /api/media/status
// GET /admin-api/media/status
// Always returns a stable JSON contract for admin clients.
router.get('/status', optionalAdminAuth, (req, res) => {
  const path = req.originalUrl;
  const method = req.method;
  const origin = req.headers.origin || null;

  const authHeader = String(req.headers['authorization'] || '');
  const hasBearer = authHeader.toLowerCase().startsWith('bearer ');
  const cookieHeader = String(req.headers.cookie || '');
  const hasCookie = cookieHeader.includes('np_admin') || cookieHeader.includes('np_admin_token') || cookieHeader.includes('np_admin_access');
  const authAttempted = hasBearer || hasCookie;
  const authOk = !!req.admin;
  const authOutcome = authOk ? 'ok' : authAttempted ? 'invalid' : 'anonymous';

  if (shouldLog(`media.status:hit:${authOutcome}`, 60_000)) {
    // eslint-disable-next-line no-console
    console.log('[media.status] hit', { path, method, origin, authOutcome, role: req.admin?.role || null });
  }

  try {
    const st = getMediaLibraryProviderStatus();
    const configured = !!st.configured;
    const available = !!st.ready;
    const reason = available ? null : String(st.reason || 'Media upload status unavailable');

    if (shouldLog(`media.status:resp:${authOutcome}:${available ? 'yes' : 'no'}`, 60_000)) {
      // eslint-disable-next-line no-console
      console.log('[media.status] response', {
        path,
        method,
        origin,
        authOutcome,
        provider: st.provider,
        configured,
        available,
        reason,
        uploadDirectoryConfigured: st.uploadDirectoryConfigured,
        bucketConfigured: st.bucketConfigured,
        cloudinary: {
          mode: st.cloudinary?.mode || 'missing',
          missing: st.cloudinary?.missing || [],
          cloudinaryUrlValid: st.cloudinary?.cloudinaryUrlValid ?? null,
          env: st.cloudinary?.env || null,
        },
      });
    }

    return sendStableStatus(res, {
      provider: st.provider,
      available,
      reason,
      configured,
      message: available ? 'Media uploads are ready' : reason,
    });
  } catch (e) {
    if (shouldLog(`media.status:error:${authOutcome}`, 60_000)) {
      // eslint-disable-next-line no-console
      console.error('[media.status] error', {
        path,
        method,
        origin,
        authOutcome,
        message: e?.message || String(e),
        stack: e?.stack || null,
      });
    }

    return sendStableStatus(res, {
      provider: 'none',
      available: false,
      reason: 'Media upload status unavailable',
      configured: false,
      message: 'Cloudinary status unavailable',
    });
  }
});

// GET /api/media/items
// GET /admin-api/media/items
router.get('/items', requireAdminAuth, (req, res) => {
  return Promise.resolve().then(async () => {
    logLocalMediaRoute('[media.list.local]', {
      phase: 'hit',
      route: req.originalUrl,
      mediaType: req.query.mediaType || null,
      includeDeleted: String(req.query.includeDeleted || '').trim() === '1' || String(req.query.deleted || '').trim() === '1',
      adminEmail: req.admin?.email || null,
    });
    const includeDeleted = String(req.query.includeDeleted || '').trim() === '1' || String(req.query.deleted || '').trim() === '1';
    const providerStatus = getMediaLibraryProviderStatus();
    const items = await listIndexedMediaRecords({ includeDeleted, mediaType: req.query.mediaType || null, req });
    const counts = await getIndexedMediaStats();

    logLocalMediaRoute('[media.list.local]', {
      phase: 'response',
      route: req.originalUrl,
      status: 200,
      dbQueryResultCount: items.length,
      counts,
      responseShape: {
        ok: true,
        success: true,
        provider: providerStatus.provider,
        uploadConfigured: providerStatus.ready,
        reason: providerStatus.ready ? null : providerStatus.reason,
        countsKeys: Object.keys(counts),
        itemsIsArray: Array.isArray(items),
      },
    });

    return res.status(200).json({
      ok: true,
      success: true,
      provider: providerStatus.provider,
      uploadConfigured: providerStatus.ready,
      reason: providerStatus.ready ? null : providerStatus.reason,
      counts,
      items,
    });
  }).catch((e) => {
    logLocalMediaRoute('[media.list.local]', {
      phase: 'error',
      route: req.originalUrl,
      status: 500,
      dbQueryResultCount: 0,
      error: e?.message || String(e),
    });
    return res.status(500).json({ ok: false, success: false, message: e?.message || 'Failed to load media items' });
  });
});

router.get('/items/:itemId', requireAdminAuth, async (req, res) => {
  try {
    logLocalMediaRoute('[media.detail.local]', {
      phase: 'hit',
      route: req.originalUrl,
      adminEmail: req.admin?.email || null,
      itemId: req.params.itemId,
    });
    const item = await findMediaRecordByIdOrStorageId(req.params.itemId);
    if (!item) {
      logLocalMediaRoute('[media.detail.local]', {
        phase: 'error',
        route: req.originalUrl,
        status: 404,
        dbQueryResultCount: 0,
        error: 'Media record not found',
      });
      return res.status(404).json({ ok: false, success: false, message: 'Media record not found' });
    }

    const mapped = mapMediaRecord(item.toObject ? item.toObject() : item, { req });
    logLocalMediaRoute('[media.detail.local]', {
      phase: 'response',
      route: req.originalUrl,
      status: 200,
      dbQueryResultCount: 1,
      responseShape: {
        ok: true,
        success: true,
        mediaType: mapped.mediaType,
        mimeType: mapped.mimeType,
        previewAvailable: mapped.previewAvailable,
        assetUrl: mapped.assetUrl,
        previewUrl: mapped.previewUrl,
        playbackUrl: mapped.playbackUrl,
        thumbnailUrl: mapped.thumbnailUrl,
        posterUrl: mapped.posterUrl,
      },
    });
    return res.status(200).json({ ok: true, success: true, item: mapped });
  } catch (e) {
    logLocalMediaRoute('[media.detail.local]', {
      phase: 'error',
      route: req.originalUrl,
      status: 500,
      dbQueryResultCount: 0,
      error: e?.message || String(e),
    });
    return res.status(500).json({ ok: false, success: false, message: e?.message || 'Failed to load media detail' });
  }
});

router.get('/stats', requireAdminAuth, async (req, res) => {
  try {
    logLocalMediaRoute('[media.stats.local]', {
      phase: 'hit',
      route: req.originalUrl,
      adminEmail: req.admin?.email || null,
    });
    const providerStatus = getMediaLibraryProviderStatus();
    const counts = await getIndexedMediaStats();
    logLocalMediaRoute('[media.stats.local]', {
      phase: 'response',
      route: req.originalUrl,
      status: 200,
      dbQueryResultCount: counts.active,
      counts,
      responseShape: {
        ok: true,
        success: true,
        provider: providerStatus.provider,
        uploadConfigured: providerStatus.ready,
        reason: providerStatus.ready ? null : providerStatus.reason,
        countsKeys: Object.keys(counts),
      },
    });
    return res.status(200).json({ ok: true, success: true, provider: providerStatus.provider, uploadConfigured: providerStatus.ready, reason: providerStatus.ready ? null : providerStatus.reason, counts });
  } catch (e) {
    logLocalMediaRoute('[media.stats.local]', {
      phase: 'error',
      route: req.originalUrl,
      status: 500,
      dbQueryResultCount: 0,
      error: e?.message || String(e),
    });
    return res.status(500).json({ ok: false, success: false, message: e?.message || 'Failed to load media stats' });
  }
});

// POST /api/media/upload
// POST /admin-api/media/upload
router.post('/upload', requireAdminAuth, mediaUpload.any(), async (req, res) => {
  const providerStatus = getMediaLibraryProviderStatus();
  let uploaded = null;
  const localLog = {
    route: req.originalUrl,
    provider: providerStatus.provider,
    storageSuccess: false,
    dbRecordCreateSuccess: false,
    listQuerySuccess: false,
    statsQuerySuccess: false,
    createdMediaRecordId: null,
    mediaType: null,
    mimeType: null,
    status: null,
    isDeleted: null,
    source: 'admin-media-library',
  };
  try {
    logLocalMediaUpload({
      ...localLog,
      phase: 'hit',
    });
    const file = pickMediaFile(req);
    if (!file) {
      return res.status(400).json({ ok: false, success: false, message: "No file uploaded (field: file | media | image | cover)" });
    }

    assertAllowedAdminMediaMimeType(file.mimetype);

    uploaded = await uploadMediaLibraryFile(req, file);
    localLog.storageSuccess = true;
    localLog.mimeType = uploaded.mimeType || null;
    localLog.mediaType = String(uploaded.mimeType || '').startsWith('image/') ? 'image' : String(uploaded.mimeType || '').startsWith('video/') ? 'video' : null;

    const mediaRecord = await createIndexedMediaRecord(req, uploaded, { source: 'admin-media-library' });
    localLog.dbRecordCreateSuccess = true;
    const readback = await verifyIndexedMediaRecordReadable(mediaRecord.id, { source: 'admin-media-library', req });
    localLog.listQuerySuccess = !!readback.debug?.listVisible;
    localLog.statsQuerySuccess = !!readback.debug?.activeStatsVisible && !!readback.debug?.typedStatsVisible;
    localLog.createdMediaRecordId = mediaRecord.id;
    localLog.mediaType = mediaRecord.mediaType;
    localLog.mimeType = mediaRecord.mimeType;
    localLog.status = mediaRecord.status;
    localLog.isDeleted = mediaRecord.isDeleted;
    logLocalMediaUpload(localLog);

    return res.status(200).json({
      ok: true,
      success: true,
      message: 'Media uploaded and indexed in Media Library.',
      data: mediaRecord,
    });
  } catch (e) {
    if (uploaded && uploaded.id) {
      try { await deleteMediaLibraryItem(uploaded.id); } catch (_) {}
    }
    logLocalMediaUpload({
      ...localLog,
      error: e?.message || String(e),
    });
    const status = typeof e?.status === 'number' ? e.status : 500;
    return res.status(status).json({
      ok: false,
      success: false,
      status,
      code: e?.code || undefined,
      provider: getMediaLibraryProviderStatus().provider,
      reason: e?.code === 'MEDIA_UPLOAD_NOT_CONFIGURED' ? (e?.message || 'Media upload not configured') : undefined,
      message: e?.message || 'Upload failed',
    });
  }
});

router.patch('/items/:itemId/trash', requireAdminAuth, (req, res) => {
  return Promise.resolve().then(async () => {
    const providerStatus = getMediaLibraryProviderStatus();
    if (providerStatus.provider !== 'local-disk') {
      return res.status(409).json({ ok: false, success: false, provider: providerStatus.provider, reason: 'trash not supported for current media provider', message: 'Trash is only available for local media storage' });
    }
    const indexed = await markMediaDeleted(req.params.itemId, req.admin || null);
    trashLocalMediaItem(indexed.storageId || req.params.itemId);
    return res.status(200).json({ ok: true, success: true, data: indexed, message: 'Media moved to trash' });
  }).catch((e) => {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to trash media' });
  });
});

router.patch('/items/bulk/restore', requireAdminAuth, (req, res) => {
  return Promise.resolve().then(async () => {
    const ids = normalizeMediaIds(req.body?.ids);
    if (!ids.length) {
      return res.status(400).json({ ok: false, success: false, message: 'ids is required', restoredIds: [], permanentlyDeletedIds: [], skippedIds: [] });
    }

    const restoredIds = [];
    const skippedIds = [];
    for (const id of ids) {
      try {
        const restored = await restoreMediaItemById(id, req);
        restoredIds.push(restored.id || id);
      } catch (_err) {
        skippedIds.push(id);
      }
    }

    return res.status(200).json({
      ok: true,
      success: true,
      affectedCount: restoredIds.length,
      restoredIds,
      permanentlyDeletedIds: [],
      skippedIds,
      message: restoredIds.length ? 'Media restored' : 'No media restored',
    });
  }).catch((e) => {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to restore media', code: e?.code || undefined });
  });
});

router.patch('/items/:itemId/restore', requireAdminAuth, (req, res) => {
  return Promise.resolve().then(async () => {
    const indexed = await restoreMediaItemById(req.params.itemId, req);
    return res.status(200).json({
      ok: true,
      success: true,
      affectedCount: 1,
      restoredIds: [indexed.id],
      permanentlyDeletedIds: [],
      skippedIds: [],
      data: indexed,
      message: 'Media restored',
    });
  }).catch((e) => {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to restore media', reason: e?.reason || undefined, code: e?.code || undefined });
  });
});

router.delete('/items/bulk/permanent', requireAdminAuth, (req, res) => {
  return Promise.resolve().then(async () => {
    const ids = normalizeMediaIds(req.body?.ids);
    if (!ids.length) {
      return res.status(400).json({ ok: false, success: false, message: 'ids is required', restoredIds: [], permanentlyDeletedIds: [], skippedIds: [] });
    }

    const permanentlyDeletedIds = [];
    const skippedIds = [];
    for (const id of ids) {
      try {
        const deleted = await permanentlyDeleteMediaItemById(id);
        permanentlyDeletedIds.push(deleted.id || id);
      } catch (_err) {
        skippedIds.push(id);
      }
    }

    return res.status(200).json({
      ok: true,
      success: true,
      affectedCount: permanentlyDeletedIds.length,
      restoredIds: [],
      permanentlyDeletedIds,
      skippedIds,
      message: permanentlyDeletedIds.length ? 'Media permanently deleted' : 'No media permanently deleted',
    });
  }).catch((e) => {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to permanently delete media', code: e?.code || undefined });
  });
});

router.delete('/items/:itemId/permanent', requireAdminAuth, async (req, res) => {
  try {
    const deleted = await permanentlyDeleteMediaItemById(req.params.itemId);
    return res.status(200).json({
      ok: true,
      success: true,
      affectedCount: 1,
      restoredIds: [],
      permanentlyDeletedIds: [deleted.id],
      skippedIds: [],
      data: deleted,
      message: 'Media permanently deleted',
    });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to permanently delete media', code: e?.code || undefined });
  }
});

router.delete('/items/:itemId', requireAdminAuth, async (req, res) => {
  try {
    const deleted = await permanentlyDeleteMediaItemById(req.params.itemId);
    return res.status(200).json({
      ok: true,
      success: true,
      affectedCount: 1,
      restoredIds: [],
      permanentlyDeletedIds: [deleted.id],
      skippedIds: [],
      data: deleted,
      message: 'Media permanently deleted',
    });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, success: false, message: e?.message || 'Failed to permanently delete media', code: e?.code || undefined });
  }
});

module.exports = router;
