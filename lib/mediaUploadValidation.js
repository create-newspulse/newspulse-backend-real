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

function normalizeMimeType(mimeType) {
  return String(mimeType || '').trim().toLowerCase();
}

function buildMediaTypeNotAllowedError(message = MEDIA_TYPE_NOT_ALLOWED_MESSAGE) {
  const err = new Error(message);
  err.status = 400;
  err.code = MEDIA_TYPE_NOT_ALLOWED_CODE;
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

function assertAllowedAdminMediaMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, ADMIN_MEDIA_ACCEPTED_MIME_TYPES);
}

function assertAllowedArticleCoverMimeType(mimeType, message) {
  return assertAllowedMimeType(mimeType, ARTICLE_COVER_ACCEPTED_MIME_TYPES, message);
}

function assertAllowedLiveTvOfflinePosterMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES, 'Only JPG, JPEG, PNG, and WEBP images are allowed for Live TV offline poster uploads.');
}

function assertAllowedLiveTvOfflineVideoMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES, 'Only MP4 and WEBM videos are allowed for Live TV offline loop uploads.');
}

module.exports = {
  ADMIN_MEDIA_ACCEPTED_MIME_TYPES,
  ARTICLE_COVER_ACCEPTED_MIME_TYPES,
  LIVE_TV_OFFLINE_POSTER_ACCEPTED_MIME_TYPES,
  LIVE_TV_OFFLINE_VIDEO_ACCEPTED_MIME_TYPES,
  MEDIA_TYPE_NOT_ALLOWED_CODE,
  MEDIA_TYPE_NOT_ALLOWED_MESSAGE,
  assertAllowedAdminMediaMimeType,
  assertAllowedArticleCoverMimeType,
  assertAllowedLiveTvOfflinePosterMimeType,
  assertAllowedLiveTvOfflineVideoMimeType,
  assertAllowedMimeType,
  normalizeMimeType,
};