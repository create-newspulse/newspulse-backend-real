function safeDecodeURIComponent(value) {
  const s = String(value ?? '');
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function normalizeSlugSimple(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getSlugCandidates(value) {
  const raw = String(value ?? '').trim();

  // IMPORTANT:
  // - Never ONLY lowercase the raw value because it can contain percent-encoded
  //   bytes (e.g. %E0%A4%..) where hex casing may differ from what is stored.
  // - Include the exact raw form PLUS a lowercased variant (when different)
  //   to tolerate older inconsistent storage.
  // - Also include the decoded Unicode (lowercased) for canonical lookups.
  const decoded = safeDecodeURIComponent(raw);

  const out = [];
  if (raw) out.push(raw);

  const rawLower = raw.toLowerCase();
  if (rawLower && rawLower !== raw) out.push(rawLower);

  const decodedNorm = normalizeSlugSimple(decoded);
  if (decodedNorm && !out.includes(decodedNorm)) out.push(decodedNorm);

  return out;
}

function normalizeSupportedLang(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  return primary === 'en' || primary === 'hi' || primary === 'gu' ? primary : null;
}

function buildSlugCandidateSet(value) {
  const out = new Set();
  for (const candidate of getSlugCandidates(value)) {
    const s = String(candidate || '').trim();
    if (s) out.add(s);
  }

  const canonical = canonicalizeSlug(value);
  if (canonical) out.add(canonical);

  const decoded = safeDecodeURIComponent(value);
  if (decoded) {
    const trimmed = String(decoded).trim();
    if (trimmed) out.add(trimmed);
    const decodedCanonical = canonicalizeSlug(decoded);
    if (decodedCanonical) out.add(decodedCanonical);
  }

  return out;
}

function _setsIntersect(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function detectSlugLocale(docLike, requestedSlug) {
  const requested = buildSlugCandidateSet(requestedSlug);
  if (!requested.size) return null;

  const slugs = docLike && docLike.slugs && typeof docLike.slugs === 'object' && !Array.isArray(docLike.slugs)
    ? docLike.slugs
    : null;

  for (const lang of ['en', 'hi', 'gu']) {
    const localized = slugs && slugs[lang] ? buildSlugCandidateSet(slugs[lang]) : null;
    if (localized && localized.size && _setsIntersect(requested, localized)) return lang;
  }

  const baseSlug = buildSlugCandidateSet(docLike && docLike.slug ? docLike.slug : '');
  if (baseSlug.size && _setsIntersect(requested, baseSlug)) {
    return normalizeSupportedLang(docLike?.originalLang || docLike?.lang || docLike?.language);
  }

  return null;
}

function canonicalizeSlug(value) {
  const decoded = safeDecodeURIComponent(String(value ?? ''));
  return normalizeSlugSimple(decoded);
}

function slugifyUnicode(value, { maxLength = 120 } = {}) {
  const input = String(value ?? '').normalize('NFKC').trim();
  if (!input) return '';

  const lowered = input.toLowerCase();

  // Keep unicode letters + numbers + combining marks (important for Indic scripts).
  // Replace any run of other chars (spaces, punctuation, symbols) with a single '-'.
  let nonUrlRun;
  try {
    nonUrlRun = new RegExp('[^\\p{L}\\p{N}\\p{M}]+', 'gu');
  } catch (_) {
    // Very old Node fallback: ASCII only.
    nonUrlRun = /[^a-z0-9]+/g;
  }

  let out = lowered
    .replace(/[\u2019\u2018\u2032\u2035']/g, '')
    .replace(nonUrlRun, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (maxLength && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/g, '');
  }

  return out;
}

module.exports = {
  safeDecodeURIComponent,
  normalizeSlugSimple,
  getSlugCandidates,
  detectSlugLocale,
  canonicalizeSlug,
  slugifyUnicode,
};
