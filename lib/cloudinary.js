const { v2: cloudinary } = require('cloudinary');

let _configured = false;

function _has(s) {
  return !!String(s || '').trim();
}

function _readFirstEnv(keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (_has(v)) return String(v).trim();
  }
  return '';
}

function _getResolvedCloudinaryEnv() {
  // Canonical keys (preferred)
  const cloudName = _readFirstEnv([
    'CLOUDINARY_CLOUD_NAME',
    // Common variants / legacy naming
    'CLOUDINARY_CLOUDNAME',
    'CLOUDINARY_NAME',
    'CLOUD_NAME',
  ]);
  const apiKey = _readFirstEnv([
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_KEY',
    'CLOUDINARY_APIKEY',
  ]);
  const apiSecret = _readFirstEnv([
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_SECRET',
    'CLOUDINARY_APISECRET',
  ]);
  const cloudinaryUrl = _readFirstEnv(['CLOUDINARY_URL']);

  return {
    cloudName,
    apiKey,
    apiSecret,
    cloudinaryUrl,
  };
}

function _parseCloudinaryUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  try {
    const u = new URL(s);
    // Expected: cloudinary://<api_key>:<api_secret>@<cloud_name>
    if (u.protocol !== 'cloudinary:') return null;
    const cloudName = (u.hostname || '').trim();
    const apiKey = (u.username || '').trim();
    const apiSecret = (u.password || '').trim();
    if (!cloudName || !apiKey || !apiSecret) return null;
    return { cloudName, apiKey, apiSecret };
  } catch (_) {
    return null;
  }
}

function getCloudinaryConfigStatus() {
  const env = _getResolvedCloudinaryEnv();

  const hasKeys = _has(env.cloudName) && _has(env.apiKey) && _has(env.apiSecret);

  const urlParsed = _parseCloudinaryUrl(env.cloudinaryUrl);
  const hasUrlRaw = _has(env.cloudinaryUrl);
  const hasUrl = !!urlParsed;

  const missing = [];
  if (!hasKeys && !hasUrl) {
    // Report the conventional keys as missing (they are the canonical documented vars)
    if (!_has(process.env.CLOUDINARY_CLOUD_NAME) && !_has(env.cloudName)) missing.push('CLOUDINARY_CLOUD_NAME');
    if (!_has(process.env.CLOUDINARY_API_KEY) && !_has(env.apiKey)) missing.push('CLOUDINARY_API_KEY');
    if (!_has(process.env.CLOUDINARY_API_SECRET) && !_has(env.apiSecret)) missing.push('CLOUDINARY_API_SECRET');
    if (!hasUrlRaw) missing.push('CLOUDINARY_URL');
    if (hasUrlRaw && !hasUrl) missing.push('CLOUDINARY_URL (invalid)');
  }

  return {
    configured: hasKeys || hasUrl,
    mode: hasKeys ? 'keys' : hasUrl ? 'url' : 'missing',
    hasUrl,
    cloudinaryUrlValid: hasUrlRaw ? hasUrl : null,
    missing,
    // Non-secret diagnostics (safe to log/return)
    env: {
      hasCloudName: _has(env.cloudName),
      hasApiKey: _has(env.apiKey),
      hasApiSecret: _has(env.apiSecret),
      hasCloudinaryUrl: _has(env.cloudinaryUrl),
    },
  };
}

function isCloudinaryConfigured() {
  const st = getCloudinaryConfigStatus();
  return !!st.configured;
}

function ensureCloudinaryConfigured() {
  const st = getCloudinaryConfigStatus();
  if (!st.configured) {
    const err = new Error('Cloudinary is not configured');
    err.status = 503;
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }

  if (_configured) return;

  const env = _getResolvedCloudinaryEnv();

  if (st.mode === 'url') {
    const parsed = _parseCloudinaryUrl(env.cloudinaryUrl);
    cloudinary.config({
      cloud_name: parsed.cloudName,
      api_key: parsed.apiKey,
      api_secret: parsed.apiSecret,
      secure: true,
    });
  } else {
    cloudinary.config({
      cloud_name: env.cloudName,
      api_key: env.apiKey,
      api_secret: env.apiSecret,
      secure: true,
    });
  }
  _configured = true;
}

function initCloudinaryIfConfigured() {
  const st = getCloudinaryConfigStatus();
  if (!st.configured) return st;
  // This only applies local config; it does NOT contact Cloudinary.
  try {
    ensureCloudinaryConfigured();
  } catch (_) {}
  return getCloudinaryConfigStatus();
}

function defaultCoverFolder() {
  const folder = String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim();
  return folder || 'newspulse/articles';
}

async function uploadCoverImageBuffer(file, opts = {}) {
  return uploadFromBuffer(file?.buffer, opts);
}

async function uploadFromBuffer(fileBuffer, opts = {}) {
  ensureCloudinaryConfigured();

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    const err = new Error('Invalid file buffer');
    err.status = 400;
    throw err;
  }

  const folder = String(opts.folder || defaultCoverFolder()).trim();
  const uploadOpts = {
    folder,
    resource_type: 'image',
    overwrite: false,
    ...(opts.publicId ? { public_id: String(opts.publicId) } : {}),
    // Let Cloudinary pick best format/size. Frontend can request transformations.
  };

  return await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (err, result) => {
      if (err) return reject(err);
      return resolve(result);
    });

    try {
      stream.end(fileBuffer);
    } catch (e) {
      return reject(e);
    }
  });
}

async function uploadFromDataUri(dataUri, opts = {}) {
  ensureCloudinaryConfigured();

  const s = String(dataUri || '').trim();
  if (!s.startsWith('data:')) {
    const err = new Error('Invalid data URI');
    err.status = 400;
    throw err;
  }

  const folder = String(opts.folder || defaultCoverFolder()).trim();
  const uploadOpts = {
    folder,
    resource_type: 'image',
    overwrite: false,
  };

  return await cloudinary.uploader.upload(s, uploadOpts);
}

async function cloudinaryPing() {
  ensureCloudinaryConfigured();
  return await cloudinary.api.ping();
}

async function deleteCoverByPublicId(publicId) {
  ensureCloudinaryConfigured();

  const id = String(publicId || '').trim();
  if (!id) {
    const err = new Error('publicId is required');
    err.status = 400;
    throw err;
  }

  return await cloudinary.uploader.destroy(id, { resource_type: 'image', invalidate: true });
}

module.exports = {
  isCloudinaryConfigured,
  getCloudinaryConfigStatus,
  initCloudinaryIfConfigured,
  uploadFromBuffer,
  uploadFromDataUri,
  uploadCoverImageBuffer,
  cloudinaryPing,
  deleteCoverByPublicId,
};
