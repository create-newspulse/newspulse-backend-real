function _normalizeOptionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function _isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function _extractUrl(value) {
  if (typeof value === 'string') return _normalizeOptionalString(value);
  if (_isPlainObject(value)) {
    return _normalizeOptionalString(value.url)
      || _normalizeOptionalString(value.src)
      || _normalizeOptionalString(value.secure_url);
  }
  return null;
}

function _cloneMedia(value) {
  if (_isPlainObject(value)) return { ...value };
  return value;
}

function _normalizeCoverImage(value, fallbackUrl = null) {
  if (_isPlainObject(value)) {
    return {
      ...value,
      url: _extractUrl(value) || fallbackUrl || null,
      publicId: _normalizeOptionalString(value.publicId || value.public_id) || null,
      alt: _normalizeOptionalString(value.alt) || null,
    };
  }
  if (typeof value === 'string') {
    const url = _normalizeOptionalString(value);
    return url ? { url, publicId: null, alt: null } : null;
  }
  if (fallbackUrl) return { url: fallbackUrl, publicId: null, alt: null };
  return null;
}

function shouldDebugPublicImageResolution() {
  const raw = _normalizeOptionalString(process.env.DEBUG_PUBLIC_IMAGE_RESOLUTION || process.env.PUBLIC_IMAGE_RESOLUTION_DEBUG);
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function logPublicImageResolution(scope, item, meta) {
  if (!shouldDebugPublicImageResolution()) return;
  try {
    console.log('[public-image][resolve]', {
      scope: scope || 'unknown',
      id: item && item._id ? String(item._id) : null,
      slug: item && item.slug ? String(item.slug) : null,
      title: item && item.title ? String(item.title) : null,
      resolvedCoverImageUrl: meta && meta.resolvedCoverImageUrl ? String(meta.resolvedCoverImageUrl) : null,
      rawSourceFieldUsed: meta && meta.sourceField ? String(meta.sourceField) : null,
    });
  } catch (_) {}
}

function resolvePublicImageFields(doc, options = {}) {
  const out = { ...(doc || {}) };
  out.coverImage = _cloneMedia(out.coverImage);
  out.heroImage = _cloneMedia(out.heroImage);
  out.image = _cloneMedia(out.image);

  const orderedCandidates = [
    { field: 'coverImage', value: out.coverImage },
    { field: 'coverImageUrl', value: out.coverImageUrl },
    { field: 'imageURL', value: out.imageURL },
    { field: 'heroImage', value: out.heroImage },
    { field: 'image', value: out.image },
  ];

  let sourceField = null;
  let resolvedCoverImageUrl = null;
  for (const candidate of orderedCandidates) {
    const url = _extractUrl(candidate.value);
    if (!url) continue;
    sourceField = candidate.field;
    resolvedCoverImageUrl = url;
    break;
  }

  out.imageUrl = resolvedCoverImageUrl;
  out.coverImageUrl = resolvedCoverImageUrl;
  out.coverImage = _normalizeCoverImage(out.coverImage, sourceField === 'coverImage' ? resolvedCoverImageUrl : null)
    || ((sourceField === 'coverImageUrl' || sourceField === 'imageURL') ? _normalizeCoverImage(null, resolvedCoverImageUrl) : out.coverImage)
    || null;

  const meta = {
    sourceField,
    resolvedCoverImageUrl,
  };

  if (options.debugScope) logPublicImageResolution(options.debugScope, out, meta);
  if (options.returnMeta) return { out, meta };
  return out;
}

module.exports = {
  resolvePublicImageFields,
  logPublicImageResolution,
  shouldDebugPublicImageResolution,
};