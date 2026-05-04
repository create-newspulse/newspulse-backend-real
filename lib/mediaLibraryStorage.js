const fs = require('fs');
const path = require('path');

const cloudinaryUploads = require('./cloudinary');
const { assertAllowedAdminMediaMimeType } = require('./mediaUploadValidation');

function isProductionLike() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const isRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  return env === 'production' || isRender;
}

function isTruthyEnv(name) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isLocalDiskFallbackAllowed() {
  if (isProductionLike()) return false;
  return isTruthyEnv('MEDIA_LIBRARY_ALLOW_LOCAL_DISK_FALLBACK')
    || isTruthyEnv('MEDIA_LIBRARY_UPLOAD_ALLOW_LOCAL')
    || isTruthyEnv('ALLOW_LOCAL_MEDIA_LIBRARY_UPLOADS');
}

function getMediaLibraryCloudinaryFolder() {
  const configuredFolder = process.env.CLOUDINARY_MEDIA_FOLDER || process.env.CLOUDINARY_FOLDER;
  const folder = String(configuredFolder || 'newspulse/media-library').trim();
  return folder || 'newspulse/media-library';
}

function sanitizeLogMessage(value) {
  let message = String(value || '').trim();
  for (const secret of [
    process.env.CLOUDINARY_API_SECRET,
    process.env.CLOUDINARY_API_KEY,
    process.env.CLOUDINARY_URL,
  ]) {
    const token = String(secret || '').trim();
    if (token) message = message.split(token).join('[redacted]');
  }
  return message.slice(0, 500);
}

function logMediaLibraryUpload(event, details = {}, level = 'log') {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  logger(`[media-library.upload][${event}]`, details);
}

function deriveVideoPosterUrl(uploadResult) {
  const secureUrl = String(uploadResult?.secure_url || uploadResult?.url || '').trim();
  if (!secureUrl || !/\/video\/upload\//i.test(secureUrl)) return null;

  try {
    const parsed = new URL(secureUrl);
    parsed.pathname = parsed.pathname
      .replace(/\/video\/upload\//i, '/video/upload/so_0/')
      .replace(/\.[^/.]+$/, '.jpg');
    return parsed.toString();
  } catch (_) {
    return secureUrl
      .replace(/\/video\/upload\//i, '/video/upload/so_0/')
      .replace(/\.[^/.?#]+(?=($|[?#]))/, '.jpg');
  }
}

function resolveMediaLibraryDirectories() {
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  const activeDir = path.join(uploadsRoot, 'media-library');
  const trashDir = path.join(uploadsRoot, '.trash', 'media-library');
  return { uploadsRoot, activeDir, trashDir };
}

function ensureDirectoryReady(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  return true;
}

function getLocalDiskStatus() {
  const dirs = resolveMediaLibraryDirectories();
  let directoryConfigured = false;

  try {
    directoryConfigured = ensureDirectoryReady(dirs.activeDir);
    ensureDirectoryReady(dirs.trashDir);
  } catch (_) {
    directoryConfigured = false;
  }

  return {
    provider: 'local-disk',
    ready: directoryConfigured,
    configured: directoryConfigured,
    reason: directoryConfigured ? null : 'local upload directory unavailable',
    directories: dirs,
    uploadDirectoryConfigured: directoryConfigured,
    bucketConfigured: false,
  };
}

function getMediaLibraryProviderStatus() {
  const cloudinary = cloudinaryUploads.getCloudinaryConfigStatus();
  const localDisk = getLocalDiskStatus();
  const localFallbackAllowed = isLocalDiskFallbackAllowed();

  if (cloudinary.configured) {
    return {
      provider: 'cloudinary',
      ready: true,
      configured: true,
      reason: null,
      cloudinary,
      localDisk,
      localFallbackAllowed,
      uploadDirectoryConfigured: localDisk.uploadDirectoryConfigured,
      bucketConfigured: true,
    };
  }

  if (localFallbackAllowed && localDisk.ready) {
    return {
      provider: 'local-disk',
      ready: true,
      configured: true,
      reason: null,
      cloudinary,
      localDisk,
      localFallbackAllowed,
      uploadDirectoryConfigured: localDisk.uploadDirectoryConfigured,
      bucketConfigured: false,
    };
  }

  return {
    provider: 'none',
    ready: false,
    configured: false,
    reason: cloudinary.configured ? 'media upload unavailable' : 'missing cloudinary config',
    cloudinary,
    localDisk,
    localFallbackAllowed,
    uploadDirectoryConfigured: localDisk.uploadDirectoryConfigured,
    bucketConfigured: false,
  };
}

function buildPublicUrl(req, relativeUrl) {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return `${base}${relativeUrl}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}${relativeUrl}`;
}

function sanitizeBaseName(name) {
  return String(name || 'file')
    .replace(/[^a-z0-9-_]/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'file';
}

function sanitizeStoredFileId(value) {
  return path.basename(String(value || '').trim());
}

function createStoredFilename(file) {
  const originalName = String(file && file.originalname || 'file');
  const ext = path.extname(originalName).slice(0, 16);
  const safeExt = ext && /^[a-zA-Z0-9.]+$/.test(ext) ? ext : '';
  const base = sanitizeBaseName(path.basename(originalName, ext));
  const rand = Math.random().toString(16).slice(2, 10);
  return `${Date.now()}-${rand}-${base}${safeExt}`;
}

function getLocalRelativeUrl(fileName) {
  const safeName = sanitizeStoredFileId(fileName);
  return `/uploads/media-library/${encodeURIComponent(safeName)}`;
}

function inferCloudinaryResourceType(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return 'raw';
}

function mapLocalFileToItem(req, absolutePath, deleted) {
  const stat = fs.statSync(absolutePath);
  const fileName = path.basename(absolutePath);
  const relativeUrl = deleted ? null : getLocalRelativeUrl(fileName);
  return {
    id: fileName,
    fileName,
    name: fileName,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    deleted: !!deleted,
    provider: 'local-disk',
    relativeUrl,
    url: relativeUrl ? buildPublicUrl(req, relativeUrl) : null,
  };
}

function listDirectoryItems(req, dirPath, deleted) {
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => mapLocalFileToItem(req, path.join(dirPath, entry.name), deleted))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function listMediaLibraryItems(req, options = {}) {
  const includeDeleted = Boolean(options.includeDeleted);
  const localDisk = getLocalDiskStatus();
  if (!localDisk.ready) return [];

  const activeItems = listDirectoryItems(req, localDisk.directories.activeDir, false);
  if (!includeDeleted) return activeItems;

  return activeItems.concat(listDirectoryItems(req, localDisk.directories.trashDir, true));
}

async function uploadMediaLibraryFile(req, file) {
  const status = getMediaLibraryProviderStatus();

  if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
    const err = new Error('Invalid upload');
    err.status = 400;
    err.code = 'INVALID_UPLOAD';
    throw err;
  }

  const mimeType = assertAllowedAdminMediaMimeType(file.mimetype);
  const resourceType = inferCloudinaryResourceType(mimeType);
  const uploadSize = typeof file.size === 'number' ? file.size : file.buffer.length;

  logMediaLibraryUpload('received', {
    provider: status.provider,
    fileReceived: true,
    fileName: file.originalname || null,
    mimetype: file.mimetype || null,
    mimeType,
    size: uploadSize,
  });

  if (status.provider === 'cloudinary') {
    const folder = getMediaLibraryCloudinaryFolder();
    let result = null;
    try {
      result = await cloudinaryUploads.uploadFromBuffer(file.buffer, {
        folder,
        resourceType,
      });
    } catch (e) {
      logMediaLibraryUpload('cloudinary-failure', {
        provider: 'CLOUDINARY',
        fileReceived: true,
        fileName: file.originalname || null,
        mimetype: file.mimetype || null,
        mimeType,
        size: uploadSize,
        resourceType,
        error: sanitizeLogMessage(e?.message || e),
      }, 'error');
      throw e;
    }

    const url = result && (result.secure_url || result.url) ? String(result.secure_url || result.url) : null;
    const publicId = result && result.public_id ? String(result.public_id) : null;
    if (!url) {
      const err = new Error('Cloudinary upload did not return a secure URL');
      err.status = 502;
      err.code = 'CLOUDINARY_UPLOAD_URL_MISSING';
      logMediaLibraryUpload('cloudinary-failure', {
        provider: 'CLOUDINARY',
        fileReceived: true,
        fileName: file.originalname || null,
        mimetype: file.mimetype || null,
        mimeType,
        size: uploadSize,
        resourceType,
        publicId,
        error: err.message,
      }, 'error');
      throw err;
    }

    const posterUrl = resourceType === 'video' ? deriveVideoPosterUrl(result) : null;
    logMediaLibraryUpload('cloudinary-success', {
      provider: 'CLOUDINARY',
      fileReceived: true,
      fileName: file.originalname || null,
      mimetype: file.mimetype || null,
      mimeType,
      size: typeof result?.bytes === 'number' ? result.bytes : uploadSize,
      resourceType,
      publicId,
    });

    return {
      provider: 'cloudinary',
      storageProvider: 'CLOUDINARY',
      id: publicId,
      fileName: file.originalname || publicId,
      name: file.originalname || publicId,
      url,
      assetUrl: url,
      secureUrl: url,
      videoUrl: resourceType === 'video' ? url : null,
      posterUrl,
      thumbnailUrl: resourceType === 'video' ? posterUrl : url,
      relativeUrl: null,
      mimeType,
      size: typeof result?.bytes === 'number' ? result.bytes : file.size,
      uploadedAt: new Date().toISOString(),
      deleted: false,
    };
  }

  if (status.provider === 'local-disk') {
    const localDisk = status.localDisk;
    ensureDirectoryReady(localDisk.directories.activeDir);
    const storedFileName = createStoredFilename(file);
    const absolutePath = path.join(localDisk.directories.activeDir, storedFileName);
    fs.writeFileSync(absolutePath, file.buffer);

    return {
      id: storedFileName,
      fileName: storedFileName,
      name: file.originalname || storedFileName,
      size: file.size,
      mimeType,
      provider: 'local-disk',
      storageProvider: 'LOCAL_DISK',
      deleted: false,
      relativeUrl: getLocalRelativeUrl(storedFileName),
      url: buildPublicUrl(req, getLocalRelativeUrl(storedFileName)),
      assetUrl: buildPublicUrl(req, getLocalRelativeUrl(storedFileName)),
      uploadedAt: new Date().toISOString(),
    };
  }

  const err = new Error(status.reason || 'Media upload not configured');
  err.status = 503;
  err.code = 'MEDIA_UPLOAD_NOT_CONFIGURED';
  logMediaLibraryUpload('provider-unavailable', {
    provider: status.provider,
    fileReceived: true,
    fileName: file.originalname || null,
    mimetype: file.mimetype || null,
    mimeType,
    size: uploadSize,
    cloudinaryConfigured: status.cloudinary?.configured === true,
    localFallbackAllowed: status.localFallbackAllowed === true,
    reason: err.message,
  }, 'warn');
  throw err;
}

function resolveLocalMediaPath(itemId, deleted) {
  const safeId = sanitizeStoredFileId(itemId);
  if (!safeId) return null;
  const dirs = resolveMediaLibraryDirectories();
  return path.join(deleted ? dirs.trashDir : dirs.activeDir, safeId);
}

function trashLocalMediaItem(itemId) {
  const source = resolveLocalMediaPath(itemId, false);
  const target = resolveLocalMediaPath(itemId, true);
  if (!source || !target || !fs.existsSync(source)) {
    const err = new Error('Media item not found');
    err.status = 404;
    throw err;
  }
  ensureDirectoryReady(path.dirname(target));
  fs.renameSync(source, target);
  return { id: sanitizeStoredFileId(itemId), deleted: true };
}

function restoreLocalMediaItem(itemId) {
  const source = resolveLocalMediaPath(itemId, true);
  const target = resolveLocalMediaPath(itemId, false);
  if (!source || !target || !fs.existsSync(source)) {
    const err = new Error('Media item not found in trash');
    err.status = 404;
    throw err;
  }
  ensureDirectoryReady(path.dirname(target));
  fs.renameSync(source, target);
  return { id: sanitizeStoredFileId(itemId), deleted: false };
}

async function deleteMediaLibraryItem(itemId, options = {}) {
  const status = getMediaLibraryProviderStatus();
  const provider = String(options.provider || status.provider || '').trim().toLowerCase();
  const safeId = sanitizeStoredFileId(itemId);
  if (!safeId) {
    const err = new Error('Media item id required');
    err.status = 400;
    throw err;
  }

  if (provider === 'cloudinary') {
    return cloudinaryUploads.deleteCoverByPublicId(safeId);
  }

  const activePath = resolveLocalMediaPath(safeId, false);
  const trashPath = resolveLocalMediaPath(safeId, true);
  const absolutePath = [activePath, trashPath].find((candidate) => candidate && fs.existsSync(candidate));
  if (!absolutePath) {
    const err = new Error('Media item not found');
    err.status = 404;
    throw err;
  }

  fs.unlinkSync(absolutePath);
  return { id: safeId, deleted: true, removed: true };
}

module.exports = {
  buildPublicUrl,
  deleteMediaLibraryItem,
  getLocalDiskStatus,
  getMediaLibraryCloudinaryFolder,
  getMediaLibraryProviderStatus,
  deriveVideoPosterUrl,
  isLocalDiskFallbackAllowed,
  listMediaLibraryItems,
  resolveMediaLibraryDirectories,
  restoreLocalMediaItem,
  trashLocalMediaItem,
  uploadMediaLibraryFile,
};