const express = require('express');
const multer = require('multer');

const { isCloudinaryConfigured, uploadFromBuffer } = require('../lib/cloudinary');

const router = express.Router();

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function pickCoverFile(req) {
  if (req.file) return req.file;

  const files = req.files;
  if (!files) return null;

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

// POST /api/uploads/cover
router.post(
  '/cover',
  coverUpload.fields([
    { name: 'cover', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const file = pickCoverFile(req);
      if (!file) {
        return res.status(400).json({
          ok: false,
          message: 'No file uploaded. Use field cover',
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
        return res.status(500).json({
          ok: false,
          message: 'Cloudinary not configured',
        });
      }

      // lib/cloudinary.uploadFromBuffer() uses Cloudinary upload_stream internally.
      const folder = String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim() || 'newspulse/articles';
      const result = await uploadFromBuffer(file.buffer, { folder });
      const url = result?.secure_url || result?.url || null;
      const publicId = result?.public_id || null;
      const width = typeof result?.width === 'number' ? result.width : null;
      const height = typeof result?.height === 'number' ? result.height : null;

      return res.status(200).json({
        ok: true,
        success: true,
        data: { url, publicId, width, height },
      });
    } catch (err) {
      console.error('UploadCover error:', err);

      const code = err?.code;
      if (code === 'CLOUDINARY_NOT_CONFIGURED') {
        return res.status(500).json({
          ok: false,
          message: 'Cloudinary not configured',
        });
      }

      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({
        ok: false,
        success: false,
        message: status === 400 ? (err?.message || 'Bad request') : 'Cover upload failed',
      });
    }
  }
);

module.exports = router;
