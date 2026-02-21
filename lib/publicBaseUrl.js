function getPublicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function absolutizeUploadsUrl(urlOrPath) {
  const s = String(urlOrPath ?? '').trim();
  if (!s) return null;

  // Already absolute.
  if (/^https?:\/\//i.test(s)) return s;

  const base = getPublicBaseUrl();
  if (!base) return s;

  if (s.startsWith('/uploads/')) return `${base}${s}`;
  if (s.startsWith('uploads/')) return `${base}/${s}`;
  return s;
}

module.exports = {
  getPublicBaseUrl,
  absolutizeUploadsUrl,
};
