const axios = require('axios');

const { uploadFromBuffer, isCloudinaryConfigured } = require('../../lib/cloudinary');

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function isHttpUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeContentType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  return s.split(';')[0].trim();
}

function safePublicId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // Keep only safe characters for Cloudinary public_id segments.
  return s
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function downloadImageToBuffer(url) {
  const u = String(url || '').trim();
  if (!isHttpUrl(u)) {
    const err = new Error('imageUrl must be a valid http(s) URL');
    err.status = 400;
    throw err;
  }

  let res;
  try {
    res = await axios.get(u, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      validateStatus: (s) => s >= 200 && s < 300,
      headers: {
        // Some CDNs require a UA.
        'User-Agent': 'newspulse-backend/ads-image-ingest',
        Accept: 'image/*',
      },
    });
  } catch (e) {
    const msg = e?.code === 'ECONNABORTED'
      ? 'Timed out fetching image (10s)'
      : (e?.message || 'Failed to download image');
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }

  const contentType = normalizeContentType(res?.headers?.['content-type']);
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    const err = new Error(`Unsupported image type: ${contentType || 'unknown'}`);
    err.status = 400;
    throw err;
  }

  const buffer = Buffer.from(res.data);
  if (!buffer || buffer.length === 0) {
    const err = new Error('Downloaded image was empty');
    err.status = 400;
    throw err;
  }

  if (buffer.length > MAX_BYTES) {
    const err = new Error('Image too large (max 5MB)');
    err.status = 413;
    throw err;
  }

  return { buffer, contentType };
}

async function uploadBufferToCloudinary(buffer, _contentType, publicId) {
  if (!isCloudinaryConfigured()) {
    const err = new Error('Cloudinary is not configured');
    err.status = 500;
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }

  const folder = String(process.env.ADS_IMAGE_FOLDER || 'ads').trim() || 'ads';
  const pid = safePublicId(publicId);
  const opts = {
    folder,
    ...(pid ? { publicId: pid } : {}),
  };

  const result = await uploadFromBuffer(buffer, opts);
  const url = result?.secure_url || result?.url || null;
  if (!url) {
    const err = new Error('Cloudinary upload failed');
    err.status = 500;
    throw err;
  }
  return url;
}

async function uploadAdImageFromUrl(url, adIdOrSlug) {
  const { buffer, contentType } = await downloadImageToBuffer(url);
  const pid = adIdOrSlug ? `ad-${String(adIdOrSlug)}` : '';
  return await uploadBufferToCloudinary(buffer, contentType, pid);
}

module.exports = {
  MAX_BYTES,
  FETCH_TIMEOUT_MS,
  ALLOWED_MIME_TYPES,
  isHttpUrl,
  downloadImageToBuffer,
  uploadBufferToCloudinary,
  uploadAdImageFromUrl,
  safePublicId,
};
