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
  const raw = String(value ?? '');
  const rawNorm = normalizeSlugSimple(raw);
  const decodedNorm = normalizeSlugSimple(safeDecodeURIComponent(raw));

  const out = [];
  if (rawNorm) out.push(rawNorm);
  if (decodedNorm && decodedNorm !== rawNorm) out.push(decodedNorm);
  return out;
}

function canonicalizeSlug(value) {
  const decoded = safeDecodeURIComponent(String(value ?? ''));
  return normalizeSlugSimple(decoded);
}

module.exports = {
  safeDecodeURIComponent,
  normalizeSlugSimple,
  getSlugCandidates,
  canonicalizeSlug,
};
