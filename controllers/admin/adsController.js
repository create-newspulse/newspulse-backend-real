const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const Ad = require('../../models/Ad');
const { shouldLog } = require('../../lib/logThrottle');
const { isCloudinaryConfigured } = require('../../lib/cloudinary');
const {
  ALLOWED_MIME_TYPES,
  MAX_BYTES,
  uploadAdImageFromUrl,
  uploadBufferToCloudinary,
} = require('../../src/utils/adImageUpload');
const {
  AD_SLOTS,
  normalizeSlot,
  isValidObjectId,
  validateImageUrl,
  validateTargetUrl,
  validateOptionalTargetUrl,
  parseOptionalDate,
  parseOptionalNumber,
} = require('../../lib/ads');
const { invalidateAdsCaches } = require('../../lib/cache');
const { bumpPublicConfigVersion } = require('../../services/publicConfigVersion.service');

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const _uploadsDir = path.join(process.cwd(), 'uploads');
try { fs.mkdirSync(_uploadsDir, { recursive: true }); } catch (_) {}

function _buildPublicUploadsUrl(req, filename) {
  const safeName = path.basename(String(filename || ''));
  const envBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const host = req.get('host');
  const base = envBase || `${req.protocol}://${host}`;
  return `${base}/uploads/${encodeURIComponent(safeName)}`;
}

function _isCloudinaryUrl(url) {
  return /^https?:\/\/res\.cloudinary\.com\//i.test(String(url || '').trim());
}

function _isLikelyOurHostUrl(req, url) {
  try {
    const u = new URL(String(url || '').trim());
    const envBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!envBase) return u.host === String(req.get('host') || '').trim();
    const b = new URL(envBase);
    return u.host === b.host;
  } catch {
    return false;
  }
}

function _shouldRehostImageUrl(req, imageUrl) {
  const s = String(imageUrl || '').trim();
  if (!s) return false;
  if (_isCloudinaryUrl(s)) return false;
  if (_isLikelyOurHostUrl(req, s)) return false;
  return true;
}

function _warnCloudinaryNotConfiguredOnce(reason, url) {
  const key = `ads.cloudinary.missing:${String(reason || 'unknown')}`;
  if (!shouldLog(key, 60_000)) return;
  // eslint-disable-next-line no-console
  console.warn('[ads][images] Cloudinary not configured; storing imageUrl as-is', {
    reason,
    hasCloudName: !!String(process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    hasKey: !!String(process.env.CLOUDINARY_API_KEY || '').trim(),
    hasSecret: !!String(process.env.CLOUDINARY_API_SECRET || '').trim(),
    url: String(url || '').slice(0, 300),
  });
}

function _extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  return '';
}

async function _maybeIngestImageUrl(req, imageUrl, adIdOrSlug) {
  const input = String(imageUrl || '').trim();
  if (!input) return { imageUrl: input, originalImageUrl: null };

  if (!_shouldRehostImageUrl(req, input)) {
    return { imageUrl: input, originalImageUrl: null };
  }

  if (!isCloudinaryConfigured()) {
    _warnCloudinaryNotConfiguredOnce('external-url', input);
    return { imageUrl: input, originalImageUrl: input };
  }

  const hostedUrl = await uploadAdImageFromUrl(input, adIdOrSlug);
  return { imageUrl: hostedUrl, originalImageUrl: input };
}

function toAdminAdDto(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    slot: doc.slot,
    title: doc.title || '',
    imageUrl: doc.imageUrl,
    originalImageUrl: doc.originalImageUrl || null,
    isClickable: doc.isClickable !== false,
    targetUrl: doc.targetUrl,
    isActive: !!doc.isActive,
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    createdBy: doc.createdBy || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    stats: {
      impressions: doc.stats && typeof doc.stats.impressions === 'number' ? doc.stats.impressions : 0,
      clicks: doc.stats && typeof doc.stats.clicks === 'number' ? doc.stats.clicks : 0,
    },
  };
}

function buildAdPayload(body) {
  const b = body && typeof body === 'object' ? body : {};

  const slot = normalizeSlot(b.slot);
  if (!slot) return { ok: false, status: 400, message: `slot must be one of: ${AD_SLOTS.join(', ')}` };

  const title = b.title != null ? String(b.title || '').trim() : '';

  const image = validateImageUrl(b.imageUrl);
  if (!image.ok) return { ok: false, status: 400, message: image.message };

  const targetUrlRaw = b.targetUrl;
  const targetUrlTrimmed = String(targetUrlRaw || '').trim();
  // If the client doesn't explicitly control clickability, infer it from targetUrl.
  const isClickable = typeof b.isClickable === 'boolean' ? b.isClickable : !!targetUrlTrimmed;

  const target = isClickable ? validateTargetUrl(targetUrlRaw) : validateOptionalTargetUrl(targetUrlRaw);
  if (!target.ok) return { ok: false, status: 400, message: target.message };

  const startAt = parseOptionalDate(b.startAt, 'startAt');
  if (!startAt.ok) return { ok: false, status: 400, message: startAt.message };

  const endAt = parseOptionalDate(b.endAt, 'endAt');
  if (!endAt.ok) return { ok: false, status: 400, message: endAt.message };

  if (startAt.value && endAt.value && endAt.value.getTime() < startAt.value.getTime()) {
    return { ok: false, status: 400, message: 'endAt must be greater than or equal to startAt' };
  }

  const priority = parseOptionalNumber(b.priority, 'priority');
  if (!priority.ok) return { ok: false, status: 400, message: priority.message };

  // Only allow boolean if explicitly provided
  const isActive = typeof b.isActive === 'boolean' ? b.isActive : undefined;

  return {
    ok: true,
    value: {
      slot,
      title,
      imageUrl: image.value,
      isClickable,
      targetUrl: target.value,
      ...(isActive !== undefined ? { isActive } : {}),
      ...(startAt.value !== null ? { startAt: startAt.value } : { startAt: null }),
      ...(endAt.value !== null ? { endAt: endAt.value } : { endAt: null }),
      ...(priority.value !== undefined ? { priority: priority.value } : {}),
    },
  };
}

// GET /api/admin/ads?slot=HOME_728x90
async function listAds(req, res) {
  const slotRaw = req.query && req.query.slot ? String(req.query.slot) : '';
  const slot = slotRaw ? normalizeSlot(slotRaw) : null;
  const activeOnly = String(req.query && req.query.activeOnly || '').trim();

  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  if (slotRaw && !slot) {
    return res.status(400).json({
      ok: false,
      message: `Invalid slot. Expected one of: ${AD_SLOTS.join(', ')}`,
    });
  }

  const filter = {};
  if (slot) {
    // Alias support: legacy HOME_RIGHT_RAIL is treated as HOME_RIGHT_300x250.
    // Include both so old DB records remain visible.
    if (slot === 'HOME_RIGHT_300x250') {
      filter.slot = { $in: ['HOME_RIGHT_300x250', 'HOME_RIGHT_RAIL'] };
    } else {
      filter.slot = slot;
    }
  }
  if (activeOnly === '1' || activeOnly.toLowerCase() === 'true') filter.isActive = true;

  const docs = await Ad.find(filter).sort({ updatedAt: -1 }).lean();
  return res.status(200).json({ ok: true, ads: docs.map(toAdminAdDto) });
}

// POST /api/admin/ads
// Quick manual check (ARTICLE_END):
//   curl -X POST http://localhost:5000/api/admin/ads \
//     -H "Authorization: Bearer np.<opaque-token>" \
//     -H "Content-Type: application/json" \
//     -d '{"slot":"ARTICLE_END","title":"Article End Ad","imageUrl":"https://example.com/ad.png","targetUrl":"https://example.com","isActive":true,"priority":10}'
// Note: UI labels like "Article End" / "article end" are accepted and normalized to "ARTICLE_END".
async function createAd(req, res) {
  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  const payload = buildAdPayload(req.body);
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const createdBy = (req.admin && (req.admin.email || req.admin.id)) ? String(req.admin.email || req.admin.id) : null;

  // If the admin provides an external imageUrl, re-host it to Cloudinary (when configured).
  const id = new mongoose.Types.ObjectId();
  const ingested = await _maybeIngestImageUrl(req, payload.value.imageUrl, String(id));

  const created = await Ad.create({
    _id: id,
    ...payload.value,
    imageUrl: ingested.imageUrl,
    ...(ingested.originalImageUrl ? { originalImageUrl: ingested.originalImageUrl } : {}),
    createdBy,
    stats: { impressions: 0, clicks: 0 },
  });

  bumpPublicConfigVersion().catch(() => {});
  invalidateAdsCaches(created.slot).catch(() => {});

  return res.status(201).json({ ok: true, ad: toAdminAdDto(created) });
}

// PUT /api/admin/ads/:id
async function updateAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const payload = buildAdPayload(req.body);
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  // Never allow stats overwrite via PUT
  delete payload.value.stats;

  const existing = await Ad.findById(id).lean();
  if (!existing) return res.status(404).json({ ok: false, message: 'Not found' });

  const next = { ...payload.value };
  const prevImageUrl = String(existing.imageUrl || '').trim();
  const nextImageUrl = String(next.imageUrl || '').trim();
  if (nextImageUrl && nextImageUrl !== prevImageUrl) {
    const ingested = await _maybeIngestImageUrl(req, nextImageUrl, String(id));
    next.imageUrl = ingested.imageUrl;
    if (ingested.originalImageUrl) next.originalImageUrl = ingested.originalImageUrl;
  }

  const updated = await Ad.findByIdAndUpdate(id, { $set: next }, { new: true });
  if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

  bumpPublicConfigVersion().catch(() => {});
  invalidateAdsCaches(updated.slot || existing.slot).catch(() => {});

  return res.status(200).json({ ok: true, ad: toAdminAdDto(updated) });
}

// POST /api/ads/upload-image (admin only)
// multipart/form-data: field name "file"
async function uploadAdImage(req, res) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      const mt = String(file?.mimetype || '').toLowerCase();
      if (!ALLOWED_MIME_TYPES.has(mt)) {
        const err = new Error('Invalid file type. Allowed: png, jpg, webp, gif');
        err.status = 400;
        return cb(err);
      }
      return cb(null, true);
    },
  }).single('file');

  return upload(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ hostedUrl: null, error: 'File too large (max 5MB)' });
        }
        const status = typeof err.status === 'number' ? err.status : 400;
        return res.status(status).json({ hostedUrl: null, error: err.message || 'Upload failed' });
      }

      const file = req.file;
      if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
        return res.status(400).json({ hostedUrl: null, error: "No file received. Use multipart field 'file'." });
      }

      const rand = Math.random().toString(16).slice(2, 10);
      const publicId = `ad-upload-${Date.now()}-${rand}`;

      if (isCloudinaryConfigured()) {
        const hostedUrl = await uploadBufferToCloudinary(file.buffer, file.mimetype, publicId);
        return res.status(200).json({ hostedUrl });
      }

      _warnCloudinaryNotConfiguredOnce('file-upload', file.originalname);
      const ext = _extFromMime(file.mimetype) || path.extname(String(file.originalname || '')).slice(0, 16) || '';
      const safeExt = ext && /^[a-zA-Z0-9.]+$/.test(ext) ? ext : '';
      const filename = `ad-${Date.now()}-${rand}${safeExt}`;
      const diskPath = path.join(_uploadsDir, filename);
      fs.writeFileSync(diskPath, file.buffer);

      const hostedUrl = _buildPublicUploadsUrl(req, filename);
      return res.status(200).json({ hostedUrl });
    } catch (e) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      return res.status(status).json({ hostedUrl: null, error: e?.message || 'Upload failed' });
    }
  });
}

// PATCH /api/admin/ads/:id/toggle  body optional: { isActive: true|false }
async function toggleAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const explicit = typeof body.isActive === 'boolean' ? body.isActive : null;

  const doc = await Ad.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  doc.isActive = explicit === null ? !doc.isActive : explicit;
  await doc.save();

  bumpPublicConfigVersion().catch(() => {});
  invalidateAdsCaches(doc.slot).catch(() => {});

  return res.status(200).json({ ok: true, ad: toAdminAdDto(doc) });
}

// DELETE /api/admin/ads/:id
async function deleteAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const deleted = await Ad.findByIdAndDelete(id);
  if (!deleted) return res.status(404).json({ ok: false, message: 'Not found' });

  bumpPublicConfigVersion().catch(() => {});
  invalidateAdsCaches(deleted.slot).catch(() => {});

  return res.status(200).json({ ok: true });
}

module.exports = {
  listAds,
  createAd,
  updateAd,
  uploadAdImage,
  toggleAd,
  deleteAd,
};
