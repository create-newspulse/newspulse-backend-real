const { v2: cloudinary } = require('cloudinary');

let _configured = false;

function _has(s) {
  return !!String(s || '').trim();
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
  const cloudNamePresent = _has(process.env.CLOUDINARY_CLOUD_NAME);
  const apiKeyPresent = _has(process.env.CLOUDINARY_API_KEY);
  const apiSecretPresent = _has(process.env.CLOUDINARY_API_SECRET);
  const cloudinaryUrlPresent = _has(process.env.CLOUDINARY_URL);

  const hasKeys = cloudNamePresent && apiKeyPresent && apiSecretPresent;

  const urlParsed = _parseCloudinaryUrl(process.env.CLOUDINARY_URL);
  const hasUrl = !!urlParsed;
  const cloudinaryUrlValid = cloudinaryUrlPresent ? hasUrl : null;

  const missing = [];
  if (!hasKeys && !hasUrl) {
    // Report the conventional keys as missing (they are the canonical documented vars)
    if (!_has(process.env.CLOUDINARY_CLOUD_NAME)) missing.push('CLOUDINARY_CLOUD_NAME');
    if (!_has(process.env.CLOUDINARY_API_KEY)) missing.push('CLOUDINARY_API_KEY');
    if (!_has(process.env.CLOUDINARY_API_SECRET)) missing.push('CLOUDINARY_API_SECRET');
    if (!cloudinaryUrlPresent) missing.push('CLOUDINARY_URL');
    if (cloudinaryUrlPresent && !hasUrl) missing.push('CLOUDINARY_URL (invalid)');
  }

  return {
    configured: hasKeys || hasUrl,
    mode: hasKeys ? 'keys' : hasUrl ? 'url' : 'missing',
    hasUrl,
    cloudinaryUrlValid,
    missing,
    env: {
      cloudNamePresent,
      apiKeyPresent,
      apiSecretPresent,
      cloudinaryUrlPresent,
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

  if (st.mode === 'url') {
    const parsed = _parseCloudinaryUrl(process.env.CLOUDINARY_URL);
    cloudinary.config({
      cloud_name: parsed.cloudName,
      api_key: parsed.apiKey,
      api_secret: parsed.apiSecret,
      secure: true,
    });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
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
  const resourceType = String(opts.resourceType || 'image').trim() || 'image';
  const uploadOpts = {
    folder,
    resource_type: resourceType,
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
  const resourceType = String(opts.resourceType || 'image').trim() || 'image';
  const uploadOpts = {
    folder,
    resource_type: resourceType,
    overwrite: false,
  };

  return await cloudinary.uploader.upload(s, uploadOpts);
}

async function cloudinaryPing() {
  ensureCloudinaryConfigured();
  return await cloudinary.api.ping();
}

async function listResourcesByPrefix(options = {}) {
  ensureCloudinaryConfigured();

  const prefix = String(options.prefix || '').trim().replace(/^\/+|\/+$/g, '');
  const resourceType = String(options.resourceType || options.resource_type || 'image').trim() || 'image';
  const maxResults = Math.max(1, Math.min(Number(options.maxResults) || 500, 500));
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 50, 200));
  const resources = [];
  let nextCursor = options.nextCursor || null;
  let pages = 0;

  do {
    const result = await cloudinary.api.resources({
      type: 'upload',
      resource_type: resourceType,
      prefix,
      max_results: maxResults,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });
    if (Array.isArray(result?.resources)) resources.push(...result.resources);
    nextCursor = result?.next_cursor || null;
    pages += 1;
  } while (nextCursor && pages < maxPages);

  return {
    prefix,
    resourceType,
    resources,
    nextCursor,
    pages,
    truncated: !!nextCursor,
  };
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
  listResourcesByPrefix,
  deleteCoverByPublicId,
};
