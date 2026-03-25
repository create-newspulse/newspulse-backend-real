const express = require('express');
const multer = require('multer');

const {
  isCloudinaryConfigured,
  getCloudinaryConfigStatus,
  uploadFromBuffer,
  uploadFromDataUri,
  cloudinaryPing,
} = require('../lib/cloudinary');

const { shouldLog } = require('../lib/logThrottle');

const router = express.Router();

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function pickCoverFile(req) {
  if (req.file) return req.file;

  const files = req.files;
  if (!files) return null;

  // upload.any() shape: File[]
  if (Array.isArray(files)) {
    const coverFirst = files.find(f => String(f?.fieldname || '') === 'cover');
    if (coverFirst) return coverFirst;
    const fileFallback = files.find(f => String(f?.fieldname || '') === 'file');
    if (fileFallback) return fileFallback;
    return files[0] || null;
  }

  // multer.fields() shape: { [field]: File[] }
  const coverArr = files.cover;
  if (Array.isArray(coverArr) && coverArr[0]) return coverArr[0];

  const fileArr = files.file;
  if (Array.isArray(fileArr) && fileArr[0]) return fileArr[0];

  // Fallback: pick first file present
  for (const k of Object.keys(files)) {
    const arr = files[k];
    if (Array.isArray(arr) && arr[0]) return arr[0];
  }

  return null;
}

// GET /api/uploads/config -> non-secret capability flags for frontend
router.get('/config', async (_req, res) => {
  try {
    const st = getCloudinaryConfigStatus();
    return res.status(200).json({
      ok: true,
      success: true,
      data: {
        cloudinary: {
          configured: !!st.configured,
          mode: st.mode,
          folder: String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim() || 'newspulse/articles',
        },
      },
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      success: true,
      data: {
        cloudinary: {
          configured: false,
          mode: 'missing',
          folder: String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim() || 'newspulse/articles',
        },
      },
    });
  }
});

// GET /api/uploads/ping -> Cloudinary connectivity diagnostics
router.get('/ping', async (_req, res) => {
  try {
    if (!isCloudinaryConfigured()) {
      try {
        const st = getCloudinaryConfigStatus();
        if (shouldLog('uploads.cover.cloudinary.missing', 60_000)) {
          console.warn('[uploads][cloudinary] not configured', { missing: st.missing, env: st.env });
        }
      } catch (_) {}
      return res.status(503).json({
        ok: false,
        message: 'Cloudinary not configured',
      });
    }

    const out = await cloudinaryPing();
    return res.status(200).json({ ok: true, success: true, data: out });
  } catch (err) {
    console.error('UploadCover error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Cloudinary ping failed',
      error: err?.message || String(err),
    });
  }
});

// GET /api/uploads/cover -> 405 (explicitly disallow)
router.get('/cover', (_req, res) => {
  return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
});

// POST /api/uploads/cover
router.post(
  '/cover',
  coverUpload.any(),
  async (req, res) => {
    try {
      const file = pickCoverFile(req);
      if (!file) {
        return res.status(400).json({
          ok: false,
          message: "No file received. Use multipart field 'cover' (or 'file').",
        });
      }

      if (!file.buffer || !Buffer.isBuffer(file.buffer)) {
        return res.status(400).json({
          ok: false,
          success: false,
          message: 'Invalid upload',
        });
      }

      if (!String(file.mimetype || '').toLowerCase().startsWith('image/')) {
        return res.status(400).json({
          ok: false,
          success: false,
          message: 'Invalid file type (image required)',
        });
      }

      if (!isCloudinaryConfigured()) {
        try {
          const st = getCloudinaryConfigStatus();
          if (shouldLog('uploads.cover.cloudinary.missing', 60_000)) {
            console.warn('[uploads][cover] Cloudinary not configured', { missing: st.missing, env: st.env });
          }
        } catch (_) {}
        return res.status(503).json({
          ok: false,
          message: 'Cloudinary not configured',
        });
      }

      // Primary: upload_stream via buffer (fast + avoids huge strings)
      const folder = String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim() || 'newspulse/articles';
      let result = null;
      try {
        result = await uploadFromBuffer(file.buffer, { folder });
      } catch (streamErr) {
        // Fallback: base64 data URI upload (sometimes stream errors show up in certain proxy/env combos)
        try {
          const mime = String(file.mimetype || 'application/octet-stream');
          const dataUri = `data:${mime};base64,${file.buffer.toString('base64')}`;
          result = await uploadFromDataUri(dataUri, { folder });
        } catch (dataErr) {
          // Prefer the original stream error if fallback also failed
          throw streamErr || dataErr;
        }
      }

      const url = result?.secure_url || result?.url || null;
      const publicId = result?.public_id || null;
      const width = typeof result?.width === 'number' ? result.width : null;
      const height = typeof result?.height === 'number' ? result.height : null;
      const format = result?.format ? String(result.format) : null;
      const bytes = typeof result?.bytes === 'number' ? result.bytes : null;

      return res.status(200).json({
        ok: true,
        success: true,
        data: {
          url,
          secureUrl: url,
          secure_url: url,
          publicId,
          public_id: publicId,
          width,
          height,
          format,
          bytes,
        },
      });
    } catch (err) {
      console.error('UploadCover error:', err);

      const code = err?.code;
      if (code === 'CLOUDINARY_NOT_CONFIGURED') {
        return res.status(503).json({
          ok: false,
          message: 'Cloudinary not configured',
        });
      }

      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({
        ok: false,
        success: false,
        message: status === 400 ? (err?.message || 'Bad request') : 'Upload failed',
        error: err?.message || String(err),
      });
    }
  }
);

module.exports = router;
