const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');
const storage = require('../services/reporterDocumentStorage');

const allowedTypes = ['image/png', 'image/jpeg', 'application/pdf'];

function validateReporterDocumentReference(req, res, next) {
  const body = req.body || {};
  const hasCanonicalId = Object.hasOwn(body, 'reporterDocumentId');
  const hasLegacyId = Object.hasOwn(body, 'journalistIdFileId');
  if (!hasCanonicalId && !hasLegacyId) return next();
  if (hasCanonicalId && hasLegacyId && body.reporterDocumentId !== body.journalistIdFileId) {
    return res.status(400).json({ ok: false, code: 'CONFLICTING_REPORTER_DOCUMENT_IDS', message: 'reporterDocumentId and journalistIdFileId must match' });
  }
  const fileId = hasCanonicalId ? body.reporterDocumentId : body.journalistIdFileId;
  if (!storage.isReporterDocumentId(fileId)) {
    return res.status(400).json({ ok: false, code: 'INVALID_REPORTER_DOCUMENT_ID', message: 'Invalid reporter document identifier' });
  }
  body.reporterDocumentId = fileId;
  delete body.journalistIdFileId;
  return next();
}

function blockPrivateReporterDocuments(req, res, next) {
  try {
    if (storage.isPublicReporterDocumentPath(req.path)) {
      return res.status(404).json({ ok: false, message: 'Not found' });
    }
    return next();
  } catch (_) {
    return res.status(404).json({ ok: false, message: 'Not found' });
  }
}

function uploadReporterDocument(req, res) {
  const configuredMb = Number(process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB);
  const maxBytes = Math.floor((Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb : 5) * 1024 * 1024);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 8 },
    fileFilter: (_req, file, done) => done(allowedTypes.includes(file.mimetype) ? null : Object.assign(new Error('INVALID_FILE_TYPE'), { code: 'INVALID_FILE_TYPE' }), true),
  }).single('file');

  upload(req, res, async (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : error.code === 'INVALID_FILE_TYPE' ? 'INVALID_FILE_TYPE' : 'UPLOAD_FAILED';
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, message });
    }
    if (!req.file) return res.status(400).json({ ok: false, message: 'FILE_REQUIRED' });
    try {
      const file = req.file;
      const document = await storage.uploadReporterDocument({ buffer: file.buffer, mimeType: file.mimetype });
      return res.status(201).json({
        ok: true, ...document,
        originalName: path.basename(file.originalname).replace(/[\r\n\t]/g, ' ').slice(0, 180),
      });
    } catch (error) {
      return res.status(error.code === 'INVALID_MEDIA_SIGNATURE' ? 422 : error.status === 503 ? 503 : 500).json({ ok: false, message: error.code === 'INVALID_MEDIA_SIGNATURE' ? 'INVALID_MEDIA_SIGNATURE' : 'UPLOAD_FAILED' });
    }
  });
}

async function downloadReporterDocument(req, res) {
  try {
    const access = await storage.getReporterDocumentAccess(String(req.params.filename || ''));
    if (!access) return res.status(404).json({ ok: false, message: 'Not found' });
    res.attachment(access.filename);
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(access.stream, res);
  } catch (_) {
    if (!res.headersSent && !res.destroyed) res.status(503).json({ ok: false, message: 'Document unavailable' });
  }
}

module.exports = { blockPrivateReporterDocuments, downloadReporterDocument, uploadReporterDocument, validateReporterDocumentReference };