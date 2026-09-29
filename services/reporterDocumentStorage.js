const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { v2: cloudinary } = require('cloudinary');
const cloudinaryConfig = require('../lib/cloudinary');
const { assertAllowedMimeTypeAndSignature, detectMediaSignature } = require('../lib/mediaUploadValidation');

const root = path.resolve(__dirname, '..');
const allowedTypes = ['image/png', 'image/jpeg', 'application/pdf'];
const storagePrefix = 'newspulse/private/community-reporter-ids/';
const documentUrlPrefix = '/api/community-reporter/id-documents/';

function isReporterDocumentId(fileId) {
  return typeof fileId === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:png|jpe?g|pdf)$/i.test(fileId);
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function documentDirectories() {
  const publicRoot = path.resolve(process.cwd(), 'uploads');
  const configured = String(process.env.COMMUNITY_REPORTER_UPLOAD_DIR || '').trim();
  const configuredRoot = configured ? path.resolve(root, configured) : null;
  const privateRoot = configuredRoot && !isWithin(publicRoot, configuredRoot) && !isWithin(path.join(root, 'uploads'), configuredRoot)
    ? configuredRoot : path.join(root, 'private-uploads', 'community-reporter-ids');
  const historicalRoots = String(process.env.COMMUNITY_REPORTER_LEGACY_ID_DIRS || '')
    .split(',').map(directory => directory.trim()).filter(Boolean)
    .map(directory => path.resolve(root, directory));
  const legacyRoots = [path.join(root, 'uploads', 'community-reporter-ids'), path.join(publicRoot, 'community-reporter-ids'), configuredRoot, ...historicalRoots]
    .filter(Boolean)
    .filter((directory, index, directories) => directories.findIndex(candidate => path.relative(candidate, directory) === '') === index);
  return { publicRoot, privateRoot, legacyRoots };
}

function isPublicReporterDocumentPath(requestPath) {
  const { publicRoot, legacyRoots } = documentDirectories();
  const pathname = path.posix.normalize('/' + decodeURIComponent(requestPath).replace(/\\/g, '/'));
  const requested = path.resolve(publicRoot, '.' + pathname);
  return legacyRoots.some(directory => isWithin(publicRoot, directory) && isWithin(directory, requested));
}

async function uploadReporterDocument({ buffer, mimeType }) {
  assertAllowedMimeTypeAndSignature(mimeType, buffer, allowedTypes);
  cloudinaryConfig.ensureCloudinaryConfigured();
  const fileId = crypto.randomUUID() + '.' + detectMediaSignature(buffer).extension;
  await new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({
      public_id: storagePrefix + fileId,
      resource_type: 'raw',
      type: 'authenticated',
      overwrite: false,
    }, (error, result) => {
      if (error) return reject(error);
      if (result?.public_id !== storagePrefix + fileId || result?.type !== 'authenticated' || result?.resource_type !== 'raw') {
        return reject(new Error('Invalid document storage response'));
      }
      resolve();
    });
    upload.on('error', reject);
    upload.end(buffer);
  });
  return { fileId, url: documentUrlPrefix + fileId, mime: mimeType, size: buffer.length };
}

async function getReporterDocumentAccess(fileId) {
  if (!isReporterDocumentId(fileId)) return null;
  const { privateRoot, legacyRoots } = documentDirectories();
  for (const directory of [...new Set([privateRoot, ...legacyRoots])]) {
    const filePath = path.join(directory, fileId);
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    return { stream: fs.createReadStream(filePath), filename: fileId };
  }
  cloudinaryConfig.ensureCloudinaryConfigured();
  const format = path.extname(fileId).slice(1).toLowerCase();
  const privateUrl = cloudinary.utils.private_download_url(storagePrefix + fileId, format, {
    resource_type: 'raw', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 60, secure: true,
  });
  const response = await fetch(privateUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Document storage unavailable');
  }
  return { stream: Readable.fromWeb(response.body), filename: fileId };
}

async function deleteReporterDocument(fileId) {
  if (!isReporterDocumentId(fileId)) throw new Error('Invalid document identifier');
  cloudinaryConfig.ensureCloudinaryConfigured();
  const response = await cloudinary.uploader.destroy(storagePrefix + fileId, {
    resource_type: 'raw', type: 'authenticated', invalidate: true,
  });
  if (!['ok', 'not found'].includes(response?.result)) throw new Error('Document deletion failed');
  const { privateRoot, legacyRoots } = documentDirectories();
  for (const directory of new Set([privateRoot, ...legacyRoots])) {
    const filePath = path.join(directory, fileId);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid document path');
      await fs.promises.unlink(filePath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { deleted: response.result === 'ok' };
}

module.exports = { uploadReporterDocument, getReporterDocumentAccess, deleteReporterDocument, isReporterDocumentId, isPublicReporterDocumentPath };