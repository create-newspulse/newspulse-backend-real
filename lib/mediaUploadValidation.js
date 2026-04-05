const MEDIA_TYPE_NOT_ALLOWED_CODE = 'MEDIA_TYPE_NOT_ALLOWED';
const MEDIA_TYPE_NOT_ALLOWED_MESSAGE = 'Only JPG, JPEG, PNG images and MP4 videos are allowed.';

const ADMIN_MEDIA_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'video/mp4',
]);

const ARTICLE_COVER_ACCEPTED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
]);

function normalizeMimeType(mimeType) {
  return String(mimeType || '').trim().toLowerCase();
}

function buildMediaTypeNotAllowedError() {
  const err = new Error(MEDIA_TYPE_NOT_ALLOWED_MESSAGE);
  err.status = 400;
  err.code = MEDIA_TYPE_NOT_ALLOWED_CODE;
  return err;
}

function assertAllowedMimeType(mimeType, allowedMimeTypes) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const allowed = Array.isArray(allowedMimeTypes) ? allowedMimeTypes : [];
  if (!allowed.includes(normalizedMimeType)) {
    throw buildMediaTypeNotAllowedError();
  }
  return normalizedMimeType;
}

function assertAllowedAdminMediaMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, ADMIN_MEDIA_ACCEPTED_MIME_TYPES);
}

function assertAllowedArticleCoverMimeType(mimeType) {
  return assertAllowedMimeType(mimeType, ARTICLE_COVER_ACCEPTED_MIME_TYPES);
}

module.exports = {
  ADMIN_MEDIA_ACCEPTED_MIME_TYPES,
  ARTICLE_COVER_ACCEPTED_MIME_TYPES,
  MEDIA_TYPE_NOT_ALLOWED_CODE,
  MEDIA_TYPE_NOT_ALLOWED_MESSAGE,
  assertAllowedAdminMediaMimeType,
  assertAllowedArticleCoverMimeType,
  normalizeMimeType,
};