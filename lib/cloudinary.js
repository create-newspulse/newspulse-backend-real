const { v2: cloudinary } = require('cloudinary');

function isCloudinaryConfigured() {
  return (
    !!String(process.env.CLOUDINARY_CLOUD_NAME || '').trim() &&
    !!String(process.env.CLOUDINARY_API_KEY || '').trim() &&
    !!String(process.env.CLOUDINARY_API_SECRET || '').trim()
  );
}

function ensureCloudinaryConfigured() {
  if (!isCloudinaryConfigured()) {
    const err = new Error('Cloudinary is not configured');
    err.status = 500;
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function defaultCoverFolder() {
  const folder = String(process.env.CLOUDINARY_FOLDER || 'newspulse/articles').trim();
  return folder || 'newspulse/articles';
}

async function uploadCoverImageBuffer(file, opts = {}) {
  ensureCloudinaryConfigured();

  const folder = String(opts.folder || defaultCoverFolder()).trim();
  const uploadOpts = {
    folder,
    resource_type: 'image',
    overwrite: false,
    // Let Cloudinary pick best format/size. Frontend can request transformations.
  };

  return await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (err, result) => {
      if (err) return reject(err);
      return resolve(result);
    });

    try {
      stream.end(file.buffer);
    } catch (e) {
      return reject(e);
    }
  });
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
  uploadCoverImageBuffer,
  deleteCoverByPublicId,
};
