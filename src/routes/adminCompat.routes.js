const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAdminAuth } = require('../../middleware/adminAuth');

const { deleteCoverByPublicId } = require('../../lib/cloudinary');
const { deleteMediaLibraryItem, uploadMediaLibraryFile } = require('../../lib/mediaLibraryStorage');
const { assertAllowedAdminMediaMimeType } = require('../../lib/mediaUploadValidation');
const { createIndexedMediaRecord, verifyIndexedMediaRecordVisible } = require('../../services/mediaLibraryService');

const router = express.Router();

// ---- helpers (match existing response style) ----
const ok = (res, data = null, message = 'OK') =>
  res.status(200).json({ ok: true, success: true, status: 200, message, data });

const bad = (res, status, message, reqPath, data = null, code = null) =>
  res.status(status).json({ ok: false, success: false, status, ...(code ? { code } : {}), message, data, path: reqPath });

// ---- upload setup (local disk) ----
const uploadDir = path.join(process.cwd(), 'uploads');
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path
      .basename(file.originalname || 'file', ext)
      .replace(/[^a-z0-9-_]/gi, '_')
      .slice(0, 60);

    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});


// Build URLs safely behind proxies
const buildUrls = (req, filename) => {
  const base =
    process.env.PUBLIC_BASE_URL ||
    `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

  const relativeUrl = `/uploads/${filename}`;
  return { relativeUrl, url: `${String(base).replace(/\/+$/, '')}${relativeUrl}` };
};

function pickUploadedFile(req) {
  if (req.file) return req.file;

  const files = req.files;
  if (!files) return null;

  if (Array.isArray(files)) return files[0] || null;

  // multer.fields() shape: { [field]: File[] }
  for (const k of ['file', 'media', 'image', 'cover']) {
    const arr = files[k];
    if (Array.isArray(arr) && arr[0]) return arr[0];
  }

  const anyKey = Object.keys(files)[0];
  if (anyKey && Array.isArray(files[anyKey]) && files[anyKey][0]) return files[anyKey][0];

  return null;
}

// --------------------- AI SUGGEST ---------------------
// Accept any body; return safe fallback so UI works immediately.
// Later you can connect OpenAI/Gemini inside here.
router.post('/assist/suggest', async (req, res) => {
  return ok(res, { suggestions: [], version: 'v1-fallback', input: req.body || {} }, 'Suggest OK');
});

router.post('/assist/suggest/v2', async (req, res) => {
  return ok(res, { suggestions: [], version: 'v2-fallback', input: req.body || {} }, 'Suggest v2 OK');
});

// --------------------- MEDIA UPLOAD ---------------------
// supports field name: file | media | image
router.post('/media/upload', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'media', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]), async (req, res) => {
  const file = pickUploadedFile(req);
  if (!file) return bad(res, 400, 'No file uploaded (field: file)', req.originalUrl);

  let uploaded = null;
  try {
    assertAllowedAdminMediaMimeType(file.mimetype);

    uploaded = await uploadMediaLibraryFile(req, {
      ...file,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      buffer: fs.readFileSync(file.path),
    });

    try { fs.unlinkSync(file.path); } catch (_) {}

    const mediaRecord = await createIndexedMediaRecord(req, uploaded, { source: 'admin-media-library' });
    await verifyIndexedMediaRecordVisible(mediaRecord.id, { source: 'admin-media-library' });

    return ok(
      res,
      {
        ...mediaRecord,
        fullUrl: mediaRecord.url,
      },
      'Media uploaded and indexed in Media Library.'
    );
  } catch (e) {
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
    if (uploaded && uploaded.id) {
      try { await deleteMediaLibraryItem(uploaded.id); } catch (_) {}
    }
    return bad(res, e?.status || 500, e?.message || 'Media upload failed', req.originalUrl, null, e?.code || null);
  }
});

// NOTE: /api/uploads/cover is implemented in routes/uploads.routes.js

// --------------------- COVER DELETE (optional) ---------------------
// DELETE /api/uploads/cover/:publicId
// NOTE: publicId may include slashes (folder path); client should URL-encode it.
router.delete('/uploads/cover/:publicId(*)', requireAdminAuth, async (req, res) => {
  try {
    const publicId = String(req.params.publicId || '').trim();
    if (!publicId) return bad(res, 400, 'Missing publicId', req.originalUrl);

    const out = await deleteCoverByPublicId(publicId);
    return ok(res, { result: out }, 'Cover deleted');
  } catch (e) {
    console.error('[uploads.cover.delete] failed', e?.message || e);
    return bad(res, e?.status || 500, e?.message || 'Cover delete failed', req.originalUrl);
  }
});

module.exports = router;
