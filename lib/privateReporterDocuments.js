const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const multer = require('multer');
const { assertAllowedMimeTypeAndSignature, detectMediaSignature } = require('./mediaUploadValidation');

const root = path.resolve(__dirname, '..');
const allowedTypes = ['image/png', 'image/jpeg', 'application/pdf'];

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

function blockPrivateReporterDocuments(req, res, next) {
  try {
    const { publicRoot, legacyRoots } = documentDirectories();
    const pathname = path.posix.normalize('/' + decodeURIComponent(req.path).replace(/\\/g, '/'));
    const requested = path.resolve(publicRoot, '.' + pathname);
    if (legacyRoots.some(directory => isWithin(publicRoot, directory) && isWithin(directory, requested))) {
      return res.status(404).json({ ok: false, message: 'Not found' });
    }
    return next();
  } catch (_) {
    return res.status(404).json({ ok: false, message: 'Not found' });
  }
}

function uploadReporterDocument(req, res) {
  const configuredMb = Number(process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB);
  const maxBytes = Math.floor((Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb : 5) * 1024 * 1024);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 8 },
    fileFilter: (_req, file, done) => done(allowedTypes.includes(file.mimetype) ? null : Object.assign(new Error('INVALID_FILE_TYPE'), { code: 'INVALID_FILE_TYPE' }), true),
  }).single('file');

  upload(req, res, async (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : error.code === 'INVALID_FILE_TYPE' ? 'INVALID_FILE_TYPE' : 'UPLOAD_FAILED';
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, message });
    }
    if (!req.file) return res.status(400).json({ ok: false, message: 'FILE_REQUIRED' });
    try {
      const file = req.file;
      assertAllowedMimeTypeAndSignature(file.mimetype, file.buffer, allowedTypes);
      const fileId = crypto.randomUUID();
      const filename = fileId + '.' + detectMediaSignature(file.buffer).extension;
      const { privateRoot } = documentDirectories();
      await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(privateRoot, filename), file.buffer, { flag: 'wx', mode: 0o600 });
      return res.status(201).json({
        ok: true, fileId, mime: file.mimetype, size: file.size,
        originalName: path.basename(file.originalname).replace(/[\r\n\t]/g, ' ').slice(0, 180),
        url: '/api/community-reporter/id-documents/' + filename,
      });
    } catch (error) {
      return res.status(error.code === 'INVALID_MEDIA_SIGNATURE' ? 422 : 500).json({ ok: false, message: error.code === 'INVALID_MEDIA_SIGNATURE' ? 'INVALID_MEDIA_SIGNATURE' : 'UPLOAD_FAILED' });
    }
  });
}

async function downloadReporterDocument(req, res) {
  const filename = String(req.params.filename || '');
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:png|jpe?g|pdf)$/i.test(filename)) {
    return res.status(404).json({ ok: false, message: 'Not found' });
  }
  const { privateRoot, legacyRoots } = documentDirectories();
  for (const directory of [...new Set([privateRoot, ...legacyRoots])]) {
    const filePath = path.join(directory, filename);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    return res.download(filePath, filename, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ ok: false, message: 'Not found' });
    });
  }
  return res.status(404).json({ ok: false, message: 'Not found' });
}

module.exports = { blockPrivateReporterDocuments, downloadReporterDocument, uploadReporterDocument };