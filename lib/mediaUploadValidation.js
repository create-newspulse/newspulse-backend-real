const MEDIA_TYPE_NOT_ALLOWED_CODE = 'MEDIA_TYPE_NOT_ALLOWED';
const MEDIA_TYPE_NOT_ALLOWED_MESSAGE = 'Only JPG, JPEG, PNG images and MP4 videos are allowed.';

const ADMIN_MEDIA_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'video/mp4',
]);

const LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES = Object.freeze([
  'video/mp4',
  'video/webm',
]);

const ARTICLE_COVER_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ARTICLE_INLINE_IMAGE_ACCEPTED_MIME_TYPES = ARTICLE_COVER_ACCEPTED_MIME_TYPES;

const AD_IMAGE_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function normalizeMimeType(mimeType) {
  return String(mimeType || '').trim().toLowerCase();
}

function buildMediaTypeNotAllowedError(message = MEDIA_TYPE_NOT_ALLOWED_MESSAGE) {
  const err = new Error(message);
  err.status = 400;
  err.code = MEDIA_TYPE_NOT_ALLOWED_CODE;
  return err;
}

function detectMediaSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  if (buffer.length >= 6) {
    const signature = buffer.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { mimeType: 'image/gif', extension: 'gif' };
    }
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return { mimeType: 'video/mp4', extension: 'mp4' };
  }

  return null;
}

function buildInvalidMediaSignatureError(message = 'Invalid media file') {
  const err = new Error(message);
  err.status = 422;
  err.code = 'INVALID_MEDIA_SIGNATURE';
  return err;
}

function assertAllowedMimeType(mimeType, allowedMimeTypes, message) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const allowed = Array.isArray(allowedMimeTypes) ? allowedMimeTypes : [];
  if (!allowed.includes(normalizedMimeType)) {
    throw buildMediaTypeNotAllowedError(message);
  }
  return normalizedMimeType;
}

function assertAllowedMimeTypeAndSignature(mimeType, buffer, allowedMimeTypes, message) {
  const normalizedMimeType = assertAllowedMimeType(mimeType, allowedMimeTypes, message);
  const detected = detectMediaSignature(buffer);
  if (!detected || detected.mimeType !== normalizedMimeType) {
    throw buildInvalidMediaSignatureError('Uploaded file content does not match its declared media type');
  }
  return normalizedMimeType;
}

function assertAllowedAdminMediaMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, ADMIN_MEDIA_ACCEPTED_MIME_TYPES);
}

function assertAllowedAdminMediaUpload(mimeType, buffer) {
  return assertAllowedMimeTypeAndSignature(mimeType, buffer, ADMIN_MEDIA_ACCEPTED_MIME_TYPES);
}

function assertAllowedArticleCoverMimeType(mimeType, message) {
  return assertAllowedMimeType(mimeType, ARTICLE_COVER_ACCEPTED_MIME_TYPES, message);
}

function assertAllowedArticleCoverUpload(mimeType, buffer, message) {
  return assertAllowedMimeTypeAndSignature(mimeType, buffer, ARTICLE_COVER_ACCEPTED_MIME_TYPES, message);
}

function assertAllowedArticleInlineImageUpload(mimeType, buffer) {
  return assertAllowedMimeTypeAndSignature(mimeType, buffer, ARTICLE_INLINE_IMAGE_ACCEPTED_MIME_TYPES, 'Only JPG, JPEG, PNG, and WEBP inline article images are allowed.');
}

function assertAllowedAdImageUpload(mimeType, buffer) {
  return assertAllowedMimeTypeAndSignature(mimeType, buffer, AD_IMAGE_ACCEPTED_MIME_TYPES, 'Only JPG, JPEG, PNG, WEBP, and GIF images are allowed.');
}

function assertAllowedLiveTvOfflinePosterMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES, 'Only JPG, JPEG, PNG, and WEBP images are allowed for Live TV offline poster uploads.');
}

function assertAllowedLiveTvOfflineVideoMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES, 'Only MP4 and WEBM videos are allowed for Live TV offline loop uploads.');
}

module.exports = {
  AD_IMAGE_ACCEPTED_MIME_TYPES,
  ADMIN_MEDIA_ACCEPTED_MIME_TYPES,
  ARTICLE_COVER_ACCEPTED_MIME_TYPES,
  ARTICLE_INLINE_IMAGE_ACCEPTED_MIME_TYPES,
  LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES,
  LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES,
  MEDIA_TYPE_NOT_ALLOWED_CODE,
  MEDIA_TYPE_NOT_ALLOWED_MESSAGE,
  assertAllowedAdImageUpload,
  assertAllowedAdminMediaUpload,
  assertAllowedAdminMediaMimeType,
  assertAllowedArticleCoverUpload,
  assertAllowedArticleCoverMimeType,
  assertAllowedArticleInlineImageUpload,
  assertAllowedMimeTypeAndSignature,
  assertAllowedLiveTvOfflinePosterMimeType,
  assertAllowedLiveTvOfflineVideoMimeType,
  assertAllowedMimeType,
  detectMediaSignature,
  normalizeMimeType,
};