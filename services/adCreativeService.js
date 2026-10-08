const { randomUUID } = require('node:crypto');
const cloudinary = require('../lib/cloudinary');
const { normalizeSlot } = require('../lib/ads');
const { assertAllowedAdImageUpload } = require('../lib/mediaUploadValidation');
const { AD_IMAGE_SLOT_SIZES } = require('../src/constants/adSlots');
const imageUpload = require('../src/utils/adImageUpload');

const MAX_SOURCE_PIXELS = 40_000_000;
const SOURCE_FORMATS = ['jpg', 'png', 'webp', 'gif'];

function creativeError(message, status, code, warnings) {
  return Object.assign(new Error(message), { status, code, ...(warnings ? { warnings } : {}) });
}

function isSecureAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

async function prepareAdCreative({ slot: requestedSlot, buffer, contentType, imageUrl, fit = 'cover' } = {}) {
  const slot = normalizeSlot(requestedSlot);
  if (!slot) throw creativeError('Invalid ad slot', 400, 'INVALID_AD_SLOT');
  const target = AD_IMAGE_SLOT_SIZES[slot];
  if (!target) throw creativeError('This placement has no defined image dimensions', 422, 'AD_SLOT_SIZE_UNDEFINED');
  if (fit !== 'cover') throw creativeError('Only centered cover fit is supported', 400, 'INVALID_CREATIVE_FIT');
  const hasFile = Buffer.isBuffer(buffer);
  const hasUrl = typeof imageUrl === 'string' && imageUrl.trim().length > 0;
  if ((imageUrl !== undefined && typeof imageUrl !== 'string') || (hasFile === hasUrl) || (hasUrl && imageUrl.length > 4096)) {
    throw creativeError('Provide exactly one image file or HTTPS imageUrl', 400, 'INVALID_CREATIVE_SOURCE');
  }
  if (hasFile) {
    if (!buffer.length || buffer.length > imageUpload.MAX_BYTES) {
      throw creativeError('Image must be nonempty and at most 5MB', buffer.length ? 413 : 422, 'INVALID_CREATIVE_SIZE');
    }
    assertAllowedAdImageUpload(contentType, buffer);
  }
  if (!cloudinary.isCloudinaryConfigured()) {
    throw creativeError('Creative preparation requires Cloudinary', 503, 'CLOUDINARY_NOT_CONFIGURED');
  }
  const sourceInput = hasFile ? { buffer, contentType } : await imageUpload.downloadImageToBuffer(imageUrl, { httpsOnly: true });
  assertAllowedAdImageUpload(sourceInput.contentType, sourceInput.buffer);
  let source;
  try {
    const folder = String(process.env.ADS_IMAGE_FOLDER || 'ads').trim() || 'ads';
    source = await cloudinary.uploadFromBuffer(sourceInput.buffer, {
      folder: `${folder}/sources`,
      publicId: `ad-source-${randomUUID()}`,
      allowedFormats: SOURCE_FORMATS,
      timeout: 10_000,
    });
  } catch (error) {
    const invalidImage = error?.http_code === 400;
    throw creativeError(invalidImage ? 'Source image could not be decoded' : 'Image service upload failed', invalidImage ? 422 : 502, 'CREATIVE_UPLOAD_FAILED');
  }
  const sourceWidth = source?.width;
  const sourceHeight = source?.height;
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || !SOURCE_FORMATS.includes(source?.format) || !source?.public_id || !isSecureAssetUrl(source?.secure_url)) {
    throw creativeError('Image service returned invalid source metadata', 422, 'INVALID_SOURCE_IMAGE');
  }
  if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
    throw creativeError('Source image exceeds 40 megapixels', 413, 'SOURCE_IMAGE_TOO_LARGE');
  }
  if (sourceWidth < target.width || sourceHeight < target.height) {
    throw creativeError('Source resolution is too low for this placement without upscaling', 422, 'SOURCE_TOO_SMALL', [{
      code: 'LOW_SOURCE_RESOLUTION',
      message: `Use an image at least ${target.width}x${target.height}; received ${sourceWidth}x${sourceHeight}.`,
    }]);
  }
  let prepared;
  try {
    prepared = await cloudinary.generateImageDerivative(source.public_id, target);
  } catch (_) {
    throw creativeError('Image service could not generate the creative', 502, 'CREATIVE_TRANSFORM_FAILED');
  }
  if (prepared?.width !== target.width || prepared?.height !== target.height || prepared?.format !== 'png' || !isSecureAssetUrl(prepared?.secure_url) || prepared.secure_url === source.secure_url) {
    throw creativeError('Image service returned an invalid creative', 502, 'INVALID_PREPARED_CREATIVE');
  }
  return {
    hostedUrl: prepared.secure_url,
    slot,
    width: prepared.width,
    height: prepared.height,
    originalImageUrl: source.secure_url,
    sourceWidth,
    sourceHeight,
    fit,
    warnings: source.format === 'gif' || source.pages > 1
      ? [{ code: 'STATIC_CREATIVE', message: 'Prepared creative is a static PNG. The original retains its source format.' }]
      : [],
  };
}

module.exports = { prepareAdCreative };
