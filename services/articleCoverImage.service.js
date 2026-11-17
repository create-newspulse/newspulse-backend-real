const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');

const COVER_IMAGE_FALLBACK_UNSET = Object.freeze({
  imageUrl: '', image: '', thumbnail: '', images: '', imageAlt: '', imageCaption: '',
});
const PUBLIC_COVER_IMAGE_FALLBACK_UNSET = Object.freeze({
  ...COVER_IMAGE_FALLBACK_UNSET, coverImageUrl: '', imageURL: '',
});

function normalizeCoverUrl(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text || ['null', 'undefined'].includes(text.toLowerCase())) return undefined;
  return absolutizeUploadsUrl(text);
}

function getStoredCoverImageUrl(doc) {
  const cover = doc?.coverImage;
  if (cover?.removed === true) return null;
  return normalizeCoverUrl(typeof cover === 'string' ? cover : cover?.url)
    || normalizeCoverUrl(doc?.coverImageUrl) || normalizeCoverUrl(doc?.imageURL) || null;
}

function buildCoverImagePatch(body, previous) {
  if (body.removeCoverImage !== undefined && typeof body.removeCoverImage !== 'boolean') {
    throw Object.assign(new Error('removeCoverImage must be a boolean'), { statusCode: 400 });
  }
  if (body.removeCoverImage === true) {
    return {
      coverImage: { url: null, publicId: null, alt: null, removed: true },
      coverImageUrl: null,
      imageURL: null,
    };
  }

  const input = body.coverImage && typeof body.coverImage === 'object' && !Array.isArray(body.coverImage)
    ? body.coverImage : null;
  const url = normalizeCoverUrl(typeof body.coverImage === 'string' ? body.coverImage : input?.url)
    || normalizeCoverUrl(body.coverImageUrl) || normalizeCoverUrl(body.imageURL);
  const metadataOnly = input && !Object.prototype.hasOwnProperty.call(input, 'url')
    && ['publicId', 'alt'].some(field => input[field] !== undefined);
  if (!url && !metadataOnly) return {};

  const previousCover = previous?.coverImage;
  const previousUrl = getStoredCoverImageUrl(previous);
  const coverImage = {
    url: url || previousUrl,
    publicId: url && url !== previousUrl ? null : (previousCover?.publicId || null),
    alt: previousCover?.alt || null,
    ...(!url && previousCover?.removed === true ? { removed: true } : {}),
  };
  for (const field of ['publicId', 'alt']) {
    if (input?.[field] !== undefined) coverImage[field] = input[field] ? String(input[field]) : null;
  }
  return { coverImage, coverImageUrl: coverImage.url, imageURL: coverImage.url };
}

module.exports = {
  buildCoverImagePatch,
  getStoredCoverImageUrl,
  COVER_IMAGE_FALLBACK_UNSET,
  PUBLIC_COVER_IMAGE_FALLBACK_UNSET,
};
